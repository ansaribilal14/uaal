/**
 * X thread reconstruction — generalization of xthread-agent
 * reconstruct_thread.
 *
 * INVARIANT: chain membership is decided by the `replying_to_status` data
 * relation, NEVER by walker page order. The walker's list is only a
 * candidate spine. Unrelated content (same-author recommendations,
 * other-author replies) is excluded and counted.
 *
 * Honest stops: an unavailable parent ends the ancestor walk — the system
 * never guesses ancestry it cannot verify.
 */
import type { Evidence, NormalizedContent, NormalizedMedia, NormalizedRelationship, NormalizedResource } from "../../core/contracts.js";
import { SCHEMA_VERSION } from "../../version.js";
import { canonicalStatusUrl } from "./identity.js";
import type { FxTweet } from "./decoders.js";

export interface ReconstructionInput {
  rootId: string;
  decoded: Map<string, FxTweet>;
  sources: Map<string, string>; // statusId -> extraction source
  walkerSlot: string;
  walkerCandidates: number;
  filtered: number;
  decodeFailed: number;
  maxAncestors?: number;
}

export interface ReconstructionOutput {
  chain: FxTweet[];
  relationships: NormalizedRelationship[];
  degradedToRootOnly: boolean;
  ancestorsFetched: number;
  chainReconstructed: boolean;
}

export function reconstructThread(input: ReconstructionInput): ReconstructionOutput {
  const { rootId, decoded } = input;
  const maxAncestors = input.maxAncestors ?? 25;

  const root = decoded.get(rootId);
  const rootHandle = (root?.author?.screen_name ?? "").toLowerCase();
  const chain: FxTweet[] = [];
  const relationships: NormalizedRelationship[] = [];
  let ancestorsFetched = 0;
  let degradedToRootOnly = false;

  if (!root) {
    return { chain: [], relationships: [], degradedToRootOnly: true, ancestorsFetched: 0, chainReconstructed: false };
  }

  // ---- walk UP the self-reply chain (ancestors) ----
  const ancestors: FxTweet[] = [];
  const seen = new Set<string>([rootId]);
  let cursor: FxTweet | undefined = root;
  while (ancestors.length < maxAncestors) {
    const parentId = cursor?.replying_to_status != null ? String(cursor.replying_to_status) : null;
    if (!parentId || seen.has(parentId)) break;
    const parent = decoded.get(parentId);
    if (!parent) break; // cannot verify ancestry — stop honestly
    if ((parent.author?.screen_name ?? "").toLowerCase() !== rootHandle) break; // crossed out of the self-reply chain
    ancestors.push(parent);
    seen.add(parentId);
    ancestorsFetched += 1;
    cursor = parent;
  }

  // ---- walk DOWN: children index by replying_to_status, self-author only ----
  const children = new Map<string, FxTweet[]>();
  for (const [id, t] of decoded) {
    if (id === rootId) continue;
    if ((t.author?.screen_name ?? "").toLowerCase() !== rootHandle) continue;
    const pid = t.replying_to_status != null ? String(t.replying_to_status) : null;
    if (!pid) continue;
    const list = children.get(pid) ?? [];
    list.push(t);
    children.set(pid, list);
  }

  const down: FxTweet[] = [];
  let current: FxTweet = root;
  const downSeen = new Set<string>([rootId]);
  while (true) {
    const kids = (children.get(String(current.id)) ?? []).filter((k) => !downSeen.has(String(k.id)));
    if (kids.length === 0) break;
    const next = kids[0]; // linear chain approximation: first-seen branch (documented limitation)
    downSeen.add(String(next.id));
    down.push(next);
    current = next;
  }

  chain.push(...ancestors.slice().reverse(), root, ...down);

  // relationships from the data relation (positions are chain positions)
  for (let i = 0; i < chain.length; i++) {
    if (i === 0) continue;
    relationships.push({ type: "self-reply", from: String(chain[i].id), to: String(chain[i - 1].id), position: i });
  }

  const chainReconstructed = chain.length > 1;
  degradedToRootOnly = chain.length === 1 && input.walkerCandidates > 1;

  return { chain, relationships, degradedToRootOnly, ancestorsFetched, chainReconstructed };
}

/** Build the normalized resource for a reconstructed chain (spec §15). */
export function normalizeThread(
  input: ReconstructionInput,
  output: ReconstructionOutput,
  evidence: Evidence[],
  identity: { id: string; canonicalUrl: string }
): NormalizedResource {
  const notes: NormalizedResource["uncertainty"]["notes"] = [];
  const missing: string[] = [];

  const textOf = (t: FxTweet): string => (typeof t.raw_text === "string" ? t.raw_text : (t.text ?? ""));
  const posts = output.chain.map((t, index) => ({
    id: String(t.id),
    url: canonicalStatusUrl(String(t.id)),
    text: textOf(t),
    lang: t.lang ?? undefined,
    createdAt: t.created_timestamp ?? isoFromLegacy(t.created_at) ?? undefined,
    threadPosition: index,
    replyingTo: t.replying_to ?? undefined,
    replyingToStatus: t.replying_to_status != null ? String(t.replying_to_status) : undefined,
    extractionSource: input.sources.get(String(t.id)) ?? undefined,
    author: mapAuthor(t.author),
    metrics: {
      likes: t.likes ?? null,
      retweets: t.retweets ?? null,
      replies: t.replies ?? null,
      quotes: t.quotes ?? null,
      bookmarks: t.bookmarks ?? null,
      views: t.views ?? null
    },
    media: mapMedia(t)
  }));

  if (posts.length === 0) missing.push("posts");
  if (output.degradedToRootOnly) {
    notes.push({ code: "thread.degraded", message: "walker found candidates but the chain could not be reconstructed; degraded to root only", severity: "warn" });
  }
  if (input.decodeFailed > 0) {
    notes.push({ code: "thread.decode_failed", message: `${input.decodeFailed} candidate(s) failed to decode`, severity: "warn" });
  }
  if (input.filtered > 0) {
    notes.push({ code: "thread.filtered", message: `${input.filtered} unrelated candidate(s) excluded by chain membership rules`, severity: "info" });
  }

  const root = output.chain[0];
  const mediaFlat = posts.flatMap((p) => p.media) as unknown as NormalizedMedia[];
  const content: NormalizedContent = {
    text: root ? textOf(root) : "",
    publishedAt: root?.created_timestamp ?? undefined,
    metrics: root ? { likes: root.likes ?? null, retweets: root.retweets ?? null, views: root.views ?? null } : {}
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    platform: "x",
    resource: { id: identity.id, url: canonicalStatusUrl(identity.id), type: "thread", platform: "x" },
    content,
    author: root ? mapAuthor(root.author) : undefined,
    media: mediaFlat,
    relationships: output.relationships,
    platformData: {
      thread: {
        rootStatusId: identity.id,
        tweetCount: output.chain.length,
        walkerCandidates: input.walkerCandidates,
        decodedTweets: input.decoded.size,
        mediaIdsFiltered: input.filtered,
        decodeFailed: input.decodeFailed,
        relatedFiltered: input.filtered,
        ancestorsFetched: output.ancestorsFetched,
        chainReconstructed: output.chainReconstructed,
        degradedToRootOnly: output.degradedToRootOnly,
        walkerSlot: input.walkerSlot
      },
      posts
    },
    evidence: evidence.map(({ id, source, type, retrievedAt, reliability }) => ({ id, source, type, retrievedAt, reliability })),
    uncertainty: {
      confidence: output.chainReconstructed ? 0.9 : 0.5,
      missing,
      notes
    }
  };
}

export function mapAuthor(author: FxTweet["author"]): Record<string, unknown> {
  if (!author) return {};
  return {
    handle: author.screen_name ?? null,
    name: author.name ?? null,
    id: author.id ?? null,
    url: author.screen_name ? `https://x.com/${author.screen_name}` : null,
    avatarUrl: author.avatar_url ?? null,
    verified: typeof author.verified === "object" ? !!author.verified?.verified : !!author.verified,
    followers: author.followers ?? null,
    protected: author.protected ?? null,
    description: author.description ?? null
  };
}

export function mapMedia(tweet: FxTweet): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const p of tweet.media?.photos ?? []) {
    out.push({ kind: "photo", url: p.url ?? null, mimeType: p.url?.includes(".png") ? "image/png" : "image/jpeg" });
  }
  for (const v of tweet.media?.videos ?? []) {
    const mp4 = pickBestMp4(v);
    out.push({
      kind: "video",
      url: mp4?.url ?? v.url ?? null,
      mimeType: "video/mp4",
      durationSec: v.duration ?? null,
      width: v.width ?? null,
      height: v.height ?? null,
      thumbnailUrl: v.poster ?? v.posterUrl ?? null,
      downloadable: !!mp4,
      unavailableReason: mp4 ? undefined : "hls_only",
      variants: (v.variants ?? []).slice(0, 10)
    });
  }
  return out;
}

function pickBestMp4(v: { url?: string; variants?: Array<{ url: string; container?: string; bitrate?: number }> }): { url: string; bitrate?: number } | null {
  if (v.url && /\.mp4($|\?)/.test(v.url)) return { url: v.url };
  const mp4s = (v.variants ?? []).filter((c) => (c.container ?? (c.url.split(".").pop() ?? "")) === "mp4" || /\.mp4($|\?)/.test(c.url));
  if (mp4s.length === 0) return null;
  mp4s.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return { url: mp4s[0].url, bitrate: mp4s[0].bitrate };
}

function isoFromLegacy(v: string | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
