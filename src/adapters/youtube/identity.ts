/**
 * YouTube identity resolution — generalization of ytagent's URL
 * canonicalization: every YouTube URL shape and bare IDs map to one
 * canonical identity (11-char video id).
 */
import type { ResourceIdentity } from "../../core/contracts.js";
import { makeIdentity } from "../../core/identity.js";

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const PATH_PATTERNS: RegExp[] = [
  /\/embed\/([A-Za-z0-9_-]{11})/,
  /\/shorts\/([A-Za-z0-9_-]{11})/,
  /\/v\/([A-Za-z0-9_-]{11})/,
  /\/live\/([A-Za-z0-9_-]{11})/
];

const QUERY_KEYS = ["v", "vi"];

export function parseYouTubeVideoId(raw: string): string | null {
  const input = raw.trim();
  if (VIDEO_ID_RE.test(input)) return input;
  let url: URL;
  try {
    url = new URL(input.startsWith("http") ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com" && host !== "youtube-nocookie.com" && host !== "youtu.be") {
    return null;
  }
  if (host === "youtu.be") {
    const seg = url.pathname.split("/").filter(Boolean)[0];
    return seg && VIDEO_ID_RE.test(seg) ? seg : null;
  }
  for (const key of QUERY_KEYS) {
    const val = url.searchParams.get(key);
    if (val && VIDEO_ID_RE.test(val)) return val;
  }
  for (const re of PATH_PATTERNS) {
    const m = re.exec(url.pathname);
    if (m) return m[1];
  }
  return null;
}

export function canonicalWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function youtubeIdentity(raw: string): ResourceIdentity | null {
  const id = parseYouTubeVideoId(raw);
  if (!id) return null;
  return makeIdentity("youtube", "video", id, canonicalWatchUrl(id), [raw]);
}
