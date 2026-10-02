/**
 * tikwm.com public mirror client — shared by the TikTok and Douyin
 * adapters (the mirror accepts both tiktok.com and douyin.com share URLs).
 *
 * ytagent/xthread-agent ideology applied:
 * - never raise: callers get a typed result, all failures classified
 * - evidence-first: the raw API payload is returned for provenance
 * - honest failures: private/deleted/rate-limit map to real failure codes,
 *   never to fabricated placeholders
 *
 * NOTE: relative URLs in the response (play/wmplay/music/cover) are
 * normalized against the mirror base.
 */
import { FailureCode, type Failure } from "../../core/errors.js";
import { HttpFailure, type HttpLayer } from "../../core/http.js";

export const TIKWM_BASE = "https://www.tikwm.com";

export interface TikwmAuthor {
  id?: string;
  unique_id?: string;
  nickname?: string;
  avatar?: string;
}

export interface TikwmData {
  id?: string;
  title?: string;
  cover?: string;
  origin_cover?: string;
  duration?: number;
  play?: string;
  wmplay?: string;
  hdplay?: string;
  size?: number;
  wm_size?: number;
  hd_size?: number;
  music?: string;
  images?: string[];
  create_time?: number;
  play_count?: number;
  digg_count?: number;
  comment_count?: number;
  share_count?: number;
  author?: TikwmAuthor;
}

export interface TikwmResponse {
  code?: number;
  msg?: string;
  data?: TikwmData;
  process_time?: number;
}

export interface TikwmCall {
  ok: boolean;
  /** Raw parsed response (provenance evidence). */
  data?: TikwmData;
  raw?: TikwmResponse;
  failure?: Failure;
}

/** Prefix a mirror-relative media path when needed. */
export function absolutizeTikwm(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `${TIKWM_BASE}${url}`;
  return url;
}

/**
 * Query the mirror for a share URL (tiktok.com/... or douyin.com/...).
 * GET https://www.tikwm.com/api/?url={share}&hd=1
 */
export async function fetchTikwm(http: HttpLayer, shareUrl: string, routeId: string, timeoutMs = 25_000): Promise<TikwmCall> {
  const endpoint = `${TIKWM_BASE}/api/?url=${encodeURIComponent(shareUrl)}&hd=1`;
  try {
    const res = await http.get(endpoint, {
      timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      headers: {
        accept: "application/json, text/plain, */*",
        referer: `${TIKWM_BASE}/`
      }
    });
    if (res.status === 429) {
      return { ok: false, failure: { code: FailureCode.RATE_LIMIT, message: "tikwm: rate limited (429)", subject: routeId, retryable: true } };
    }
    if (res.status >= 400) {
      return { ok: false, failure: { code: FailureCode.HTTP_ERROR, message: `tikwm: HTTP ${res.status}`, subject: routeId, retryable: res.status >= 500 } };
    }
    let parsed: TikwmResponse;
    try {
      parsed = JSON.parse(res.body.toString("utf8")) as TikwmResponse;
    } catch {
      return { ok: false, failure: { code: FailureCode.PARSER_FAILURE, message: "tikwm: non-JSON response", subject: routeId, retryable: true } };
    }
    if (typeof parsed.code !== "number") {
      return { ok: false, failure: { code: FailureCode.PARSER_FAILURE, message: "tikwm: response missing code field", subject: routeId, retryable: true } };
    }
    if (parsed.code !== 0) {
      const msg = parsed.msg ?? "unknown mirror error";
      const lower = msg.toLowerCase();
      // Mirror reports private / deleted / invalid content distinctly.
      if (/private|deleted|remove|not found|doesn't exist|does not exist|not available/.test(lower)) {
        return { ok: false, failure: { code: FailureCode.INVALID_RESOURCE, message: `tikwm: ${msg}`, subject: routeId, retryable: false } };
      }
      if (/limit|frequen|too many|spam/.test(lower)) {
        return { ok: false, failure: { code: FailureCode.RATE_LIMIT, message: `tikwm: ${msg}`, subject: routeId, retryable: true } };
      }
      return { ok: false, failure: { code: FailureCode.INVALID_RESOURCE, message: `tikwm: ${msg}`, subject: routeId, retryable: false } };
    }
    if (!parsed.data) {
      return { ok: false, failure: { code: FailureCode.EMPTY_RESULT, message: "tikwm: success but empty payload", subject: routeId, retryable: true } };
    }
    return { ok: true, data: parsed.data, raw: parsed };
  } catch (err) {
    if (err instanceof HttpFailure) {
      return { ok: false, failure: err.toFailure(routeId) };
    }
    return {
      ok: false,
      failure: { code: FailureCode.NETWORK_FAILURE, message: `tikwm: ${(err as Error).message.slice(0, 160)}`, subject: routeId, retryable: true }
    };
  }
}
