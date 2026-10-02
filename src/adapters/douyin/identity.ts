/**
 * Douyin identity parsing (douyin.com / iesdouyin.com / v.douyin.com).
 * Same local-first ideology as the TikTok adapter: only short links
 * need one network hop to resolve.
 */
import { makeIdentity } from "../../core/identity.js";
import type { ResourceIdentity } from "../../core/contracts.js";

export const DOUYIN_HOSTS = new Set(["douyin.com", "www.douyin.com", "v.douyin.com", "iesdouyin.com", "www.iesdouyin.com"]);

export interface ParsedDouyin {
  kind: "video" | "note" | "short";
  /** Numeric aweme id (undefined for short links). */
  itemId?: string;
  shortCode?: string;
  input: string;
  /** Share URL used when querying mirrors / the mobile share page. */
  shareUrl: string;
}

export function parseDouyinUrl(resource: string): ParsedDouyin | null {
  let url: URL;
  try {
    url = new URL(resource.startsWith("http") ? resource : `https://${resource}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!DOUYIN_HOSTS.has(host)) return null;
  const segments = url.pathname.split("/").filter(Boolean);

  // v.douyin.com/{code}/ — short share link
  if (host === "v.douyin.com") {
    const code = segments[0];
    return code ? { kind: "short", shortCode: code, input: resource, shareUrl: `https://v.douyin.com/${code}` } : null;
  }

  const typeIdx = segments.findIndex((s) => s === "video" || s === "note");
  if (typeIdx >= 0 && segments[typeIdx + 1] && /^\d{6,32}$/.test(segments[typeIdx + 1])) {
    const id = segments[typeIdx + 1];
    const kind = segments[typeIdx] === "note" ? "note" : "video";
    return { kind, itemId: id, input: resource, shareUrl: `https://www.iesdouyin.com/share/${kind}/${id}` };
  }

  return null;
}

export function canonicalDouyinUrl(itemId: string): string {
  return `https://www.douyin.com/video/${itemId}`;
}

export async function resolveDouyinIdentity(resource: string, resolveShort: (shareUrl: string) => Promise<string | null>): Promise<ResourceIdentity | null> {
  const parsed = parseDouyinUrl(resource);
  if (!parsed) return null;

  if (parsed.itemId) {
    return makeIdentity("douyin", "post", parsed.itemId, canonicalDouyinUrl(parsed.itemId), [resource]);
  }

  const finalUrl = await resolveShort(parsed.shareUrl);
  if (!finalUrl) return null;
  const resolved = parseDouyinUrl(finalUrl);
  if (resolved?.itemId) {
    return makeIdentity("douyin", "post", resolved.itemId, canonicalDouyinUrl(resolved.itemId), [resource, finalUrl]);
  }
  return makeIdentity("douyin", "post", `short:${parsed.shortCode}`, parsed.shareUrl, [resource]);
}
