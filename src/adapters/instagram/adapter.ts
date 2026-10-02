/**
 * Instagram adapter — public embed surface only. Stories, private posts,
 * and anything behind the login wall are reported honestly (requires_auth),
 * never bypassed.
 */
import type {
  AccessRoute,
  Artifact,
  CapabilityDescriptor,
  DetectionResult,
  Evidence,
  NormalizedMedia,
  NormalizedResource,
  PlatformAdapter,
  ResourceIdentity,
  ResourceRequest,
  RouteDiscoveryContext,
  VerificationResult
} from "../../core/contracts.js";
import { HttpLayer } from "../../core/http.js";
import { SCHEMA_VERSION } from "../../version.js";
import { verifyNormalizedResource } from "../../core/verify/index.js";
import { instagramIdentity, parseInstagramUrl, canonicalInstagramUrl } from "./identity.js";
import { instagramRoutes, type InstagramEmbedData } from "./routes.js";

export class InstagramAdapter implements PlatformAdapter {
  readonly id = "instagram" as const;
  private http: HttpLayer;

  constructor(http: HttpLayer) {
    this.http = http;
  }

  detect(resource: string): DetectionResult {
    const parsed = parseInstagramUrl(resource);
    if (parsed) {
      if (parsed.kind === "story") {
        return { matched: false, confidence: 0 };
      }
      return { matched: true, confidence: 0.95, platform: "instagram", resourceType: parsed.kind, detail: parsed.shortcode };
    }
    return { matched: false, confidence: 0 };
  }

  capabilities(): CapabilityDescriptor[] {
    return [
      { name: "metadata", description: "Caption, username and media inventory from the public embed page.", engineLevel: false },
      { name: "author", description: "Author username as exposed by the embed.", engineLevel: false },
      { name: "media", description: "Image set and video URL when the embed exposes them.", engineLevel: false },
      { name: "media_metadata", description: "Per-media details: video vs images, thumbnail.", engineLevel: false },
      { name: "extract", description: "Raw embed-derived data in platformData.", engineLevel: false },
      { name: "acquire", description: "Verified artifacts from the embed surface (video MP4 or image set).", engineLevel: false },
      { name: "artifact", description: "Explicit artifact production.", engineLevel: false }
    ];
  }

  limitations(): string[] {
    return [
      "Embed-page surface only: it is the one official no-auth public view Instagram offers.",
      "Stories, private accounts and most login-walled surfaces fail honestly with requires_auth — UAAL never bypasses them.",
      "Instagram aggressively rate-limits datacenter IPs; from such networks the embed often returns a login redirect. Residential networks (e.g. mobile) fare much better.",
      "Carousel posts expose only the images the embed page includes; the full carousel may be incomplete and is reported as partial."
    ];
  }

  async discoverRoutes(request: ResourceRequest, ctx: RouteDiscoveryContext): Promise<AccessRoute[]> {
    return instagramRoutes(this.http);
  }

  async resolveIdentity(resource: string): Promise<ResourceIdentity> {
    const identity = instagramIdentity(resource);
    if (!identity) throw new Error(`not a public instagram post: ${resource.slice(0, 120)}`);
    return identity;
  }

  async normalize(evidence: Evidence[], request: ResourceRequest, identity: ResourceIdentity): Promise<NormalizedResource> {
    const ev = [...evidence].reverse().find((e) => e.type === "instagram.embed")?.data as (InstagramEmbedData & { shortcode?: string }) | undefined;
    const media: NormalizedMedia[] = [];
    const missing: string[] = [];

    if (ev) {
      if (ev.videoUrl) {
        media.push({ kind: "video", url: ev.videoUrl, mimeType: "video/mp4", thumbnailUrl: ev.thumbnailUrl, downloadable: true });
      }
      for (const img of ev.images) {
        media.push({ kind: "photo", url: img, mimeType: "image/jpeg", downloadable: true });
      }
      if (media.length === 0) {
        missing.push("embed_media");
        if (ev.thumbnailUrl) media.push({ kind: "photo", url: ev.thumbnailUrl, downloadable: false, unavailableReason: "thumbnail_only" });
      }
      if (!ev.caption) missing.push("caption");
    } else {
      missing.push("embed_metadata");
    }

    const raw = evidence.map(({ id, source, type, retrievedAt, reliability }) => ({ id, source, type, retrievedAt, reliability }));

    return {
      schemaVersion: SCHEMA_VERSION,
      platform: "instagram",
      resource: { id: identity.id, url: identity.canonicalUrl, type: "post", platform: "instagram" },
      content: {
        title: ev?.caption?.split("\n")[0],
        text: ev?.caption,
        description: ev?.caption
      },
      author: ev?.username ? { handle: ev.username, url: `https://www.instagram.com/${ev.username}/` } : undefined,
      media,
      relationships: [],
      platformData: {
        source: "instagram-embed",
        isVideo: ev?.isVideo ?? null,
        thumbnail: ev?.thumbnailUrl ?? null,
        raw
      },
      evidence: raw,
      uncertainty: { confidence: ev ? 0.7 : 0.2, missing, notes: [] }
    };
  }

  async verify(resource: NormalizedResource, artifacts: Artifact[]): Promise<VerificationResult> {
    const base = verifyNormalizedResource(resource, { capability: "metadata" });
    const parsed = parseInstagramUrl(resource.resource.url);
    const check = {
      name: "identity_consistency",
      passed: !parsed || parsed.shortcode === resource.resource.id
    };
    const artifactKindOk = artifacts.every((a) => ["video", "photo", "audio", "manifest"].includes(String(a.type)));
    const kindCheck = { name: "artifact_kinds", passed: artifactKindOk };
    return { ...base, checks: [check, kindCheck, ...base.checks], verified: check.passed && kindCheck.passed && base.verified };
  }
}
