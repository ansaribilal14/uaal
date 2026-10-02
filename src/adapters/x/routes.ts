/**
 * X routes — the DISCOVERY → DECODE → DELIVER pipeline expressed as
 * independent AccessRoutes. Provenance (which slot served) is recorded in
 * evidence and in the normalized resource.
 */
import type { AccessRoute, Evidence, ExecutionContext, RawArtifactRef, RouteResult } from "../../core/contracts.js";
import { FailureCode, type Failure } from "../../core/errors.js";
import { HttpFailure, type HttpLayer } from "../../core/http.js";
import { fetchFxTweet, fetchTweet, fetchVxTweet, tweetEvidence, type DecodeResult, type FxTweet } from "./decoders.js";
import { walkThread } from "./walkers.js";
import { reconstructThread, normalizeThread } from "./reconstruct.js";

function fail(routeId: string, failure: Failure, started: number, unavailable = false): RouteResult {
  return { ok: false, routeId, evidence: [], artifacts: [], failure, unavailable, latencyMs: Date.now() - started };
}

function decodeFailureToFailure(dec: DecodeResult, routeId: string): Failure {
  const msg = dec.message ?? "decode failed";
  if (dec.outcome === "unavailable") {
    return { code: FailureCode.INVALID_RESOURCE, message: msg, subject: routeId, retryable: false };
  }
  const all = msg.toLowerCase();
  const code = all.includes("429") ? FailureCode.RATE_LIMIT : all.includes("enotfound") || all.includes("fetch failed") || all.includes("timeout") ? FailureCode.NETWORK_FAILURE : FailureCode.PARSER_FAILURE;
  return { code, message: msg, subject: routeId, retryable: code === FailureCode.RATE_LIMIT };
}

/* --------------------------- single status metadata --------------------------- */

export function xStatusRoute(http: HttpLayer): AccessRoute {
  const id = "x.status.metadata";
  return {
    id,
    platform: "x",
    capabilities: ["metadata", "author", "media", "media_metadata", "extract"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 90,
    enabled: true,
    accessLevel: "public",
    tags: ["public-mirror"],
    description:
      "Single-status decode via public mirror APIs: FixTweet primary, vxtwitter fallback (decoder slots). 404/451 = informative filter signal; per-post provenance is recorded.",
    estimatedCostMs: 3000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const statusId = ctx.identity.id;
      const dec = await fetchTweet(http, statusId);
      if (dec.outcome !== "ok") {
        return fail(id, decodeFailureToFailure(dec, id), started, dec.outcome === "unavailable");
      }
      const evidence = tweetEvidence(dec, statusId, ctx, "status");
      return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
    }
  };
}

/* ------------------------------ thread route ------------------------------ */

export function xThreadRoute(http: HttpLayer): AccessRoute {
  const id = "x.thread.reconstruct";
  return {
    id,
    platform: "x",
    capabilities: ["thread", "reconstruct", "metadata", "extract"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 88,
    enabled: true,
    accessLevel: "public",
    tags: ["public-mirror"],
    description:
      "Full thread reconstruction: walker slots (unrollnow → threadreaderapp) produce candidates only; membership is decided by replying_to_status. Unrelated candidates are excluded and counted; degrade-to-root-only is explicit.",
    estimatedCostMs: 30_000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const statusId = ctx.identity.id;
      const evidence: Evidence[] = [];

      // Tier 1: discovery (candidates only)
      const walk = await walkThread(statusId, http, ctx.signal);
      let walkerSlot = walk.slot;
      let candidates = walk.candidates;

      // Tier 2: decode every candidate (root first), 0.6s politeness between calls
      const decoded = new Map<string, FxTweet>();
      const sources = new Map<string, string>();
      let filtered = 0;
      let decodeFailed = 0;
      let rootUnavailable = false;

      for (let i = 0; i < candidates.length; i++) {
        if (ctx.signal.aborted) break;
        if (i > 0) await new Promise((r) => setTimeout(r, 600));
        const cid = candidates[i];
        const dec = await fetchTweet(http, cid);
        if (dec.outcome === "ok" && dec.tweet) {
          const tid = String(dec.tweet.id ?? cid);
          decoded.set(tid, dec.tweet);
          sources.set(tid, dec.extractionSource ?? "unknown");
          evidence.push(tweetEvidence(dec, tid, ctx, "thread"));
        } else if (dec.outcome === "unavailable") {
          filtered += 1; // 404 = not a tweet (media id / deleted) — filter signal
        } else {
          decodeFailed += 1;
        }
        if (cid === statusId && dec.outcome === "unavailable") {
          rootUnavailable = true;
          break; // root gate: fail closed (spec xthread E_ROOT_UNAVAILABLE)
        }
      }

      if (!decoded.has(statusId)) {
        if (rootUnavailable) {
          return fail(id, { code: FailureCode.INVALID_RESOURCE, message: "root status unavailable (deleted, protected, or not a status)", subject: id, retryable: false }, started, true);
        }
        return fail(id, { code: FailureCode.PARSER_FAILURE, message: "root status could not be decoded", subject: id, retryable: true }, started);
      }

      // Tier 3: reconstruction (data relation decides membership)
      const output = reconstructThread({
        rootId: statusId,
        decoded,
        sources,
        walkerSlot,
        walkerCandidates: candidates.length,
        filtered,
        decodeFailed
      });

      const resource = normalizeThread(
        { rootId: statusId, decoded, sources, walkerSlot, walkerCandidates: candidates.length, filtered, decodeFailed },
        output,
        evidence,
        { id: statusId, canonicalUrl: ctx.identity.canonicalUrl }
      );

      const syntheticEvidence: Evidence = {
        id: `ev_${ctx.hash(`${statusId}:thread reconstructed`)}`,
        source: id,
        type: "thread.reconstruction",
        data: resource,
        retrievedAt: new Date().toISOString(),
        reliability: 0.88,
        provenance: { walkerSlot, chainLength: output.chain.length }
      };

      return {
        ok: true,
        routeId: id,
        evidence: [syntheticEvidence, ...evidence],
        artifacts: [],
        latencyMs: Date.now() - started,
        notes: output.degradedToRootOnly ? ["degraded to root only"] : undefined
      };
    }
  };
}

/* ------------------------------ media acquire ------------------------------ */

const TWIMG_SUFFIX = ".twimg.com";

export function isTwimgUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.toLowerCase().endsWith(TWIMG_SUFFIX);
  } catch {
    return false;
  }
}

export function xMediaAcquireRoute(http: HttpLayer): AccessRoute {
  const id = "x.media.acquire";
  return {
    id,
    platform: "x",
    capabilities: ["acquire", "artifact", "media"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 85,
    enabled: true,
    accessLevel: "public",
    tags: ["public-mirror"],
    description:
      "Media acquisition: decode via mirror APIs, then download only from the pbs/video/ton.twimg.com CDN allowlist (SSRF guard). Files stream into the route sandbox with byte caps and are verified before promotion. HLS-only videos are reported honestly.",
    estimatedCostMs: 45_000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const statusId = ctx.identity.id;
      const threadMode = false;

      // decode (root + thread candidates when identity has related ids)
      const targets: string[] = [statusId, ...(ctx.identity.relatedIds ?? [])];
      const decoded = new Map<string, FxTweet>();
      const evidence: Evidence[] = [];
      for (const tid of targets) {
        if (ctx.signal.aborted) break;
        const dec = await fetchTweet(http, tid);
        if (dec.outcome === "ok" && dec.tweet) {
          decoded.set(String(dec.tweet.id ?? tid), dec.tweet);
          evidence.push(tweetEvidence(dec, tid, ctx, "acquire"));
        } else if (dec.outcome === "unavailable" && tid === statusId) {
          return fail(id, { code: FailureCode.INVALID_RESOURCE, message: "root status unavailable", subject: id, retryable: false }, started, true);
        }
      }
      if (decoded.size === 0) {
        return fail(id, { code: FailureCode.PARSER_FAILURE, message: "no status could be decoded for media acquisition", subject: id, retryable: true }, started);
      }

      // collect media with the .twimg.com allowlist
      const { promises: fs } = await import("node:fs");
      const artifacts: RawArtifactRef[] = [];
      let seq = 0;
      const maxBytes = (request.output?.maxBytes as number | undefined) ?? 512 * 1024 * 1024;
      for (const [tid, tweet] of decoded) {
        for (const p of tweet.media?.photos ?? []) {
          if (!p.url || !isTwimgUrl(p.url)) continue;
          seq += 1;
          const ref = await downloadTo(ctx, http, p.url, `${tid}_p${seq}.jpg`, "image", maxBytes);
          if (ref) artifacts.push(ref);
        }
        for (const v of tweet.media?.videos ?? []) {
          seq += 1;
          const mp4 = pickMp4Url(v);
          if (!mp4) {
            ctx.log.warn("hls_only video skipped honestly", { statusId: tid });
            continue;
          }
          if (!isTwimgUrl(mp4)) continue;
          const ref = await downloadTo(ctx, http, mp4, `${tid}_v${seq}.mp4`, "video", maxBytes);
          if (ref) artifacts.push(ref);
          const poster = v.poster ?? v.posterUrl;
          if (poster && isTwimgUrl(poster)) {
            const postRef = await downloadTo(ctx, http, poster, `${tid}_v${seq}_poster.jpg`, "image", maxBytes);
            if (postRef) artifacts.push(postRef);
          }
        }
      }

      if (artifacts.length === 0) {
        const hasHlsOnly = [...decoded.values()].some((t) => (t.media?.videos ?? []).length > 0);
        return {
          ok: false,
          routeId: id,
          evidence,
          artifacts: [],
          unavailable: false,
          failure: {
            code: hasHlsOnly ? FailureCode.INVALID_ARTIFACT : FailureCode.EMPTY_RESULT,
            message: hasHlsOnly ? "media exists but only as HLS (no direct mp4 variant); not downloadable without re-encoding" : "no downloadable media found for this status",
            subject: id,
            retryable: false
          },
          latencyMs: Date.now() - started
        };
      }

      return { ok: true, routeId: id, evidence, artifacts, latencyMs: Date.now() - started };
    }
  };
}

function pickMp4Url(v: { url?: string; variants?: Array<{ url: string; container?: string; bitrate?: number }> }): string | null {
  if (v.url && /\.mp4($|\?)/.test(v.url)) return v.url;
  const mp4s = (v.variants ?? []).filter((c) => /\.mp4($|\?)/.test(c.url) || c.container === "mp4");
  mp4s.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return mp4s[0]?.url ?? null;
}

async function downloadTo(ctx: ExecutionContext, http: HttpLayer, url: string, filename: string, kind: string, maxBytes: number): Promise<RawArtifactRef | null> {
  const dest = ctx.sink.allocate(filename);
  const stream = await http.stream(url, { timeoutMs: 180_000, maxBytes }).catch((err) => {
    ctx.log.warn("media download failed", { url: url.slice(0, 120), err: (err as Error).message.slice(0, 120) });
    return null;
  });
  if (!stream || !stream.ok) {
    stream?.cancel();
    return null;
  }
  const { open } = await import("node:fs/promises");
  const fsp = await import("node:fs/promises");
  const handle = await open(dest.path, "w");
  let bytes = 0;
  try {
    const res = await stream.pipeTo(async (chunk) => {
      await handle.write(chunk);
      bytes += chunk.length;
    }, maxBytes);
    if (res.truncated) {
      ctx.log.warn("media download truncated at cap", { bytes });
      return null;
    }
    // transfer integrity: declared Content-Length must match when present
    const declared = Number(stream.headers["content-length"] ?? 0);
    if (declared > 0 && declared !== bytes) {
      ctx.log.warn("truncated transfer", { bytes, declared });
      return null;
    }
  } finally {
    await handle.close();
  }
  const stat = await fsp.stat(dest.path);
  if (stat.size === 0) return null;
  const ext = filename.split(".").pop() ?? "bin";
  const ref: RawArtifactRef = { path: dest.path, kind, filename, expectedBytes: stat.size, meta: { source: "twimg" } };
  ctx.sink.register(ref);
  return ref;
}

/* ------------------------------ thread acquire ------------------------------ */

export function xThreadAcquireRoute(http: HttpLayer): AccessRoute {
  const id = "x.thread.acquire";
  return {
    id,
    platform: "x",
    capabilities: ["acquire", "artifact"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 80,
    enabled: true,
    accessLevel: "public",
    tags: ["public-mirror"],
    description:
      "Whole-thread media acquisition: walker candidates + decoder + chain reconstruction, then CDN-allowlisted downloads for every post in the reconstructed chain. Produces a thread manifest artifact.",
    estimatedCostMs: 90_000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const statusId = ctx.identity.id;

      const walk = await walkThread(statusId, http, ctx.signal);
      const decoded = new Map<string, FxTweet>();
      const sources = new Map<string, string>();
      const evidence: Evidence[] = [];
      let filtered = 0;
      let decodeFailed = 0;
      for (const cid of walk.candidates) {
        if (ctx.signal.aborted) break;
        const dec = await fetchTweet(http, cid);
        if (dec.outcome === "ok" && dec.tweet) {
          const tid = String(dec.tweet.id ?? cid);
          decoded.set(tid, dec.tweet);
          sources.set(tid, dec.extractionSource ?? "unknown");
          evidence.push(tweetEvidence(dec, tid, ctx, "thread-acquire"));
        } else if (dec.outcome === "unavailable") filtered += 1;
        else decodeFailed += 1;
      }
      if (!decoded.has(statusId)) {
        return fail(id, { code: FailureCode.INVALID_RESOURCE, message: "root status unavailable for thread acquisition", subject: id, retryable: false }, started, true);
      }

      const output = reconstructThread({ rootId: statusId, decoded, sources, walkerSlot: walk.slot, walkerCandidates: walk.candidates.length, filtered, decodeFailed });
      if (output.chain.length === 0) {
        return fail(id, { code: FailureCode.PARSER_FAILURE, message: "thread reconstruction produced no chain", subject: id, retryable: true }, started);
      }

      // download media across the chain (same allowlisted path as single acquire)
      const artifacts: RawArtifactRef[] = [];
      const maxBytes = (request.output?.maxBytes as number | undefined) ?? 1024 * 1024 * 1024;
      let seq = 0;
      for (const tweet of output.chain) {
        if (ctx.signal.aborted) break;
        const tid = String(tweet.id);
        for (const p of tweet.media?.photos ?? []) {
          if (!p.url || !isTwimgUrl(p.url)) continue;
          seq += 1;
          const ref = await downloadTo(ctx, http, p.url, `${tid}_p${seq}.jpg`, "image", maxBytes);
          if (ref) artifacts.push(ref);
        }
        for (const v of tweet.media?.videos ?? []) {
          const mp4 = pickMp4Url(v);
          if (!mp4 || !isTwimgUrl(mp4)) continue;
          seq += 1;
          const ref = await downloadTo(ctx, http, mp4, `${tid}_v${seq}.mp4`, "video", maxBytes);
          if (ref) artifacts.push(ref);
        }
      }

      // thread manifest artifact (deterministic JSON)
      const resource = normalizeThread({ rootId: statusId, decoded, sources, walkerSlot: walk.slot, walkerCandidates: walk.candidates.length, filtered, decodeFailed }, output, evidence, { id: statusId, canonicalUrl: ctx.identity.canonicalUrl });
      const manifestPath = ctx.sink.allocate("thread_manifest.json").path;
      const { atomicWriteFile } = await import("../../core/security/paths.js");
      await atomicWriteFile(manifestPath, JSON.stringify(resource, null, 2));
      const manifestRef: RawArtifactRef = { path: manifestPath, kind: "manifest", filename: `thread_manifest_${statusId}.json`, mimeType: "application/json" };
      ctx.sink.register(manifestRef);
      artifacts.push(manifestRef);

      const synthetic: Evidence = {
        id: `ev_${ctx.hash(`${statusId}:thread-manifest`)}`,
        source: id,
        type: "thread.reconstruction",
        // Must be the FULL normalized thread resource — adapter.normalize()
        // consumes this evidence as the operation's NormalizedResource.
        // Chain/media stats ride on provenance, not data.
        data: resource,
        retrievedAt: new Date().toISOString(),
        reliability: 0.85,
        provenance: { walkerSlot: walk.slot, chainLength: output.chain.length, mediaCount: artifacts.length }
      };
      return { ok: true, routeId: id, evidence: [synthetic, ...evidence], artifacts, latencyMs: Date.now() - started };
    }
  };
}

export function xRoutes(http: HttpLayer): AccessRoute[] {
  return [xStatusRoute(http), xThreadRoute(http), xMediaAcquireRoute(http), xThreadAcquireRoute(http)];
}

/* re-exports used by the adapter */
export { fetchFxTweet, fetchVxTweet, fetchTweet };
export type { FxTweet, DecodeResult };
