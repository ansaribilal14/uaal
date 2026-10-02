/**
 * YouTube mirror acquisition routes — the ytagent method chain, ported
 * into UAAL's AccessRoute contract so the YouTube pipeline is fully
 * self-contained (no external CLI needed):
 *
 * - youtube.invidious.acquire : Invidious `local=true` proxying (itag 18).
 *   The instance fetches from googlevideo and re-serves the stream from
 *   its own IP — the known bypass for datacenter-IP blocks (ytagent tier 8).
 * - youtube.piped.acquire     : Piped instance rotation; muxed stream when
 *   available, otherwise video+audio muxed via ffmpeg (ytagent tier 7).
 * - youtube.cobalt.acquire    : optional self-hosted Cobalt sidecar
 *   (redirect / tunnel / local-processing). Enabled only when a sidecar
 *   URL is configured (adapters.youtube.cobaltUrl / UAAL_COBALT_URL).
 *
 * Every route never raises; instance rotation reports per-instance reasons.
 */
import type { AccessRoute, Evidence, ExecutionContext, RawArtifactRef, RouteResult } from "../../core/contracts.js";
import { FailureCode, type Failure } from "../../core/errors.js";
import { type HttpLayer } from "../../core/http.js";
import { canonicalWatchUrl } from "./identity.js";

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1 GiB per artifact

function fail(routeId: string, failure: Failure, started: number, unavailable = false): RouteResult {
  return { ok: false, routeId, evidence: [], artifacts: [], failure, unavailable, latencyMs: Date.now() - started };
}

/** Stream a URL into the sandbox with a content-type sanity check. */
async function streamMediaTo(ctx: ExecutionContext, http: HttpLayer, url: string, filename: string, kind: string, timeoutMs = 300_000): Promise<RawArtifactRef | null> {
  const stream = await http.stream(url, { timeoutMs, maxBytes: MAX_VIDEO_BYTES }).catch((err) => {
    ctx.log.warn("mirror stream failed", { url: url.slice(0, 100), err: (err as Error).message.slice(0, 120) });
    return null;
  });
  if (!stream || !stream.ok) {
    stream?.cancel();
    return null;
  }
  const ct = String(stream.headers["content-type"] ?? "");
  if (/text\/html|application\/json|text\/plain/.test(ct)) {
    // Error page instead of media — treat as no bytes.
    stream.cancel();
    return null;
  }
  const dest = ctx.sink.allocate(filename);
  const fsp = await import("node:fs/promises");
  const { open } = await import("node:fs/promises");
  const handle = await open(dest.path, "w");
  let bytes = 0;
  try {
    const res = await stream.pipeTo(
      async (chunk) => {
        await handle.write(chunk);
        bytes += chunk.length;
      },
      MAX_VIDEO_BYTES
    );
    if (res.truncated) return null;
    const declared = Number(stream.headers["content-length"] ?? 0);
    if (declared > 0 && declared !== bytes) {
      ctx.log.warn("mirror transfer truncated", { bytes, declared });
      return null;
    }
  } finally {
    await handle.close();
  }
  const stat = await fsp.stat(dest.path);
  if (stat.size === 0) return null;
  const ref: RawArtifactRef = { path: dest.path, kind, filename, expectedBytes: stat.size, meta: { source: "yt-mirror" } };
  ctx.sink.register(ref);
  return ref;
}

/** Mux two files with ffmpeg (video + audio → mp4). Returns true on success. */
async function muxWithFfmpeg(ctx: ExecutionContext, videoPath: string, audioPath: string, outPath: string): Promise<boolean> {
  const ffmpeg = ctx.environment.binaries["ffmpeg"];
  if (!ffmpeg) return false;
  const { safeExec } = await import("../../core/security/exec.js");
  const res = await safeExec({
    cmd: ffmpeg as string,
    args: ["-y", "-loglevel", "error", "-i", videoPath, "-i", audioPath, "-c", "copy", "-movflags", "+faststart", outPath],
    timeoutMs: 300_000,
    maxStdoutBytes: 1024 * 1024,
    signal: ctx.signal
  });
  if (res.code !== 0) {
    ctx.log.warn("ffmpeg mux failed", { code: res.code, stderr: res.stderr.slice(0, 200) });
    return false;
  }
  const fsp = await import("node:fs/promises");
  const stat = await fsp.stat(outPath).catch(() => null);
  return stat !== null && stat.size > 0;
}

/* ------------------------------ Invidious route ------------------------------ */

/** Instances known to support local=true proxying (community-maintained). */
export const INVIDIOUS_INSTANCES = ["https://invidious.f5.si", "https://yewtu.be", "https://invidious.nerdvpn.de", "https://inv.nadeko.net"];

export function youtubeInvidiousAcquireRoute(http: HttpLayer): AccessRoute {
  const id = "youtube.invidious.acquire";
  return {
    id,
    platform: "youtube",
    capabilities: ["acquire", "artifact", "media"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 64,
    enabled: true,
    accessLevel: "public",
    tags: ["public-mirror"],
    description:
      "Invidious local=true proxy acquisition (itag 18, 360p muxed MP4). The instance fetches from googlevideo with its own IP and re-serves the stream — the known workaround when YouTube blocks the local IP. Instance rotation with per-instance reasons.",
    estimatedCostMs: 60_000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const videoId = ctx.identity.id;
      const warnings: string[] = [];
      for (const base of INVIDIOUS_INSTANCES) {
        const url = `${base}/latest_version?id=${encodeURIComponent(videoId)}&itag=18&local=true`;
        const ref = await streamMediaTo(ctx, http, url, `youtube_${videoId}_${safeFrag(base)}.mp4`, "video");
        if (ref) {
          const evidence: Evidence = {
            id: `ev_${ctx.hash(`${videoId}:invidious`)}`,
            source: id,
            type: "invidious.acquire",
            data: { videoId, instance: base, itag: 18, quality: "360p", bytes: ref.expectedBytes, warnings: warnings.length ? warnings : undefined },
            retrievedAt: new Date().toISOString(),
            reliability: 0.65,
            provenance: { instance: base, mode: "local=true proxy" }
          };
          return { ok: true, routeId: id, evidence: [evidence], artifacts: [ref], latencyMs: Date.now() - started };
        }
        warnings.push(`${base}: no stream`);
      }
      return fail(id, { code: FailureCode.NETWORK_FAILURE, message: `all ${INVIDIOUS_INSTANCES.length} invidious instances failed (local=true proxy)`, subject: id, retryable: true }, started);
    }
  };
}

function safeFrag(host: string): string {
  return host.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9.-]/g, "").slice(0, 24);
}

/* ------------------------------ Piped acquire route ------------------------------ */

interface PipedStreamItem {
  url?: string;
  quality?: string;
  mimeType?: string;
  videoOnly?: boolean;
  bitrate?: number;
  contentLength?: number;
}
interface PipedStreamsResponse {
  error?: string;
  title?: string;
  uploader?: string;
  duration?: number;
  videoStreams?: PipedStreamItem[];
  audioStreams?: PipedStreamItem[];
}

export const PIPED_ACQUIRE_INSTANCES = ["https://pipedapi.kavin.rocks", "https://pipedapi.adminforge.de", "https://api.piped.private.coffee"];

export function youtubePipedAcquireRoute(http: HttpLayer): AccessRoute {
  const id = "youtube.piped.acquire";
  return {
    id,
    platform: "youtube",
    capabilities: ["acquire", "artifact", "media"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 62,
    enabled: true,
    accessLevel: "public",
    tags: ["public-mirror"],
    description:
      "Piped instance acquisition: prefers the highest-quality muxed MP4 stream; falls back to separate video+audio streams muxed with ffmpeg when ffmpeg is present. Independent mirror path alongside invidious and cobalt.",
    estimatedCostMs: 60_000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const videoId = ctx.identity.id;
      const warnings: string[] = [];

      for (const base of PIPED_ACQUIRE_INSTANCES) {
        let streams: PipedStreamsResponse;
        try {
          const res = await http.get(`${base}/streams/${videoId}`, { timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024, headers: { accept: "application/json" } });
          if (res.status >= 400) {
            warnings.push(`${base}: HTTP ${res.status}`);
            continue;
          }
          streams = JSON.parse(res.body.toString("utf8")) as PipedStreamsResponse;
        } catch (err) {
          warnings.push(`${base}: ${(err as Error).message.slice(0, 80)}`);
          continue;
        }
        if (streams.error) {
          if (/not found|does not exist|not exist/i.test(streams.error)) {
            return fail(id, { code: FailureCode.INVALID_RESOURCE, message: `piped: ${streams.error}`, subject: id, retryable: false }, started, true);
          }
          warnings.push(`${base}: ${streams.error}`);
          continue;
        }

        const videos = (streams.videoStreams ?? []).filter((v) => v.url);
        const audios = (streams.audioStreams ?? []).filter((a) => a.url);
        const muxed = videos
          .filter((v) => v.videoOnly === false && /mp4/.test(v.mimeType ?? ""))
          .sort((a, b) => (parseInt(b.quality ?? "0", 10) || 0) - (parseInt(a.quality ?? "0", 10) || 0));

        if (muxed.length > 0) {
          const ref = await streamMediaTo(ctx, http, muxed[0].url!, `youtube_${videoId}_piped.mp4`, "video");
          if (ref) {
            const evidence: Evidence = {
              id: `ev_${ctx.hash(`${videoId}:piped`)}`,
              source: id,
              type: "piped.acquire",
              data: { videoId, instance: base, quality: muxed[0].quality ?? null, bytes: ref.expectedBytes, warnings: warnings.length ? warnings : undefined },
              retrievedAt: new Date().toISOString(),
              reliability: 0.6,
              provenance: { instance: base, mode: "muxed" }
            };
            return { ok: true, routeId: id, evidence: [evidence], artifacts: [ref], latencyMs: Date.now() - started };
          }
          warnings.push(`${base}: muxed stream download failed`);
          continue;
        }

        // Separate streams — mux locally when ffmpeg exists.
        const vBest = videos.filter((v) => v.videoOnly === true && /mp4/.test(v.mimeType ?? "")).sort((a, b) => (parseInt(b.quality ?? "0", 10) || 0) - (parseInt(a.quality ?? "0", 10) || 0))[0];
        const aBest = audios.filter((a) => /mp4|m4a/.test(a.mimeType ?? "")).sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
        if (vBest?.url && aBest?.url) {
          const ffmpeg = ctx.environment.binaries["ffmpeg"];
          if (!ffmpeg) {
            warnings.push(`${base}: separate streams need ffmpeg (not installed)`);
            continue;
          }
          const vRef = await streamMediaTo(ctx, http, vBest.url, `youtube_${videoId}_piped_v.mp4`, "video");
          const aRef = vRef ? await streamMediaTo(ctx, http, aBest.url, `youtube_${videoId}_piped_a.m4a`, "audio") : null;
          if (vRef && aRef) {
            const out = ctx.sink.allocate(`youtube_${videoId}_piped.mp4`);
            const okMux = await muxWithFfmpeg(ctx, vRef.path, aRef.path, out.path);
            if (okMux) {
              const fsp = await import("node:fs/promises");
              const stat = await fsp.stat(out.path);
              const ref: RawArtifactRef = { path: out.path, kind: "video", filename: out.path.split("/").pop() ?? "video.mp4", expectedBytes: stat.size, meta: { source: "yt-mirror", muxed: true } };
              ctx.sink.register(ref);
              const evidence: Evidence = {
                id: `ev_${ctx.hash(`${videoId}:piped:mux`)}`,
                source: id,
                type: "piped.acquire",
                data: { videoId, instance: base, quality: vBest.quality ?? null, muxed: true, bytes: stat.size, warnings: warnings.length ? warnings : undefined },
                retrievedAt: new Date().toISOString(),
                reliability: 0.6,
                provenance: { instance: base, mode: "video+audio mux" }
              };
              return { ok: true, routeId: id, evidence: [evidence], artifacts: [ref], latencyMs: Date.now() - started };
            }
            warnings.push(`${base}: mux failed`);
          } else {
            warnings.push(`${base}: stream download failed`);
          }
        } else {
          warnings.push(`${base}: no usable streams`);
        }
      }
      return fail(id, { code: FailureCode.NETWORK_FAILURE, message: `all ${PIPED_ACQUIRE_INSTANCES.length} piped instances failed${warnings.length ? `: ${warnings.join(" | ").slice(0, 400)}` : ""}`, subject: id, retryable: true }, started);
    }
  };
}

/* ------------------------------ Cobalt route (optional sidecar) ------------------------------ */

interface CobaltResponse {
  status?: "redirect" | "tunnel" | "local-processing" | "error" | "picker";
  url?: string;
  tunnel?: Array<{ url?: string; type?: string } | string>;
  error?: { code?: string };
}

export function resolveCobaltUrl(config?: { adapters?: Record<string, Record<string, unknown>> }): string | undefined {
  const env = process.env.UAAL_COBALT_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const cfg = config?.adapters?.youtube?.cobaltUrl;
  if (typeof cfg === "string" && cfg.trim()) return cfg.trim().replace(/\/+$/, "");
  return undefined;
}

export function youtubeCobaltAcquireRoute(http: HttpLayer, cobaltUrl: string): AccessRoute {
  const id = "youtube.cobalt.acquire";
  return {
    id,
    platform: "youtube",
    capabilities: ["acquire", "artifact", "media"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 70,
    enabled: true,
    accessLevel: "public",
    tags: ["sidecar"],
    description: `Cobalt sidecar acquisition (${cobaltUrl}). Handles redirect, tunnel and local-processing responses; muxes video+audio tunnels with ffmpeg when needed. Configured explicitly by the operator.`,
    estimatedCostMs: 45_000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const videoId = ctx.identity.id;
      let res;
      try {
        res = await http.postJson(
          cobaltUrl,
          { url: canonicalWatchUrl(videoId), videoQuality: "1080", youtubeVideoCodec: "h264", youtubeVideoContainer: "mp4", downloadMode: "auto" },
          { timeoutMs: 30_000, maxBytes: 1024 * 1024 }
        );
      } catch (err) {
        const msg = (err as Error).message.slice(0, 160);
        // Connection refused / unreachable sidecar is an environment gap, not a platform wall.
        return fail(id, { code: FailureCode.ENVIRONMENT_INCOMPATIBLE, message: `cobalt sidecar not reachable at ${cobaltUrl} (${msg})`, subject: id, retryable: false }, started);
      }
      if (res.status >= 400) {
        return fail(id, { code: res.status === 429 ? FailureCode.RATE_LIMIT : FailureCode.HTTP_ERROR, message: `cobalt: HTTP ${res.status}`, subject: id, retryable: res.status === 429 || res.status >= 500 }, started);
      }
      let data: CobaltResponse;
      try {
        data = JSON.parse(res.body.toString("utf8")) as CobaltResponse;
      } catch {
        return fail(id, { code: FailureCode.PARSER_FAILURE, message: "cobalt: non-JSON response", subject: id, retryable: true }, started);
      }
      if (data.status === "error") {
        return fail(id, { code: FailureCode.HTTP_ERROR, message: `cobalt: error response (${data.error?.code ?? "unknown"})`, subject: id, retryable: false }, started);
      }

      const collectTunnels = (): Array<{ url: string; type: string }> => {
        const arr = data.tunnel ?? [];
        const list = Array.isArray(arr) ? arr : [arr];
        return list
          .map((t) => (typeof t === "string" ? { url: t, type: "" } : { url: t.url ?? "", type: t.type ?? "" }))
          .filter((t) => t.url.startsWith("http"));
      };

      // redirect: single URL → stream it.
      if (data.status === "redirect" && data.url) {
        const ref = await streamMediaTo(ctx, http, data.url, `youtube_${videoId}_cobalt.mp4`, "video");
        if (ref) {
          const evidence: Evidence = { id: `ev_${ctx.hash(`${videoId}:cobalt`)}`, source: id, type: "cobalt.acquire", data: { videoId, mode: "redirect", bytes: ref.expectedBytes }, retrievedAt: new Date().toISOString(), reliability: 0.8, provenance: { sidecar: cobaltUrl, mode: "redirect" } };
          return { ok: true, routeId: id, evidence: [evidence], artifacts: [ref], latencyMs: Date.now() - started };
        }
        return fail(id, { code: FailureCode.NETWORK_FAILURE, message: "cobalt redirect stream produced no usable bytes", subject: id, retryable: true }, started);
      }

      // tunnel / local-processing: 1 tunnel = muxed stream; 2+ = mux locally.
      if (data.status === "tunnel" || data.status === "local-processing") {
        const tunnels = collectTunnels();
        if (tunnels.length === 0) {
          return fail(id, { code: FailureCode.PARSER_FAILURE, message: `cobalt: ${data.status} without tunnel URLs`, subject: id, retryable: true }, started);
        }
        if (tunnels.length === 1) {
          const ref = await streamMediaTo(ctx, http, tunnels[0].url, `youtube_${videoId}_cobalt.mp4`, "video");
          if (ref) {
            const evidence: Evidence = { id: `ev_${ctx.hash(`${videoId}:cobalt`)}`, source: id, type: "cobalt.acquire", data: { videoId, mode: data.status, bytes: ref.expectedBytes }, retrievedAt: new Date().toISOString(), reliability: 0.8, provenance: { sidecar: cobaltUrl, mode: data.status } };
            return { ok: true, routeId: id, evidence: [evidence], artifacts: [ref], latencyMs: Date.now() - started };
          }
          return fail(id, { code: FailureCode.NETWORK_FAILURE, message: "cobalt tunnel stream produced no usable bytes", subject: id, retryable: true }, started);
        }
        const ffmpeg = ctx.environment.binaries["ffmpeg"];
        if (!ffmpeg) {
          return fail(id, { code: FailureCode.ENVIRONMENT_INCOMPATIBLE, message: "cobalt returned separate video+audio tunnels; ffmpeg is required to mux but not installed", subject: id, retryable: false }, started);
        }
        const vT = tunnels.find((t) => /video/i.test(t.type)) ?? tunnels[0];
        const aT = tunnels.find((t) => t !== vT && /audio/i.test(t.type)) ?? tunnels.find((t) => t !== vT)!;
        const vRef = await streamMediaTo(ctx, http, vT.url, `youtube_${videoId}_cobalt_v.mp4`, "video");
        const aRef = vRef ? await streamMediaTo(ctx, http, aT.url, `youtube_${videoId}_cobalt_a.m4a`, "audio") : null;
        if (!vRef || !aRef) {
          return fail(id, { code: FailureCode.NETWORK_FAILURE, message: "cobalt tunnel download incomplete", subject: id, retryable: true }, started);
        }
        const out = ctx.sink.allocate(`youtube_${videoId}_cobalt.mp4`);
        const okMux = await muxWithFfmpeg(ctx, vRef.path, aRef.path, out.path);
        if (!okMux) {
          return fail(id, { code: FailureCode.DEPENDENCY_FAILURE, message: "ffmpeg mux of cobalt tunnels failed", subject: id, retryable: true }, started);
        }
        const fsp = await import("node:fs/promises");
        const stat = await fsp.stat(out.path);
        const ref: RawArtifactRef = { path: out.path, kind: "video", filename: out.path.split("/").pop() ?? "video.mp4", expectedBytes: stat.size, meta: { source: "yt-mirror", muxed: true } };
        ctx.sink.register(ref);
        const evidence: Evidence = { id: `ev_${ctx.hash(`${videoId}:cobalt`)}`, source: id, type: "cobalt.acquire", data: { videoId, mode: `${data.status}+mux`, bytes: stat.size }, retrievedAt: new Date().toISOString(), reliability: 0.8, provenance: { sidecar: cobaltUrl, mode: `${data.status}+mux` } };
        return { ok: true, routeId: id, evidence: [evidence], artifacts: [ref], latencyMs: Date.now() - started };
      }

      return fail(id, { code: FailureCode.PARSER_FAILURE, message: `cobalt: unsupported status ${String(data.status)}`, subject: id, retryable: true }, started);
    }
  };
}
