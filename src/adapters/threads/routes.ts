/**
 * Threads routes — the public /embed page is the only stable no-auth
 * surface for a post. xthread-agent ideology applied to Meta's Threads:
 * parse the embedded context JSON, extract media slots with provenance,
 * and fail closed when the wall goes up.
 *
 * 1. threads.embed.metadata — /@user/post/{id}/embed page parse.
 * 2. threads.embed.acquire  — download the images (or video) exposed there.
 */
import type { AccessRoute, Evidence, ExecutionContext, RawArtifactRef, ResourceRequest, RouteResult } from "../../core/contracts.js";
import { FailureCode, type Failure } from "../../core/errors.js";
import { HttpFailure, type HttpLayer } from "../../core/http.js";
import { parseThreadsUrl, canonicalThreadsUrl } from "./identity.js";
import { downloadTo, extractEscapedJsonField, extractOgField, safeIdFragment, stripTags } from "../lib/media.js";

const EMBED_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36";

function fail(routeId: string, failure: Failure, started: number, unavailable = false): RouteResult {
  return { ok: false, routeId, evidence: [], artifacts: [], failure, unavailable, latencyMs: Date.now() - started };
}

/* ------------------------------ embed parsing ------------------------------ */

export interface ThreadsEmbedData {
  username?: string;
  caption?: string;
  images: string[];
  videoUrl?: string;
  thumbnailUrl?: string;
}

export function parseThreadsEmbed(html: string): ThreadsEmbedData | null {
  // Real embed pages carry post data (CDN media URLs / display_url JSON).
  // Generic JS shells (often served to datacenter IPs) contain none — treat
  // them as "no post data", never as a metadata hit.
  const mediaHrefs = extractEscapedJsonField(html, "display_url").filter((u) => /^https?:\/\//.test(u));
  const videoUrlRaw = extractEscapedJsonField(html, "video_url")[0];
  const videoUrl = videoUrlRaw && /^https?:\/\//.test(videoUrlRaw) ? videoUrlRaw : undefined;

  const username = html.match(/"username":"([A-Za-z0-9._]+)"/)?.[1];
  const jsonCaption = extractEscapedJsonField(html, "caption")[0];

  // "Post by <user> • Threads" titles carry partial truth; bare "Threads"
  // shells do not and are ignored.
  const titleRaw = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "";
  const titleCaption = titleRaw.includes("Post by") ? stripTags(titleRaw.replace(/\s*•\s*Threads\s*$/i, "")) : undefined;
  const ogCaption = extractOgField(html, "og:description");
  const caption = jsonCaption || ogCaption || titleCaption || undefined;

  const thumbnailUrl = extractOgField(html, "og:image") ?? mediaHrefs[0];

  if (mediaHrefs.length === 0 && !videoUrl && !caption && !username) return null;
  // A shell page with nothing but a generic title must NOT pass as metadata.
  if (!/^https?:\/\//.test(thumbnailUrl ?? "") && !caption && !videoUrl) return null;

  return {
    username,
    caption,
    images: mediaHrefs,
    videoUrl,
    thumbnailUrl: thumbnailUrl && /^https?:\/\//.test(thumbnailUrl) ? thumbnailUrl : undefined
  };
}

async function fetchEmbed(http: HttpLayer, username: string, postId: string, routeId: string): Promise<{ html: string; status: number } | { error: Failure; unavailable?: boolean }> {
  const url = `${canonicalThreadsUrl(username, postId)}/embed`;
  try {
    const res = await http.get(url, {
      timeoutMs: 25_000,
      maxBytes: 3 * 1024 * 1024,
      headers: { "user-agent": EMBED_UA, accept: "text/html,application/xhtml+xml" }
    });
    if (res.status === 404) {
      return { error: { code: FailureCode.INVALID_RESOURCE, message: "post not found (404) — deleted or never existed", subject: routeId, retryable: false }, unavailable: true };
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

export function threadsEmbedMetadataRoute(http: HttpLayer): AccessRoute {
  const id = "threads.embed.metadata";
  return {
    id,
    platform: "threads",
    capabilities: ["metadata", "author", "media", "media_metadata", "extract"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 85,
    enabled: true,
    accessLevel: "public",
    tags: ["scrape"],
    description:
      "Threads public embed page (no auth). Parses the post text, author and CDN media URLs embedded in the page. Login walls surface honestly; UAAL never bypasses them.",
    estimatedCostMs: 4000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const postId = ctx.identity.id;
      const parsedInput = parseThreadsUrl(ctx.identity.aliases[0] ?? ctx.identity.canonicalUrl);
      const username = parsedInput?.username ?? "user";
      const fetched = await fetchEmbed(http, username, postId, id);
      if ("error" in fetched) {
        return fail(id, fetched.error, started, fetched.unavailable);
      }
      const parsed = parseThreadsEmbed(fetched.html);
      if (!parsed) {
        return fail(id, { code: FailureCode.AUTH_REQUIRED, message: "embed page contained no post data (login wall or unsupported surface)", subject: id, retryable: false }, started);
      }
      const evidence: Evidence = {
        id: `ev_${ctx.hash(`${postId}:threads:embed`)}`,
        source: id,
        type: "threads.embed",
        data: { ...parsed, postId, httpStatus: fetched.status },
        retrievedAt: new Date().toISOString(),
        reliability: 0.65,
        provenance: { endpoint: "threads.net/@u/post/{id}/embed" }
      };
      return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
    }
  };
}

/* ------------------------------ embed acquire route ------------------------------ */

export function threadsEmbedAcquireRoute(http: HttpLayer): AccessRoute {
  const id = "threads.embed.acquire";
  return {
    id,
    platform: "threads",
    capabilities: ["acquire", "artifact", "media"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 78,
    enabled: true,
    accessLevel: "public",
    tags: ["scrape"],
    description:
      "Media acquisition from the Threads embed surface: video MP4 when present, otherwise the image set. All downloads stream through the SSRF-guarded HTTP layer and must pass verification before promotion.",
    estimatedCostMs: 20_000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const postId = ctx.identity.id;
      const parsedInput = parseThreadsUrl(ctx.identity.aliases[0] ?? ctx.identity.canonicalUrl);
      const username = parsedInput?.username ?? "user";
      const fetched = await fetchEmbed(http, username, postId, id);
      if ("error" in fetched) {
        return fail(id, fetched.error, started, fetched.unavailable);
      }
      const parsed = parseThreadsEmbed(fetched.html);
      if (!parsed || (!parsed.videoUrl && parsed.images.length === 0)) {
        return fail(id, { code: FailureCode.AUTH_REQUIRED, message: "embed page exposed no downloadable media (login wall or unsupported surface)", subject: id, retryable: false }, started);
      }

      const frag = safeIdFragment(postId);
      const artifacts: RawArtifactRef[] = [];
      const warnings: string[] = [];

      if (parsed.videoUrl) {
        const ref = await downloadTo(ctx, http, parsed.videoUrl, `threads_${frag}.mp4`, "video", 512 * 1024 * 1024, "threads-embed");
        if (ref) artifacts.push(ref);
        else warnings.push("video download failed");
      }
      if (artifacts.length === 0) {
        let idx = 0;
        for (const img of parsed.images) {
          idx++;
          const ref = await downloadTo(ctx, http, img, `threads_${frag}_${String(idx).padStart(2, "0")}.jpg`, "photo", 64 * 1024 * 1024, "threads-embed");
          if (ref) artifacts.push(ref);
          else warnings.push(`image ${idx} failed`);
        }
      }

      if (artifacts.length === 0) {
        return fail(id, { code: FailureCode.NETWORK_FAILURE, message: `all media downloads failed (${warnings.join("; ") || "no sources"})`, subject: id, retryable: true }, started);
      }

      const evidence: Evidence = {
        id: `ev_${ctx.hash(`${postId}:threads:acquire`)}`,
        source: id,
        type: "threads.acquire",
        data: {
          postId,
          username: parsed.username ?? null,
          caption: parsed.caption ?? null,
          artifacts: artifacts.map((a) => ({ filename: a.filename, kind: a.kind, bytes: a.expectedBytes })),
          warnings: warnings.length > 0 ? warnings : undefined
        },
        retrievedAt: new Date().toISOString(),
        reliability: 0.65,
        provenance: { endpoint: "threads.net/@u/post/{id}/embed", mode: parsed.videoUrl ? "video" : "images" }
      };
      return { ok: true, routeId: id, evidence: [evidence], artifacts, latencyMs: Date.now() - started };
    }
  };
}

export function threadsRoutes(http: HttpLayer): AccessRoute[] {
  return [threadsEmbedMetadataRoute(http), threadsEmbedAcquireRoute(http)];
}
