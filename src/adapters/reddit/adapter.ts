/**
 * Reddit adapter — public .json endpoints (official public surface, no auth).
 * Included as the extensibility proof: a complete fourth adapter registering
 * platform + capabilities + routes + normalizer + verifier with ZERO core
 * modifications (spec §37, Rule 12).
 */
import type {
  AccessRoute,
  CapabilityDescriptor,
  DetectionResult,
  Evidence,
  ExecutionContext,
  NormalizedMedia,
  NormalizedResource,
  PlatformAdapter,
  ResourceIdentity,
  ResourceRequest,
  RouteDiscoveryContext,
  RouteResult,
  VerificationResult,
  Artifact
} from "../../core/contracts.js";
import { FailureCode, classifyFailure, type Failure } from "../../core/errors.js";
import { getJson, HttpLayer } from "../../core/http.js";
import { makeIdentity } from "../../core/identity.js";
import { SCHEMA_VERSION } from "../../version.js";
import { verifyNormalizedResource } from "../../core/verify/index.js";

const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "np.reddit.com", "v.redd.it"]);

interface RedditListing {
  data?: {
    children?: Array<{ kind?: string; data?: Record<string, unknown> }>;
  };
}

export function parseRedditPost(resource: string): { postId: string; subreddit?: string; slug?: string; canonical: string } | null {
  let url: URL;
  try {
    url = new URL(resource.startsWith("http") ? resource : `https://${resource}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!REDDIT_HOSTS.has(host)) return null;
  if (host === "v.redd.it") {
    const id = url.hostname.replace("v.redd.it", "") && url.pathname.length > 1 ? url.pathname.slice(1) : "";
    // v.redd.it/{id}
    const vid = url.pathname.split("/").filter(Boolean)[0];
    return vid ? { postId: vid, canonical: `https://www.reddit.com/comments/${vid}` } : null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const commentsIdx = segments.indexOf("comments");
  if (commentsIdx >= 0 && segments[commentsIdx + 1]) {
    return {
      postId: segments[commentsIdx + 1],
      subreddit: segments[0] === "r" ? segments[1] : undefined,
      slug: segments[commentsIdx + 2],
      canonical: `https://www.reddit.com/comments/${segments[commentsIdx + 1]}`
    };
  }
  return null;
}

function identityFor(resource: string): ResourceIdentity | null {
  const parsed = parseRedditPost(resource);
  if (!parsed) return null;
  return makeIdentity("reddit", "post", parsed.postId, parsed.canonical, [resource]);
}

export function redditJsonRoute(http: HttpLayer): AccessRoute {
  const id = "reddit.public.json.metadata";
  return {
    id,
    platform: "reddit",
    capabilities: ["metadata", "author", "comments", "thread", "media", "extract"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 85,
    enabled: true,
    accessLevel: "public",
    tags: ["official"],
    description:
      "Reddit public JSON API (https://www.reddit.com/comments/{id}.json). Official public surface: post + comment tree + media inventory. 403/429 surfaces honestly (Reddit blocks some datacenter IPs).",
    estimatedCostMs: 3000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const postId = ctx.identity.id;
      try {
        const { data, res } = await getJson<RedditListing[]>(http, `https://www.reddit.com/comments/${postId}.json?limit=100&raw_json=1`, { timeoutMs: 25_000, maxBytes: 8 * 1024 * 1024 });
        const post = data[0]?.data?.children?.[0]?.data;
        if (!post) {
          return { ok: false, routeId: id, evidence: [], artifacts: [], unavailable: true, failure: { code: FailureCode.INVALID_RESOURCE, message: "post not found in listing", subject: id, retryable: false }, latencyMs: Date.now() - started };
        }
        const comments = (data[1]?.data?.children ?? []).map((c) => c.data ?? {}).filter((d) => d && typeof d === "object");
        const evidence: Evidence = {
          id: `ev_${ctx.hash(`${postId}:reddit:json`)}`,
          source: id,
          type: "reddit.json",
          data: { post, comments, status: res.status },
          retrievedAt: new Date().toISOString(),
          reliability: 0.95,
          provenance: { endpoint: "reddit.com/comments/{id}.json" }
        };
        return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
      } catch (err) {
        const c = classifyFailure(err, id);
        return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: c.code, message: c.message, subject: id, retryable: c.retryable }, latencyMs: Date.now() - started };
      }
    }
  };
}

export class RedditAdapter implements PlatformAdapter {
  readonly id = "reddit" as const;
  private http: HttpLayer;

  constructor(http: HttpLayer) {
    this.http = http;
  }

  detect(resource: string): DetectionResult {
    const id = identityFor(resource);
    if (id) return { matched: true, confidence: 0.97, platform: "reddit", resourceType: "post", detail: id.id };
    return { matched: false, confidence: 0 };
  }

  capabilities(): CapabilityDescriptor[] {
    return [
      { name: "metadata", description: "Post metadata (title, author, score, timestamps).", engineLevel: false },
      { name: "author", description: "Post author.", engineLevel: false },
      { name: "comments", description: "Top-level comment tree (limit 100).", engineLevel: false },
      { name: "thread", description: "Post as single-node thread.", engineLevel: false },
      { name: "media", description: "Preview/gallery/video inventory.", engineLevel: false },
      { name: "extract", description: "Raw reddit payloads in platformData.", engineLevel: false }
    ];
  }

  limitations(): string[] {
    return [
      "Metadata/comments only; media acquisition is not implemented (v.redd.it requires HLS assembly) and is reported as unsupported.",
      "Reddit rate-limits some datacenter IPs aggressively; failures surface as blocked/rate_limit."
    ];
  }

  async discoverRoutes(request: ResourceRequest, ctx: RouteDiscoveryContext): Promise<AccessRoute[]> {
    return [redditJsonRoute(this.http)];
  }

  async resolveIdentity(resource: string): Promise<ResourceIdentity> {
    const id = identityFor(resource);
    if (!id) throw new Error(`not a reddit post: ${resource.slice(0, 120)}`);
    return id;
  }

  async normalize(evidence: Evidence[], request: ResourceRequest, identity: ResourceIdentity): Promise<NormalizedResource> {
    const ev = [...evidence].reverse().find((e) => e.type === "reddit.json")?.data as { post: Record<string, unknown>; comments: Array<Record<string, unknown>> } | undefined;
    const missing: string[] = [];
    if (!ev?.post) missing.push("post");
    const post = ev?.post ?? {};
    const media: NormalizedMedia[] = [];
    const preview = (post.preview as { images?: Array<{ source?: { url?: string; width?: number; height?: number } }> })?.images?.[0]?.source;
    if (preview?.url) media.push({ kind: "photo", url: preview.url.replace(/&amp;/g, "&"), width: preview.width, height: preview.height });
    const redditVideo = (post.secure_media as { reddit_video?: { fallback_url?: string; duration?: number; height?: number; width?: number } })?.reddit_video;
    if (redditVideo?.fallback_url) media.push({ kind: "video", url: redditVideo.fallback_url, durationSec: redditVideo.duration, width: redditVideo.width, height: redditVideo.height, unavailableReason: "hls_dash_only" });
    const gallery = (post.gallery_data as { items?: Array<{ media_id: string }> })?.items ?? [];
    const galleryMeta = (post.media_metadata as Record<string, { s?: { u?: string; mp4?: string } }>) ?? {};
    for (const item of gallery) {
      const m = galleryMeta[item.media_id]?.s;
      const url = m?.mp4 ?? m?.u;
      if (url) media.push({ kind: "photo", url: url.replace(/&amp;/g, "&") });
    }

    const comments = (ev?.comments ?? []).map((c) => ({
      id: String(c.id ?? ""),
      author: String(c.author ?? ""),
      body: String(c.body ?? ""),
      score: typeof c.score === "number" ? c.score : null,
      createdAt: typeof c.created_utc === "number" ? new Date(c.created_utc * 1000).toISOString() : null,
      replies: (c.replies as { data?: { children?: unknown[] } })?.data?.children?.length ?? 0
    }));

    return {
      schemaVersion: SCHEMA_VERSION,
      platform: "reddit",
      resource: { id: identity.id, url: identity.canonicalUrl, type: "post", platform: "reddit" },
      content: {
        title: post.title as string | undefined,
        text: (post.selftext as string) || undefined,
        publishedAt: typeof post.created_utc === "number" ? new Date(post.created_utc * 1000).toISOString() : undefined,
        metrics: { score: (post.score as number) ?? null, upvoteRatio: (post.upvote_ratio as number) ?? null, comments: (post.num_comments as number) ?? null }
      },
      author: post.author ? { handle: post.author as string, url: `https://www.reddit.com/user/${post.author}` } : undefined,
      media,
      relationships: comments.map((c) => ({ type: "comment", from: c.id, to: identity.id })),
      platformData: {
        subreddit: post.subreddit,
        permalink: post.permalink ? `https://www.reddit.com${post.permalink}` : undefined,
        flair: post.link_flair_text ?? null,
        comments,
        commentCount: comments.length
      },
      evidence: evidence.map(({ id: eid, source, type, retrievedAt, reliability }) => ({ id: eid, source, type, retrievedAt, reliability })),
      uncertainty: { confidence: missing.length === 0 ? 0.92 : 0.3, missing, notes: [] }
    };
  }

  async verify(resource: NormalizedResource, artifacts: Artifact[]): Promise<VerificationResult> {
    const base = verifyNormalizedResource(resource, { capability: "metadata" });
    const check = {
      name: "identity_consistency",
      passed: !parseRedditPost(resource.resource.url) || parseRedditPost(resource.resource.url)!.postId === resource.resource.id
    };
    return { ...base, checks: [check, ...base.checks], verified: check.passed && base.verified };
  }
}

export type { Failure };
