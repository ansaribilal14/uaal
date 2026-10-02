/**
 * Threads identity parsing (threads.net / threads.com).
 * URL forms: threads.net/@user/post/{code}, threads.com/@user/post/{code},
 * with optional query tails.
 */
import { makeIdentity } from "../../core/identity.js";
import type { ResourceIdentity } from "../../core/contracts.js";

export const THREADS_HOSTS = new Set(["threads.net", "www.threads.net", "threads.com", "www.threads.com"]);

export interface ParsedThreads {
  username: string;
  postId: string;
  input: string;
}

export function parseThreadsUrl(resource: string): ParsedThreads | null {
  let url: URL;
  try {
    url = new URL(resource.startsWith("http") ? resource : `https://${resource}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!THREADS_HOSTS.has(host)) return null;
  const segments = url.pathname.split("/").filter(Boolean);

  // /@user/post/{code}
  const atIdx = segments.findIndex((s) => s.startsWith("@"));
  if (atIdx >= 0 && segments[atIdx + 1] === "post" && segments[atIdx + 2]) {
    return { username: segments[atIdx].slice(1), postId: segments[atIdx + 2], input: resource };
  }
  return null;
}

export function canonicalThreadsUrl(username: string, postId: string): string {
  return `https://www.threads.net/@${username}/post/${postId}`;
}

export function threadsIdentity(resource: string): ResourceIdentity | null {
  const parsed = parseThreadsUrl(resource);
  if (!parsed) return null;
  return makeIdentity("threads", "post", parsed.postId, canonicalThreadsUrl(parsed.username, parsed.postId), [resource]);
}
