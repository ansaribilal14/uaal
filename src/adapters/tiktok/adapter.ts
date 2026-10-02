/**
 * TikTok adapter — videos, photo-mode posts and slideshows via
 * official oEmbed + the tikwm public mirror. No credentials, no
 * scraping of auth-walled surfaces, honest failure reporting.
 */
import type {
  CapabilityDescriptor,
  DetectionResult,
  Evidence,
  NormalizedMedia,
  NormalizedResource,
  PlatformAdapter,
  ResourceIdentity,
  ResourceRequest,
  RouteDiscoveryContext,
  AccessRoute,
  Artifact,
  VerificationResult
} from "../../core/contracts.js";
import { HttpLayer } from "../../core/http.js";
import { makeIdentity } from "../../core/identity.js";
import { SCHEMA_VERSION } from "../../version.js";
import { verifyNormalizedResource } from "../../core/verify/index.js";
import { parseTikTokUrl, resolveTikTokIdentity, type ParsedTikTok } from "./identity.js";
import { tiktokRoutes, tikwmMetadataFrom, pickTikwmMedia } from "./routes.js";
import { absolutizeTikwm } from "../lib/tikwm.js";

export class TikTokAdapter implements PlatformAdapter {
  readonly id = "tiktok" as const;
  private http: HttpLayer;

  constructor(http: HttpLayer) {
    this.http = http;
  }

  detect(resource: string): DetectionResult {
    const parsed = parseTikTokUrl(resource);
    if (parsed) {
      return { matched: true, confidence: 0.97, platform: "tiktok", resourceType: "post", detail: parsed.itemId ?? `short:${parsed.shortCode}` };
    }
    return { matched: false, confidence: 0 };
  }

  capabilities(): CapabilityDescriptor[] {
    return [
      { name: "metadata", description: "Caption/title, duration and engagement metrics (mirror + oEmbed).", engineLevel: false },
      { name: "author", description: "Author handle and nickname.", engineLevel: false },
      { name: "media", description: "Video URLs and full slideshow photo inventory.", engineLevel: false },
      { name: "media_metadata", description: "Per-media details: duration, cover, size.", engineLevel: false },
      { name: "extract", description: "Raw mirror payload in platformData.", engineLevel: false },
      { name: "acquire", description: "Verified artifact production: watermark-free MP4 or slideshow photo set.", engineLevel: false },
      { name: "artifact", description: "Explicit artifact production.", engineLevel: false },
      { name: "resolve", description: "Short-link (vm/vt.tiktok.com, /t/) resolution to canonical URL.", engineLevel: false },
      { name: "inspect", description: "Reachability probe (zero media bytes).", engineLevel: false }
    ];
  }

  limitations(): string[] {
    return [
      "Public content only: age-gated, region-locked and private posts fail honestly (never bypassed).",
      "Media acquisition goes through the tikwm.com public mirror; if the mirror is down or rate-limited, acquisition fails with a clear reason while metadata may still succeed via oEmbed.",
      "Comment trees and full profile data are not exposed by any public route yet."
    ];
  }

  async discoverRoutes(request: ResourceRequest, ctx: RouteDiscoveryContext): Promise<AccessRoute[]> {
    return tiktokRoutes(this.http);
  }

  async resolveIdentity(resource: string): Promise<ResourceIdentity> {
    const identity = await resolveTikTokIdentity(resource, async (shareUrl) => {
      // One redirect-following GET; we only need the final URL.
      try {
        const res = await this.http.get(shareUrl, { timeoutMs: 15_000, maxBytes: 64 * 1024 });
        return res.finalUrl ?? null;
      } catch {
        return null;
      }
    });
    if (!identity) throw new Error(`not a tiktok post: ${resource.slice(0, 120)}`);
    return identity;
  }

  async normalize(evidence: Evidence[], request: ResourceRequest, identity: ResourceIdentity): Promise<NormalizedResource> {
    const mirrorEv = [...evidence].reverse().find((e) => e.type === "tikwm.api")?.data as
      | ({ data?: import("../lib/tikwm.js").TikwmData } & Record<string, unknown>)
      | undefined;
    const oembedEv = [...evidence].reverse().find((e) => e.type === "tiktok.oembed")?.data as Record<string, unknown> | undefined;

    const data = mirrorEv?.data;
    const media: NormalizedMedia[] = [];
    const missing: string[] = [];

    if (data) {
      const { videos, photos, cover } = pickTikwmMedia(data);
      for (const v of videos) {
        media.push({
          kind: "video",
          url: v,
          durationSec: typeof data.duration === "number" ? data.duration : undefined,
          thumbnailUrl: cover,
          mimeType: "video/mp4",
          downloadable: true
        });
        break; // primary video only; alternates live in platformData
      }
      for (const p of photos) {
        media.push({ kind: "photo", url: p, mimeType: "image/jpeg", downloadable: true });
      }
      if (media.length === 0) missing.push("media");
    } else {
      missing.push("mirror_metadata");
      const thumb = oembedEv?.thumbnail_url as string | undefined;
      if (thumb) media.push({ kind: "photo", url: thumb, downloadable: false, unavailableReason: "thumbnail_only_no_mirror" });
    }

    const meta = data ? tikwmMetadataFrom(data) : undefined;
    const oembedTitle = oembedEv?.title as string | undefined;
    const oembedAuthor = oembedEv?.author_name as string | undefined;

    const raw = evidence.map(({ id, source, type, retrievedAt, reliability }) => ({ id, source, type, retrievedAt, reliability }));

    return {
      schemaVersion: SCHEMA_VERSION,
      platform: "tiktok",
      resource: { id: identity.id, url: identity.canonicalUrl, type: "post", platform: "tiktok" },
      content: {
        title: meta?.title ?? oembedTitle,
        description: meta?.title ?? oembedTitle,
        publishedAt: data?.create_time ? new Date(data.create_time * 1000).toISOString() : undefined,
        metrics: meta?.metrics ?? {}
      },
      author: meta?.authorHandle
        ? { handle: meta.authorHandle, url: `https://www.tiktok.com/@${meta.authorHandle}`, displayName: meta.authorName ?? oembedAuthor }
        : oembedAuthor
          ? { handle: oembedAuthor, displayName: oembedAuthor }
          : undefined,
      media,
      relationships: [],
      platformData: {
        source: data ? "tikwm-mirror" : "oembed",
        durationSec: meta?.durationSec ?? null,
        cover: data ? (absolutizeTikwm(data.origin_cover ?? data.cover) ?? null) : null,
        music: data ? (absolutizeTikwm(data.music) ?? null) : null,
        alternateVideoSources: data ? pickTikwmMedia(data).videos : [],
        hd: data?.hdplay ? true : false,
        raw
      },
      evidence: raw,
      uncertainty: { confidence: data ? 0.85 : oembedEv ? 0.55 : 0.25, missing, notes: [] }
    };
  }

  async verify(resource: NormalizedResource, artifacts: Artifact[]): Promise<VerificationResult> {
    const base = verifyNormalizedResource(resource, { capability: "metadata" });
    const parsed: ParsedTikTok | null = parseTikTokUrl(resource.resource.url);
    const check = {
      name: "identity_consistency",
      passed: !parsed?.itemId || parsed.itemId === resource.resource.id
    };
    const artifactKindOk = artifacts.every((a) => ["video", "photo", "audio", "manifest"].includes(String(a.type)));
    const kindCheck = { name: "artifact_kinds", passed: artifactKindOk };
    return { ...base, checks: [check, kindCheck, ...base.checks], verified: check.passed && kindCheck.passed && base.verified };
  }
}
