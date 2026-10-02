/**
 * X decoder slots — generalization of xthread-agent Tier 2 (DECODE).
 *
 * Primary: FixTweet public API (api.fxtwitter.com/status/{id}).
 * Fallback: vxtwitter public API normalized into the FixTweet shape with
 * explicit nulls (never fabricated values).
 *
 * Outcome trichotomy (the 404-as-filter-signal pattern):
 *   "ok"          → decoded
 *   "unavailable" → 404/451-class: informative negative, never retried
 *   "failed"      → network/parse errors: fallback + retry applies
 */
import type { Evidence, ExecutionContext } from "../../core/contracts.js";
import { FailureCode } from "../../core/errors.js";
import { HttpFailure, type HttpLayer } from "../../core/http.js";

export type DecodeOutcome = "ok" | "unavailable" | "failed";

export interface FxAuthor {
  screen_name?: string;
  name?: string;
  id?: string;
  avatar_url?: string;
  banner_url?: string;
  description?: string;
  location?: string;
  followers?: number | null;
  following?: number | null;
  media_count?: number;
  verified?: boolean | { verified?: boolean };
  protected?: boolean;
  created_at?: string;
  website?: { url?: string; display_url?: string } | null;
}

export interface FxPhoto {
  url?: string;
  altText?: string;
  alt_text?: string;
  width?: number;
  height?: number;
}

export interface FxVideo {
  url?: string;
  playlist_url?: string | null;
  poster?: string;
  posterUrl?: string;
  format?: string;
  duration?: number;
  width?: number;
  height?: number;
  variants?: Array<{ url: string; container?: string; bitrate?: number; codec?: string }>;
}

export interface FxTweet {
  id?: string | number;
  url?: string;
  text?: string;
  raw_text?: string;
  author?: FxAuthor;
  replies?: number | null;
  retweets?: number | null;
  likes?: number | null;
  bookmarks?: number | null;
  quotes?: number | null;
  views?: number | null;
  created_at?: string;
  created_timestamp?: string;
  lang?: string;
  replying_to?: string;
  replying_to_status?: string | number | null;
  media?: { photos?: FxPhoto[]; videos?: FxVideo[] } | null;
  quote?: FxTweet | null;
  source?: string;
}

export interface DecodeResult {
  outcome: DecodeOutcome;
  tweet?: FxTweet;
  extractionSource?: "fxtwitter" | "vxtwitter";
  message?: string;
}

export async function fetchFxTweet(http: HttpLayer, statusId: string, tries = 3): Promise<DecodeResult> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await http.get(`https://api.fxtwitter.com/status/${statusId}`, { timeoutMs: 25_000, maxBytes: 5 * 1024 * 1024 });
      const body = JSON.parse(res.body.toString("utf8")) as { code?: number; tweet?: FxTweet };
      // body-level 404 (the API answers 200 with code:404) and real 404/451 are "unavailable"
      if (body.code && body.code !== 200 && body.code !== 201) {
        if (body.code === 404) return { outcome: "unavailable", message: `status ${statusId} does not exist (fxtwitter code 404)` };
        throw new HttpFailure(`fxtwitter code ${body.code}`, res.status, FailureCode.HTTP_ERROR);
      }
      if (!body.tweet || body.tweet.id === undefined) {
        throw new Error("fxtwitter payload missing tweet id");
      }
      return { outcome: "ok", tweet: body.tweet, extractionSource: "fxtwitter" };
    } catch (err) {
      if (err instanceof HttpFailure && (err.status === 404 || err.status === 451)) {
        return { outcome: "unavailable", message: `status ${statusId} does not exist (HTTP ${err.status})` };
      }
      if (attempt === tries) {
        return { outcome: "failed", message: `fxtwitter: ${(err as Error).message.slice(0, 160)}` };
      }
      await sleep(300 * attempt);
    }
  }
  return { outcome: "failed", message: "fxtwitter: exhausted retries" };
}

export async function fetchVxTweet(http: HttpLayer, statusId: string, tries = 2): Promise<DecodeResult> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await http.get(`https://api.vxtwitter.com/status/${statusId}`, { timeoutMs: 25_000, maxBytes: 5 * 1024 * 1024 });
      const raw = JSON.parse(res.body.toString("utf8")) as Record<string, unknown>;
      if (!raw.tweetID) {
        throw new Error("vxtwitter payload missing tweetID");
      }
      return { outcome: "ok", tweet: normalizeVx(raw), extractionSource: "vxtwitter" };
    } catch (err) {
      if (err instanceof HttpFailure && (err.status === 404 || err.status === 451)) {
        return { outcome: "unavailable", message: `status ${statusId} does not exist (HTTP ${err.status})` };
      }
      if (attempt === tries) {
        return { outcome: "failed", message: `vxtwitter: ${(err as Error).message.slice(0, 160)}` };
      }
      await sleep(300 * attempt);
    }
  }
  return { outcome: "failed", message: "vxtwitter: exhausted retries" };
}

/** Try both decoder slots in priority order. */
export async function fetchTweet(http: HttpLayer, statusId: string): Promise<DecodeResult> {
  const fx = await fetchFxTweet(http, statusId);
  if (fx.outcome === "ok") return fx;
  if (fx.outcome === "unavailable") return fx; // informative negative propagates
  const vx = await fetchVxTweet(http, statusId);
  if (vx.outcome === "ok") return vx;
  return {
    outcome: "failed",
    message: [fx.message, vx.message].filter(Boolean).join(" | ") || "all decoder slots failed"
  };
}

/** Normalize vxtwitter's shape into FixTweet's, with explicit nulls. */
export function normalizeVx(raw: Record<string, unknown>): FxTweet {
  const media = (raw.media_extended as Array<Record<string, unknown>> | undefined) ?? [];
  const photos: FxPhoto[] = [];
  const videos: FxVideo[] = [];
  for (const m of media) {
    const type = String(m.type ?? "");
    if (type === "photo") {
      photos.push({ url: m.url as string, width: m.size ? undefined : undefined });
    } else if (type === "video" || type === "gif") {
      videos.push({
        url: m.url as string,
        poster: (m.thumbnail_url as string) ?? undefined,
        duration: (m.duration as number) ?? undefined,
        width: (m.size as { width?: number })?.width ?? undefined,
        height: (m.size as { height?: number })?.height ?? undefined
      });
    }
  }
  return {
    id: raw.tweetID as string,
    url: raw.tweetURL as string,
    text: raw.text as string,
    author: {
      screen_name: raw.user_screen_name as string,
      name: raw.user_name as string,
      avatar_url: raw.user_avatar_url as string,
      followers: null
    },
    likes: (raw.likes as number) ?? null,
    retweets: (raw.retweets as number) ?? null,
    replies: (raw.replies as number) ?? null,
    quotes: null,
    bookmarks: null,
    views: null,
    created_at: raw.date as string,
    created_timestamp: raw.date_epoch ? new Date(Number(raw.date_epoch) * 1000).toISOString() : undefined,
    lang: raw.lang as string,
    replying_to: raw.replyingTo as string | undefined,
    replying_to_status: (raw.replyingToID as string | number | null) ?? null,
    media: photos.length > 0 || videos.length > 0 ? { photos, videos } : null,
    quote: raw.qrt ? normalizeVx(raw.qrt as Record<string, unknown>) : null
  };
}

export function tweetEvidence(dec: DecodeResult, statusId: string, ctx: ExecutionContext, tier: string): Evidence {
  return {
    id: `ev_${ctx.hash(`${statusId}:${tier}:${dec.extractionSource}`)}`,
    source: `x.decoder.${tier}`,
    type: dec.extractionSource === "fxtwitter" ? "fxtweet" : "vxtweet",
    data: { ...dec.tweet, _extraction_source: dec.extractionSource, _status_id: statusId },
    retrievedAt: new Date().toISOString(),
    reliability: dec.extractionSource === "fxtwitter" ? 0.9 : 0.75,
    provenance: { decoder: dec.extractionSource, tier }
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
