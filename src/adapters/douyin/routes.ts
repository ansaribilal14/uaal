/**
 * Douyin routes — two structurally independent public paths:
 *
 * 1. douyin.share.metadata  — iesdouyin.com mobile share page. The page
 *    embeds `window._ROUTER_DATA` JSON with the full item record
 *    (description, author, play_addr, cover, statistics). No auth.
 * 2. douyin.tikwm.acquire   — the tikwm mirror accepts douyin share URLs
 *    and mediates the no-watermark MP4 download.
 *
 * Both routes never raise; failures are classified honestly.
 */
import type { AccessRoute, Evidence, ExecutionContext, RawArtifactRef, ResourceRequest, RouteResult } from "../../core/contracts.js";
import { FailureCode, type Failure } from "../../core/errors.js";
import { HttpFailure, type HttpLayer } from "../../core/http.js";
import { canonicalDouyinUrl, parseDouyinUrl } from "./identity.js";
import { absolutizeTikwm, fetchTikwm, type TikwmData } from "../lib/tikwm.js";
import { downloadTo, extractWindowJson, safeIdFragment, unescapeJsString } from "../lib/media.js";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function fail(routeId: string, failure: Failure, started: number, unavailable = false): RouteResult {
  return { ok: false, routeId, evidence: [], artifacts: [], failure, unavailable, latencyMs: Date.now() - started };
}

/* ------------------------------ share page parsing ------------------------------ */

export interface DouyinItem {
  desc?: string;
  create_time?: number;
  author?: { nickname?: string; unique_id?: string; signature?: string };
  video?: {
    play_addr?: { uri?: string; url_list?: string[] };
    download_addr?: { uri?: string; url_list?: string[] };
    cover?: { url_list?: string[] };
    origin_cover?: { url_list?: string[] };
    duration?: number;
  };
  statistics?: { digg_count?: number; comment_count?: number; share_count?: number; play_count?: number; collect_count?: number };
}

export interface RouterData {
  loaderData?: Record<string, { videoInfoRes?: { item_list?: DouyinItem[] } }>;
}

/** Parse the embedded _ROUTER_DATA JSON out of the share page HTML. */
export function parseRouterData(html: string): DouyinItem | null {
  const json = extractWindowJson(html, "_ROUTER_DATA") as RouterData | undefined;
  if (!json?.loaderData) return null;
  const pages = Object.values(json.loaderData);
  for (const page of pages) {
    const items = page?.videoInfoRes?.item_list;
    if (Array.isArray(items) && items.length > 0) {
      const item = items[0];
      if (item && typeof item === "object") return item;
    }
  }
  return null;
}

/** Build a direct play URL from the play_addr uri (works with a mobile UA). */
export function playAddrUrl(item: DouyinItem): { url?: string; uri?: string } {
  const uri = item.video?.play_addr?.uri;
  const listed = item.video?.play_addr?.url_list?.find((u) => u.startsWith("http"));
  const url = uri
    ? `https://www.iesdouyin.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&ratio=1080p&line=0`
    : listed;
  return { url, uri };
}

export function douyinCoverUrl(item: DouyinItem): string | undefined {
  return item.video?.origin_cover?.url_list?.find((u) => u.startsWith("http")) ?? item.video?.cover?.url_list?.find((u) => u.startsWith("http"));
}

/* ------------------------------ share metadata route ------------------------------ */

export function douyinShareMetadataRoute(http: HttpLayer): AccessRoute {
  const id = "douyin.share.metadata";
  return {
    id,
    platform: "douyin",
    capabilities: ["metadata", "author", "media", "media_metadata", "extract"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 85,
    enabled: true,
    accessLevel: "public",
    tags: ["official"],
    description:
      "iesdouyin.com mobile share page (no auth). The page embeds window._ROUTER_DATA JSON: description, author, play_addr, cover, duration, engagement statistics. Served with a mobile client profile; login walls surface honestly.",
    estimatedCostMs: 4000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const itemId = ctx.identity.id;
      const sharePath = itemId.startsWith("short:") ? ctx.identity.canonicalUrl : `https://www.iesdouyin.com/share/video/${itemId}`;
      try {
        const res = await http.get(sharePath, {
          timeoutMs: 25_000,
          maxBytes: 2 * 1024 * 1024,
          headers: { "user-agent": MOBILE_UA, accept: "text/html,application/xhtml+xml" }
        });
        if (res.status === 403 || res.status === 401) {
          return fail(id, { code: FailureCode.BLOCKED, message: `share page refused access (HTTP ${res.status})`, subject: id, retryable: false }, started);
        }
        if (res.status === 404) {
          return fail(id, { code: FailureCode.INVALID_RESOURCE, message: "post not found (404)", subject: id, retryable: false }, started, true);
        }
        if (res.status >= 400) {
          return fail(id, { code: FailureCode.HTTP_ERROR, message: `HTTP ${res.status} from share page`, subject: id, retryable: res.status >= 500 }, started);
        }
        const html = res.body.toString("utf8");
        if (/验证码|captcha|verify/i.test(html) && !/_ROUTER_DATA/.test(html)) {
          return fail(id, { code: FailureCode.BLOCKED, message: "share page demanded a captcha", subject: id, retryable: false }, started);
        }
        const item = parseRouterData(html);
        if (!item) {
          return fail(id, { code: FailureCode.PARSER_FAILURE, message: "share page contained no _ROUTER_DATA item record", subject: id, retryable: true }, started);
        }
        const evidence: Evidence = {
          id: `ev_${ctx.hash(`${itemId}:douyin:share`)}`,
          source: id,
          type: "douyin.router_data",
          data: { item, httpStatus: res.status },
          retrievedAt: new Date().toISOString(),
          reliability: 0.85,
          provenance: { endpoint: "iesdouyin.com/share/video/{id}" }
        };
        return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
      } catch (err) {
        if (err instanceof HttpFailure) return fail(id, err.toFailure(id), started);
        return fail(id, { code: FailureCode.NETWORK_FAILURE, message: (err as Error).message.slice(0, 160), subject: id, retryable: true }, started);
      }
    }
  };
}

/* ------------------------------ mirror acquire route ------------------------------ */

export function pickDouyinMirrorMedia(data: TikwmData): { videos: string[]; photos: string[]; cover?: string } {
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

export function douyinTikwmAcquireRoute(http: HttpLayer): AccessRoute {
  const id = "douyin.tikwm.acquire";
  return {
    id,
    platform: "douyin",
    capabilities: ["acquire", "artifact", "media"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 80,
    enabled: true,
    accessLevel: "public",
    tags: ["public-mirror"],
    description:
      "Media acquisition through the tikwm mirror (accepts douyin share URLs): no-watermark MP4 plus cover image. Streams through the SSRF-guarded HTTP layer; verification (magic bytes / ffprobe) gates promotion — fail-closed.",
    estimatedCostMs: 30_000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const itemId = ctx.identity.id;
      const shareUrl = itemId.startsWith("short:") ? ctx.identity.canonicalUrl : `https://www.iesdouyin.com/share/video/${itemId}`;
      const call = await fetchTikwm(http, shareUrl, id);
      if (!call.ok || !call.data) {
        const f = call.failure ?? { code: FailureCode.INTERNAL_ERROR, message: "tikwm: unknown failure", subject: id, retryable: true };
        return fail(id, f, started, f.code === FailureCode.INVALID_RESOURCE);
      }
      const data = call.data;
      const { videos, photos, cover } = pickDouyinMirrorMedia(data);
      if (videos.length === 0 && photos.length === 0) {
        return fail(id, { code: FailureCode.EMPTY_RESULT, message: "mirror returned no downloadable media", subject: id, retryable: true }, started);
      }

      const frag = safeIdFragment(itemId.startsWith("short:") ? data.id ?? itemId : itemId);
      const artifacts: RawArtifactRef[] = [];
      const warnings: string[] = [];

      let got = false;
      for (const vu of videos) {
        const ref = await downloadTo(ctx, http, vu, `douyin_${frag}.mp4`, "video", 512 * 1024 * 1024, "tikwm");
        if (ref) {
          artifacts.push(ref);
          got = true;
          break;
        }
        warnings.push(`video source failed: ${new URL(vu).host}`);
      }
      if (!got && photos.length > 0) {
        for (let i = 0; i < photos.length; i++) {
          const ref = await downloadTo(ctx, http, photos[i], `douyin_${frag}_${String(i + 1).padStart(2, "0")}.jpg`, "photo", 64 * 1024 * 1024, "tikwm");
          if (ref) artifacts.push(ref);
          else warnings.push(`photo ${i + 1} failed`);
        }
      }
      if (cover) {
        const ref = await downloadTo(ctx, http, cover, `douyin_${frag}_cover.jpg`, "photo", 32 * 1024 * 1024, "tikwm");
        if (ref) artifacts.push(ref);
      }

      if (artifacts.length === 0) {
        return fail(id, { code: FailureCode.NETWORK_FAILURE, message: `all media downloads failed (${warnings.join("; ") || "no sources"})`, subject: id, retryable: true }, started);
      }

      const evidence: Evidence = {
        id: `ev_${ctx.hash(`${itemId}:douyin:acquire`)}`,
        source: id,
        type: "douyin.acquire",
        data: {
          itemId,
          title: data.title ? unescapeJsString(data.title) : null,
          author: data.author?.unique_id ?? null,
          durationSec: data.duration ?? null,
          artifacts: artifacts.map((a) => ({ filename: a.filename, kind: a.kind, bytes: a.expectedBytes })),
          warnings: warnings.length > 0 ? warnings : undefined
        },
        retrievedAt: new Date().toISOString(),
        reliability: 0.7,
        provenance: { endpoint: "tikwm.com/api", mirror: "tikwm.com", platform: "douyin" }
      };
      return { ok: true, routeId: id, evidence: [evidence], artifacts, latencyMs: Date.now() - started };
    }
  };
}

/* ------------------------------ direct acquire route ------------------------------ */

/**
 * Acquisition straight from iesdouyin: re-reads the share page, extracts the
 * play_addr and downloads from the mobile play endpoint. Works wherever the
 * share page actually server-renders the item record (residential/CN
 * networks); fails honestly elsewhere.
 */
export function douyinIesdouyinAcquireRoute(http: HttpLayer): AccessRoute {
  const id = "douyin.iesdouyin.acquire";
  return {
    id,
    platform: "douyin",
    capabilities: ["acquire", "artifact", "media"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 82,
    enabled: true,
    accessLevel: "public",
    tags: ["official"],
    description:
      "Direct acquisition via iesdouyin.com: reads the share page's _ROUTER_DATA play_addr and downloads from the mobile play endpoint with a mobile client profile. Fails honestly on networks where Douyin renders client-side or blocks.",
    estimatedCostMs: 25_000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const itemId = ctx.identity.id;
      const sharePath = itemId.startsWith("short:") ? ctx.identity.canonicalUrl : `https://www.iesdouyin.com/share/video/${itemId}`;
      let html: string;
      try {
        const res = await http.get(sharePath, {
          timeoutMs: 25_000,
          maxBytes: 2 * 1024 * 1024,
          headers: { "user-agent": MOBILE_UA, accept: "text/html,application/xhtml+xml", "accept-language": "zh-CN,zh;q=0.9,en;q=0.6" }
        });
        if (res.status >= 400) {
          const code = res.status === 403 || res.status === 401 ? FailureCode.BLOCKED : res.status === 429 ? FailureCode.RATE_LIMIT : FailureCode.HTTP_ERROR;
          return fail(id, { code, message: `share page refused access (HTTP ${res.status})`, subject: id, retryable: res.status >= 500 }, started);
        }
        html = res.body.toString("utf8");
      } catch (err) {
        if (err instanceof HttpFailure) return fail(id, err.toFailure(id), started);
        return fail(id, { code: FailureCode.NETWORK_FAILURE, message: (err as Error).message.slice(0, 160), subject: id, retryable: true }, started);
      }

      const item = parseRouterData(html);
      if (!item) {
        return fail(
          id,
          { code: FailureCode.BLOCKED, message: "share page rendered without the video record (Douyin serves a client-side shell to this network); acquisition refused honestly", subject: id, retryable: false },
          started
        );
      }
      const { url: playUrl } = playAddrUrl(item);
      if (!playUrl) {
        return fail(id, { code: FailureCode.EMPTY_RESULT, message: "share page item has no play_addr", subject: id, retryable: false }, started);
      }

      const frag = safeIdFragment(itemId.replace(/^short:/, ""));
      const artifacts: RawArtifactRef[] = [];
      const warnings: string[] = [];
      const vRef = await downloadTo(ctx, http, playUrl, `douyin_${frag}.mp4`, "video", 512 * 1024 * 1024, "iesdouyin");
      if (vRef) artifacts.push(vRef);
      else warnings.push("play endpoint produced no usable bytes");

      const cover = douyinCoverUrl(item);
      if (cover) {
        const cRef = await downloadTo(ctx, http, cover, `douyin_${frag}_cover.jpg`, "photo", 32 * 1024 * 1024, "iesdouyin");
        if (cRef) artifacts.push(cRef);
      }

      if (artifacts.length === 0) {
        return fail(id, { code: FailureCode.NETWORK_FAILURE, message: `media download failed (${warnings.join("; ")})`, subject: id, retryable: true }, started);
      }

      const evidence: Evidence = {
        id: `ev_${ctx.hash(`${itemId}:douyin:direct`)}`,
        source: id,
        type: "douyin.acquire",
        data: {
          itemId,
          title: item.desc ?? null,
          author: item.author?.unique_id ?? null,
          durationSec: item.video?.duration ?? null,
          via: "iesdouyin-play-endpoint",
          artifacts: artifacts.map((a) => ({ filename: a.filename, kind: a.kind, bytes: a.expectedBytes })),
          warnings: warnings.length > 0 ? warnings : undefined
        },
        retrievedAt: new Date().toISOString(),
        reliability: 0.8,
        provenance: { endpoint: "iesdouyin.com/aweme/v1/play", platform: "douyin" }
      };
      return { ok: true, routeId: id, evidence: [evidence], artifacts, latencyMs: Date.now() - started };
    }
  };
}

export function douyinRoutes(http: HttpLayer): AccessRoute[] {
  return [douyinShareMetadataRoute(http), douyinIesdouyinAcquireRoute(http), douyinTikwmAcquireRoute(http)];
}

export { parseDouyinUrl, canonicalDouyinUrl };
