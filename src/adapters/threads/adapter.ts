/**
 * Threads adapter (Meta Threads) — public embed surface only, with the
 * same fail-closed honesty as the X adapter it shares ideology with.
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
import { threadsIdentity, parseThreadsUrl } from "./identity.js";
import { threadsRoutes, type ThreadsEmbedData } from "./routes.js";

export class ThreadsAdapter implements PlatformAdapter {
  readonly id = "threads" as const;
  private http: HttpLayer;

  constructor(http: HttpLayer) {
    this.http = http;
  }

  detect(resource: string): DetectionResult {
    const parsed = parseThreadsUrl(resource);
    if (parsed) {
      return { matched: true, confidence: 0.95, platform: "threads", resourceType: "post", detail: parsed.postId };
    }
    return { matched: false, confidence: 0 };
  }

  capabilities(): CapabilityDescriptor[] {
    return [
      { name: "metadata", description: "Post text and media inventory from the public embed page.", engineLevel: false },
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
      "Embed-page surface only; login-walled views fail honestly with requires_auth.",
      "Reply chains are not reconstructed (no public thread endpoint); the root post only.",
      "Media URLs come from Meta's CDN and expire quickly — acquire soon after metadata, or re-run."
    ];
  }

  async discoverRoutes(request: ResourceRequest, ctx: RouteDiscoveryContext): Promise<AccessRoute[]> {
    return threadsRoutes(this.http);
  }

  async resolveIdentity(resource: string): Promise<ResourceIdentity> {
    const identity = threadsIdentity(resource);
    if (!identity) throw new Error(`not a threads post: ${resource.slice(0, 120)}`);
    return identity;
  }

  async normalize(evidence: Evidence[], request: ResourceRequest, identity: ResourceIdentity): Promise<NormalizedResource> {
    const ev = [...evidence].reverse().find((e) => e.type === "threads.embed")?.data as (ThreadsEmbedData & { postId?: string }) | undefined;
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
      if (!ev.caption) missing.push("post_text");
    } else {
      missing.push("embed_metadata");
    }

    const raw = evidence.map(({ id, source, type, retrievedAt, reliability }) => ({ id, source, type, retrievedAt, reliability }));

    return {
      schemaVersion: SCHEMA_VERSION,
      platform: "threads",
      resource: { id: identity.id, url: identity.canonicalUrl, type: "post", platform: "threads" },
      content: {
        title: ev?.caption?.split("\n")[0],
        text: ev?.caption,
        description: ev?.caption
      },
      author: ev?.username ? { handle: ev.username, url: `https://www.threads.net/@${ev.username}` } : undefined,
      media,
      relationships: [],
      platformData: {
        source: "threads-embed",
        thumbnail: ev?.thumbnailUrl ?? null,
        raw
      },
      evidence: raw,
      uncertainty: { confidence: ev ? 0.65 : 0.2, missing, notes: [] }
    };
  }

  async verify(resource: NormalizedResource, artifacts: Artifact[]): Promise<VerificationResult> {
    const base = verifyNormalizedResource(resource, { capability: "metadata" });
    const parsed = parseThreadsUrl(resource.resource.url);
    const check = {
      name: "identity_consistency",
      passed: !parsed || parsed.postId === resource.resource.id
    };
    const artifactKindOk = artifacts.every((a) => ["video", "photo", "audio", "manifest"].includes(String(a.type)));
    const kindCheck = { name: "artifact_kinds", passed: artifactKindOk };
    return { ...base, checks: [check, kindCheck, ...base.checks], verified: check.passed && kindCheck.passed && base.verified };
  }
}
