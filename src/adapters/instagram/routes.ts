/**
 * Instagram routes — the ONLY honest no-auth public surface: the /embed
 * page. Instagram aggressively login-walls everything else; UAAL reports
 * those walls instead of bypassing them (xthread-agent fail-closed
 * ideology: a wall is an outcome, not an obstacle).
 *
 * 1. instagram.embed.metadata — /p/{code}/embed/captioned/ page: caption,
 *    username, image URLs (escaped JSON blobs), video URL when present.
 * 2. instagram.embed.acquire  — download the images / video found by the
 *    same embed parse into verified artifacts.
 */
import type { AccessRoute, Evidence, ExecutionContext, RawArtifactRef, ResourceRequest, RouteResult } from "../../core/contracts.js";
import { FailureCode, type Failure } from "../../core/errors.js";
import { HttpFailure, type HttpLayer } from "../../core/http.js";
import { canonicalInstagramUrl } from "./identity.js";
import { downloadTo, extractEscapedJsonField, extractOgField, safeIdFragment, stripTags } from "../lib/media.js";

const EMBED_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36";

function fail(routeId: string, failure: Failure, started: number, unavailable = false): RouteResult {
  return { ok: false, routeId, evidence: [], artifacts: [], failure, unavailable, latencyMs: Date.now() - started };
}

/* ------------------------------ embed parsing ------------------------------ */

export interface InstagramEmbedData {
  username?: string;
  caption?: string;
  images: string[];
  videoUrl?: string;
  thumbnailUrl?: string;
  isVideo: boolean;
}

export function parseInstagramEmbed(html: string): InstagramEmbedData | null {
  // Login-wall / error pages contain none of these markers.
  if (!/class="Embed"|EmbeddedPost|Image |Video |class="Caption"/.test(html) && !/display_url|video_url/.test(html)) {
    return null;
  }

  const username =
    html.match(/class="UsernameText">([^<]+)</)?.[1]?.trim() ??
    extractOgField(html, "og:title")?.match(/@([\w.]+)/)?.[1] ??
    html.match(/"username":"([^"]+)"/)?.[1];

  // Caption: the embed wraps the text in a Caption block that contains a
  // nested UsernameText div — strip those first, then take the block.
  const cleaned = html.replace(/<div class="UsernameText">[\s\S]*?<\/div>/g, "");
  const captionBlock = cleaned.match(/<div class="Caption"[\s\S]*?<\/div>/)?.[0];
  const caption = (captionBlock ? stripTags(captionBlock) : undefined) ?? extractOgField(html, "og:description");

  const videoUrl = extractEscapedJsonField(html, "video_url")[0];
  const displayUrls = extractEscapedJsonField(html, "display_url");
  const images = displayUrls.filter((u) => /^https?:\/\//.test(u));
  const thumbnailUrl = extractOgField(html, "og:image") ?? images[0];

  if (!videoUrl && images.length === 0 && !thumbnailUrl && !caption && !username) return null;

  return {
    username,
    caption,
    images,
    videoUrl: videoUrl && /^https?:\/\//.test(videoUrl) ? videoUrl : undefined,
    thumbnailUrl: thumbnailUrl && /^https?:\/\//.test(thumbnailUrl) ? thumbnailUrl : undefined,
    isVideo: Boolean(videoUrl)
  };
}

async function fetchEmbed(http: HttpLayer, shortcode: string, routeId: string): Promise<{ html: string; status: number } | { error: Failure; unavailable?: boolean }> {
  const url = `${canonicalInstagramUrl(shortcode)}embed/captioned/`;
  try {
    const res = await http.get(url, {
      timeoutMs: 25_000,
      maxBytes: 3 * 1024 * 1024,
      headers: { "user-agent": EMBED_UA, accept: "text/html,application/xhtml+xml" }
    });
    if (res.status === 404) {
      return { error: { code: FailureCode.INVALID_RESOURCE, message: "post not found (404) — deleted or never existed", subject: routeId, retryable: false }, unavailable: true };
    }
    if (res.status === 302 || res.status === 301) {
      return { error: { code: FailureCode.AUTH_REQUIRED, message: "embed redirected to the login page", subject: routeId, retryable: false } };
    }
    if (res.status >= 400) {
      return { error: { code: res.status === 429 ? FailureCode.RATE_LIMIT : FailureCode.HTTP_ERROR, message: `HTTP ${res.status} from embed page`, subject: routeId, retryable: res.status >= 500 || res.status === 429 } };
    }
    return { html: res.body.toString("utf8"), status: res.status };
  } catch (err) {
    if (err instanceof HttpFailure) return { error: err.toFailure(routeId) };
    return { error: { code: FailureCode.NETWORK_FAILURE, message: (err as Error).message.slice(0, 160), subject: routeId, retryable: true } };
  }
}

/* ------------------------------ embed metadata route ------------------------------ */

export function instagramEmbedMetadataRoute(http: HttpLayer): AccessRoute {
  const id = "instagram.embed.metadata";
  return {
    id,
    platform: "instagram",
    capabilities: ["metadata", "author", "media", "media_metadata", "extract"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 85,
    enabled: true,
    accessLevel: "public",
    tags: ["scrape"],
    description:
      "Instagram official embed page (/embed/captioned/, no auth). Parses the caption, username and media URLs embedded in the page JSON. Login redirects surface honestly as requires_auth — UAAL never bypasses them.",
    estimatedCostMs: 4000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const shortcode = ctx.identity.id;
      const fetched = await fetchEmbed(http, shortcode, id);
      if ("error" in fetched) {
        return fail(id, fetched.error, started, fetched.unavailable);
      }
      const parsed = parseInstagramEmbed(fetched.html);
      if (!parsed) {
        return fail(id, { code: FailureCode.AUTH_REQUIRED, message: "embed page contained no post data (login wall or unsupported surface)", subject: id, retryable: false }, started);
      }
      const evidence: Evidence = {
        id: `ev_${ctx.hash(`${shortcode}:ig:embed`)}`,
        source: id,
        type: "instagram.embed",
        data: { ...parsed, shortcode, httpStatus: fetched.status },
        retrievedAt: new Date().toISOString(),
        reliability: 0.7,
        provenance: { endpoint: "instagram.com/p/{code}/embed/captioned" }
      };
      return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
    }
  };
}

/* ------------------------------ embed acquire route ------------------------------ */

export function instagramEmbedAcquireRoute(http: HttpLayer): AccessRoute {
  const id = "instagram.embed.acquire";
  return {
    id,
    platform: "instagram",
    capabilities: ["acquire", "artifact", "media"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 78,
    enabled: true,
    accessLevel: "public",
    tags: ["scrape"],
    description:
      "Media acquisition from the embed surface: video MP4 when the post is a reel/video, otherwise the full image set (carousel-aware when the embed exposes multiple display_urls). Fail-closed: every byte must pass verification.",
    estimatedCostMs: 20_000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const shortcode = ctx.identity.id;
      const fetched = await fetchEmbed(http, shortcode, id);
      if ("error" in fetched) {
        return fail(id, fetched.error, started, fetched.unavailable);
      }
      const parsed = parseInstagramEmbed(fetched.html);
      if (!parsed || (!parsed.videoUrl && parsed.images.length === 0)) {
        return fail(id, { code: FailureCode.AUTH_REQUIRED, message: "embed page exposed no downloadable media (login wall or unsupported surface)", subject: id, retryable: false }, started);
      }

      const frag = safeIdFragment(shortcode);
      const artifacts: RawArtifactRef[] = [];
      const warnings: string[] = [];

      if (parsed.videoUrl) {
        const ref = await downloadTo(ctx, http, parsed.videoUrl, `instagram_${frag}.mp4`, "video", 512 * 1024 * 1024, "instagram-embed");
        if (ref) artifacts.push(ref);
        else warnings.push("video download failed");
      }
      if (artifacts.length === 0) {
        let idx = 0;
        for (const img of parsed.images) {
          idx++;
          const ref = await downloadTo(ctx, http, img, `instagram_${frag}_${String(idx).padStart(2, "0")}.jpg`, "photo", 64 * 1024 * 1024, "instagram-embed");
          if (ref) artifacts.push(ref);
          else warnings.push(`image ${idx} failed`);
        }
      }

      if (artifacts.length === 0) {
        return fail(id, { code: FailureCode.NETWORK_FAILURE, message: `all media downloads failed (${warnings.join("; ") || "no sources"})`, subject: id, retryable: true }, started);
      }

      const evidence: Evidence = {
        id: `ev_${ctx.hash(`${shortcode}:ig:acquire`)}`,
        source: id,
        type: "instagram.acquire",
        data: {
          shortcode,
          username: parsed.username ?? null,
          caption: parsed.caption ?? null,
          isVideo: parsed.isVideo,
          artifacts: artifacts.map((a) => ({ filename: a.filename, kind: a.kind, bytes: a.expectedBytes })),
          warnings: warnings.length > 0 ? warnings : undefined
        },
        retrievedAt: new Date().toISOString(),
        reliability: 0.7,
        provenance: { endpoint: "instagram.com/p/{code}/embed/captioned", mode: parsed.videoUrl ? "video" : "images" }
      };
      return { ok: true, routeId: id, evidence: [evidence], artifacts, latencyMs: Date.now() - started };
    }
  };
}

export function instagramRoutes(http: HttpLayer): AccessRoute[] {
  return [instagramEmbedMetadataRoute(http), instagramEmbedAcquireRoute(http)];
}
