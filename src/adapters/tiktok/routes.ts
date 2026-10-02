/**
 * TikTok routes — three independent, structurally different access paths:
 *
 * 1. tiktok.oembed.metadata   — official oEmbed endpoint (metadata + thumb)
 * 2. tiktok.tikwm.metadata    — public mirror API (rich metadata, no auth)
 * 3. tiktok.tikwm.acquire     — mirror-mediated media acquisition
 *                               (no-watermark video / slideshow photos)
 *
 * Every route never raises (ytagent boundary) and reports honest failures.
 */
import type { AccessRoute, Evidence, ExecutionContext, ProbeResult, RawArtifactRef, ResourceRequest, RouteResult } from "../../core/contracts.js";
import { FailureCode, type Failure } from "../../core/errors.js";
import { getJson, HttpFailure, type HttpLayer } from "../../core/http.js";
import { canonicalTikTokUrl, parseTikTokUrl } from "./identity.js";
import { absolutizeTikwm, fetchTikwm, type TikwmData } from "../lib/tikwm.js";
import { downloadTo, safeIdFragment } from "../lib/media.js";

const ROUTE_TIMEOUT = 30_000;
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

function fail(routeId: string, failure: Failure, started: number, unavailable = false): RouteResult {
  return { ok: false, routeId, evidence: [], artifacts: [], failure, unavailable, latencyMs: Date.now() - started };
}

/* ------------------------------ oEmbed route ------------------------------ */

interface TikTokOEmbed {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
  embed_product_id?: string;
}

export function tiktokOembedRoute(http: HttpLayer): AccessRoute {
  const id = "tiktok.oembed.metadata";
  return {
    id,
    platform: "tiktok",
    capabilities: ["metadata", "author", "inspect"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 90,
    enabled: true,
    accessLevel: "public",
    tags: ["official"],
    description:
      "TikTok official oEmbed endpoint (no auth). Stable metadata: caption/title, author handle, thumbnail. 404 means the post is genuinely gone — an informative filter, not a retry case.",
    estimatedCostMs: 2000,
    async execute(request: ResourceRequest, ctx: ExecutionContext): Promise<RouteResult> {
      const started = Date.now();
      const itemId = ctx.identity.id;
      const target = itemId.startsWith("short:") ? ctx.identity.canonicalUrl : canonicalTikTokUrl(itemId);
      const url = `https://www.tiktok.com/oembed?url=${encodeURIComponent(target)}`;
      try {
        const { data, res } = await getJson<TikTokOEmbed>(http, url, { timeoutMs: ROUTE_TIMEOUT, maxBytes: 256 * 1024 });
        if (!data.title && !data.thumbnail_url) {
          return fail(id, { code: FailureCode.EMPTY_RESULT, message: "oEmbed returned no usable fields", subject: id, retryable: true }, started);
        }
        const evidence: Evidence = {
          id: `ev_${ctx.hash(`${itemId}:tiktok:oembed`)}`,
          source: id,
          type: "tiktok.oembed",
          data: { ...data, itemId },
          retrievedAt: new Date().toISOString(),
          reliability: 0.9,
          provenance: { endpoint: "tiktok.com/oembed", status: res.status }
        };
        return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
      } catch (err) {
        if (err instanceof HttpFailure && (err.status === 401 || err.status === 404)) {
          return fail(id, { code: FailureCode.INVALID_RESOURCE, message: "post unavailable per oEmbed (401/404)", subject: id, retryable: false }, started, true);
        }
        if (err instanceof HttpFailure) {
          return fail(id, err.toFailure(id), started);
        }
        return fail(id, { code: FailureCode.NETWORK_FAILURE, message: (err as Error).message.slice(0, 160), subject: id, retryable: true }, started);
      }
    }
  };
}

/* ------------------------------ mirror metadata route ------------------------------ */

export function tikwmMetadataFrom(data: TikwmData): { title?: string; authorHandle?: string; authorName?: string; durationSec?: number; metrics: Record<string, number | null> } {
  return {
    title: data.title || undefined,
    authorHandle: data.author?.unique_id || undefined,
    authorName: data.author?.nickname || undefined,
    durationSec: typeof data.duration === "number" ? data.duration : undefined,
    metrics: {
      plays: typeof data.play_count === "number" ? data.play_count : null,
      likes: typeof data.digg_count === "number" ? data.digg_count : null,
      comments: typeof data.comment_count === "number" ? data.comment_count : null,
      shares: typeof data.share_count === "number" ? data.share_count : null
    }
  };
}

export function tiktokTikwmMetadataRoute(http: HttpLayer): AccessRoute {
  const id = "tiktok.tikwm.metadata";
  return {
    id,
    platform: "tiktok",
    capabilities: ["metadata", "author", "media", "media_metadata", "extract"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 85,
    enabled: true,
    accessLevel: "public",
    tags: ["public-mirror"],
    description:
      "tikwm.com public mirror API. Rich metadata: caption, author, duration, engagement counts, full media inventory (video URLs, slideshow images, music). Independent of TikTok's own servers.",
    estimatedCostMs: 3500,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const itemId = ctx.identity.id;
      const shareUrl = itemId.startsWith("short:") ? ctx.identity.canonicalUrl : canonicalTikTokUrl(itemId);
      const call = await fetchTikwm(http, shareUrl, id);
      if (!call.ok || !call.data) {
        const f = call.failure ?? { code: FailureCode.INTERNAL_ERROR, message: "tikwm: unknown failure", subject: id, retryable: true };
        return fail(id, f, started, f.code === FailureCode.INVALID_RESOURCE);
      }
      const evidence: Evidence = {
        id: `ev_${ctx.hash(`${itemId}:tikwm`)}`,
        source: id,
        type: "tikwm.api",
        data: { ...call.raw, itemId },
        retrievedAt: new Date().toISOString(),
        reliability: 0.75,
        provenance: { endpoint: "tikwm.com/api", mirror: "tikwm.com" }
      };
      return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
    }
  };
}

/* ------------------------------ mirror acquire route ------------------------------ */

export function pickTikwmMedia(data: TikwmData): { videos: string[]; photos: string[]; cover?: string } {
  const videos: string[] = [];
  const photos: string[] = [];
  const hd = absolutizeTikwm(data.hdplay);
  const play = absolutizeTikwm(data.play);
  const wm = absolutizeTikwm(data.wmplay);
  if (hd) videos.push(hd);
  if (play && play !== hd) videos.push(play);
  if (wm && wm !== play && wm !== hd) videos.push(wm);
  for (const img of data.images ?? []) {
    const u = absolutizeTikwm(img);
    if (u) photos.push(u);
  }
  return { videos, photos, cover: absolutizeTikwm(data.origin_cover ?? data.cover) };
}

export function tiktokTikwmAcquireRoute(http: HttpLayer): AccessRoute {
  const id = "tiktok.tikwm.acquire";
  return {
    id,
    platform: "tiktok",
    capabilities: ["acquire", "artifact", "media"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 80,
    enabled: true,
    accessLevel: "public",
    tags: ["public-mirror"],
    description:
      "Media acquisition via the tikwm mirror: watermark-free MP4 for videos, full photo set for slideshows. Streams through the SSRF-guarded HTTP layer with byte caps; every file must pass verification (magic bytes / ffprobe) before promotion.",
    estimatedCostMs: 30_000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const itemId = ctx.identity.id;
      const shareUrl = itemId.startsWith("short:") ? ctx.identity.canonicalUrl : canonicalTikTokUrl(itemId);
      const call = await fetchTikwm(http, shareUrl, id);
      if (!call.ok || !call.data) {
        const f = call.failure ?? { code: FailureCode.INTERNAL_ERROR, message: "tikwm: unknown failure", subject: id, retryable: true };
        return fail(id, f, started, f.code === FailureCode.INVALID_RESOURCE);
      }
      const data = call.data;
      const { videos, photos, cover } = pickTikwmMedia(data);
      if (videos.length === 0 && photos.length === 0) {
        return fail(id, { code: FailureCode.EMPTY_RESULT, message: "mirror returned no downloadable media", subject: id, retryable: true }, started);
      }

      const frag = safeIdFragment(itemId.startsWith("short:") ? data.id ?? itemId : itemId);
      const artifacts: RawArtifactRef[] = [];
      const warnings: string[] = [];

      if (photos.length > 0) {
        // Slideshow post: fetch the full photo set (+ cover as bonus).
        for (let i = 0; i < photos.length; i++) {
          const ref = await downloadTo(ctx, http, photos[i], `tiktok_${frag}_${String(i + 1).padStart(2, "0")}.jpg`, "photo", 64 * 1024 * 1024, "tikwm");
          if (ref) artifacts.push(ref);
          else warnings.push(`photo ${i + 1} failed`);
        }
        if (cover) {
          const ref = await downloadTo(ctx, http, cover, `tiktok_${frag}_cover.jpg`, "photo", 32 * 1024 * 1024, "tikwm");
          if (ref) artifacts.push(ref);
        }
      } else {
        // Video post: first working URL wins (hd → sd → watermark).
        for (const vu of videos) {
          const ref = await downloadTo(ctx, http, vu, `tiktok_${frag}.mp4`, "video", MAX_MEDIA_BYTES, "tikwm");
          if (ref) {
            artifacts.push(ref);
            break;
          }
          warnings.push(`video source failed: ${new URL(vu).host}`);
        }
        if (cover) {
          const ref = await downloadTo(ctx, http, cover, `tiktok_${frag}_cover.jpg`, "photo", 32 * 1024 * 1024, "tikwm");
          if (ref) artifacts.push(ref);
        }
      }

      if (artifacts.length === 0) {
        return fail(id, { code: FailureCode.NETWORK_FAILURE, message: `all media downloads failed (${warnings.join("; ") || "no sources"})`, subject: id, retryable: true }, started);
      }

      const evidence: Evidence = {
        id: `ev_${ctx.hash(`${itemId}:tikwm:acquire`)}`,
        source: id,
        type: "tikwm.acquire",
        data: {
          itemId,
          title: data.title ?? null,
          author: data.author?.unique_id ?? null,
          durationSec: data.duration ?? null,
          artifacts: artifacts.map((a) => ({ filename: a.filename, kind: a.kind, bytes: a.expectedBytes })),
          warnings: warnings.length > 0 ? warnings : undefined
        },
        retrievedAt: new Date().toISOString(),
        reliability: 0.75,
        provenance: { endpoint: "tikwm.com/api", mirror: "tikwm.com", mode: photos.length > 0 ? "slideshow" : "video" }
      };
      return { ok: true, routeId: id, evidence: [evidence], artifacts, latencyMs: Date.now() - started };
    }
  };
}

/* ------------------------------ probe route ------------------------------ */

export function tiktokProbeRoute(http: HttpLayer): AccessRoute {
  const id = "tiktok.probe.short";
  return {
    id,
    platform: "tiktok",
    capabilities: ["resolve", "inspect"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 95,
    enabled: true,
    accessLevel: "public",
    tags: ["scrape"],
    description:
      "Short-link resolver + reachability probe. vm/vt.tiktok.com and /t/ links are resolved to their canonical URL via one redirect-following GET (zero media bytes). Canonical links pass through untouched.",
    estimatedCostMs: 3000,
    async probe(): Promise<ProbeResult> {
      return { viable: true, confidence: 0.5, reason: "probe route" };
    },
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const identity = ctx.identity;
      if (!identity.canonicalUrl) {
        return fail(id, { code: FailureCode.INVALID_RESOURCE, message: "no canonical URL to probe", subject: id, retryable: false }, started, true);
      }
      try {
        const res = await http.get(identity.canonicalUrl, { timeoutMs: 15_000, maxBytes: 512 * 1024 });
        const reachable = res.status === 200;
        const evidence: Evidence = {
          id: `ev_${ctx.hash(`${identity.id}:tiktok:probe`)}`,
          source: id,
          type: "tiktok.probe",
          data: { reachable, httpStatus: res.status, finalUrl: res.finalUrl },
          retrievedAt: new Date().toISOString(),
          reliability: 0.3,
          provenance: { endpoint: "tiktok.com" }
        };
        if (res.status === 404 || /Couldn't find this account|Video unavailable/i.test(res.body.toString("utf8"))) {
          return fail(id, { code: FailureCode.INVALID_RESOURCE, message: "post appears deleted or private (404)", subject: id, retryable: false }, started, true);
        }
        return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
      } catch (err) {
        if (err instanceof HttpFailure) {
          return fail(id, err.toFailure(id), started);
        }
        return fail(id, { code: FailureCode.NETWORK_FAILURE, message: (err as Error).message.slice(0, 160), subject: id, retryable: true }, started);
      }
    }
  };
}

export function tiktokRoutes(http: HttpLayer): AccessRoute[] {
  return [tiktokProbeRoute(http), tiktokOembedRoute(http), tiktokTikwmMetadataRoute(http), tiktokTikwmAcquireRoute(http)];
}

export { parseTikTokUrl };
