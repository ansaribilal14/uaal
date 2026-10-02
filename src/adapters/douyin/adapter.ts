/**
 * Douyin adapter — public share-page metadata + mirror-mediated
 * acquisition. No credentials, no auth-wall bypass, honest failures.
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
import { makeIdentity } from "../../core/identity.js";
import { SCHEMA_VERSION } from "../../version.js";
import { verifyNormalizedResource } from "../../core/verify/index.js";
import { parseDouyinUrl, resolveDouyinIdentity } from "./identity.js";
import { douyinRoutes, douyinCoverUrl, playAddrUrl, type DouyinItem } from "./routes.js";

export class DouyinAdapter implements PlatformAdapter {
  readonly id = "douyin" as const;
  private http: HttpLayer;

  constructor(http: HttpLayer) {
    this.http = http;
  }

  detect(resource: string): DetectionResult {
    const parsed = parseDouyinUrl(resource);
    if (parsed) {
      return { matched: true, confidence: 0.96, platform: "douyin", resourceType: "post", detail: parsed.itemId ?? `short:${parsed.shortCode}` };
    }
    return { matched: false, confidence: 0 };
  }

  capabilities(): CapabilityDescriptor[] {
    return [
      { name: "metadata", description: "Description, duration and engagement statistics from the mobile share page.", engineLevel: false },
      { name: "author", description: "Author nickname and unique id.", engineLevel: false },
      { name: "media", description: "Play address and cover inventory from _ROUTER_DATA.", engineLevel: false },
      { name: "media_metadata", description: "Per-media details: duration, cover, ratio.", engineLevel: false },
      { name: "extract", description: "Raw share-page item record in platformData.", engineLevel: false },
      { name: "acquire", description: "Verified MP4 acquisition via the tikwm mirror.", engineLevel: false },
      { name: "artifact", description: "Explicit artifact production.", engineLevel: false },
      { name: "resolve", description: "v.douyin.com short-link resolution.", engineLevel: false }
    ];
  }

  limitations(): string[] {
    return [
      "Public posts only: private, friends-only and age-gated content fails honestly.",
      "The share page sometimes demands a captcha from datacenter IPs; on such networks metadata fails with a blocked reason (never bypassed).",
      "Acquisition depends on the tikwm public mirror; watermark-free quality is limited to what the mirror serves.",
      "Comments and profile feeds are not exposed by any public route yet."
    ];
  }

  async discoverRoutes(request: ResourceRequest, ctx: RouteDiscoveryContext): Promise<AccessRoute[]> {
    return douyinRoutes(this.http);
  }

  async resolveIdentity(resource: string): Promise<ResourceIdentity> {
    const identity = await resolveDouyinIdentity(resource, async (shareUrl) => {
      try {
        const res = await this.http.get(shareUrl, { timeoutMs: 15_000, maxBytes: 64 * 1024 });
        return res.finalUrl ?? null;
      } catch {
        return null;
      }
    });
    if (!identity) throw new Error(`not a douyin post: ${resource.slice(0, 120)}`);
    return identity;
  }

  async normalize(evidence: Evidence[], request: ResourceRequest, identity: ResourceIdentity): Promise<NormalizedResource> {
    const shareEv = [...evidence].reverse().find((e) => e.type === "douyin.router_data")?.data as { item?: DouyinItem } | undefined;
    const acquireEv = [...evidence].reverse().find((e) => e.type === "douyin.acquire")?.data as
      | { itemId?: string; title?: string | null; author?: string | null; durationSec?: number | null }
      | undefined;

    const item = shareEv?.item;
    const media: NormalizedMedia[] = [];
    const missing: string[] = [];

    if (item) {
      const { url: playUrl } = playAddrUrl(item);
      const cover = douyinCoverUrl(item);
      if (playUrl) {
        media.push({
          kind: "video",
          url: playUrl,
          durationSec: typeof item.video?.duration === "number" ? item.video.duration : undefined,
          thumbnailUrl: cover,
          downloadable: true
        });
      } else {
        missing.push("play_addr");
      }
      if (cover) media.push({ kind: "photo", url: cover, downloadable: false, unavailableReason: "cover_only" });
    } else {
      missing.push("share_page_metadata");
    }

    const raw = evidence.map(({ id, source, type, retrievedAt, reliability }) => ({ id, source, type, retrievedAt, reliability }));

    return {
      schemaVersion: SCHEMA_VERSION,
      platform: "douyin",
      resource: { id: identity.id, url: identity.canonicalUrl, type: "post", platform: "douyin" },
      content: {
        title: item?.desc ?? acquireEv?.title ?? undefined,
        description: item?.desc ?? acquireEv?.title ?? undefined,
        publishedAt: item?.create_time ? new Date(item.create_time * 1000).toISOString() : undefined,
        metrics: item?.statistics
          ? {
              likes: item.statistics.digg_count ?? null,
              comments: item.statistics.comment_count ?? null,
              shares: item.statistics.share_count ?? null,
              plays: item.statistics.play_count ?? null,
              collects: item.statistics.collect_count ?? null
            }
          : {}
      },
      author: item?.author?.unique_id
        ? { handle: item.author.unique_id, displayName: item.author.nickname, url: `https://www.douyin.com/user/${item.author.unique_id}` }
        : item?.author?.nickname
          ? { handle: item.author.nickname, displayName: item.author.nickname }
          : acquireEv?.author
            ? { handle: acquireEv.author }
            : undefined,
      media,
      relationships: [],
      platformData: {
        source: item ? "iesdouyin-share" : acquireEv ? "tikwm-mirror" : "none",
        playAddr: item ? playAddrUrl(item) : null,
        cover: item ? (douyinCoverUrl(item) ?? null) : null,
        durationSec: item?.video?.duration ?? acquireEv?.durationSec ?? null,
        raw
      },
      evidence: raw,
      uncertainty: { confidence: item ? 0.8 : acquireEv ? 0.5 : 0.25, missing, notes: [] }
    };
  }

  async verify(resource: NormalizedResource, artifacts: Artifact[]): Promise<VerificationResult> {
    const base = verifyNormalizedResource(resource, { capability: "metadata" });
    const parsed = parseDouyinUrl(resource.resource.url);
    const check = {
      name: "identity_consistency",
      passed: !parsed?.itemId || parsed.itemId === resource.resource.id
    };
    const artifactKindOk = artifacts.every((a) => ["video", "photo", "audio", "manifest"].includes(String(a.type)));
    const kindCheck = { name: "artifact_kinds", passed: artifactKindOk };
    return { ...base, checks: [check, kindCheck, ...base.checks], verified: check.passed && kindCheck.passed && base.verified };
  }
}
