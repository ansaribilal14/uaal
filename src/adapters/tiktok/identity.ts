/**
 * TikTok identity parsing — xthread-agent style: parse locally first
 * (zero network), and only go to the network for short-link resolution
 * (vm.tiktok.com / vt.tiktok.com / tiktok.com/t/).
 */
import { makeIdentity } from "../../core/identity.js";
import type { ResourceIdentity } from "../../core/contracts.js";

export const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com"
]);

export interface ParsedTikTok {
  kind: "video" | "photo" | "short";
  /** Numeric 19-ish-digit item id (undefined for short links). */
  itemId?: string;
  /** Short-link code (undefined for canonical links). */
  shortCode?: string;
  /** The input URL (for short links this is NOT canonical yet). */
  input: string;
  /** Canonical share URL used when querying mirrors (input if short). */
  shareUrl: string;
}

export function parseTikTokUrl(resource: string): ParsedTikTok | null {
  let url: URL;
  try {
    url = new URL(resource.startsWith("http") ? resource : `https://${resource}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!TIKTOK_HOSTS.has(host)) return null;

  const segments = url.pathname.split("/").filter(Boolean);

  // vm.tiktok.com/{code} | vt.tiktok.com/{code}
  if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
    const code = segments[0];
    return code ? { kind: "short", shortCode: code, input: resource, shareUrl: `https://vm.tiktok.com/${code}` } : null;
  }

  // tiktok.com/t/{code}
  if (segments[0] === "t" && segments[1]) {
    return { kind: "short", shortCode: segments[1], input: resource, shareUrl: `https://www.tiktok.com/t/${segments[1]}` };
  }

  // m.tiktok.com/v/{id}.html  (old mobile share)
  if (host === "m.tiktok.com" && segments[0] === "v") {
    const id = (segments[1] ?? "").replace(/\.html$/, "");
    if (/^\d{6,32}$/.test(id)) {
      return { kind: "video", itemId: id, input: resource, shareUrl: `https://www.tiktok.com/@tiktok/video/${id}` };
    }
    return null;
  }

  // www.tiktok.com/@user/video/{id} | /photo/{id} | /v/{id}
  const atIdx = segments.findIndex((s) => s.startsWith("@"));
  if (atIdx >= 0) {
    const kindSeg = segments[atIdx + 1];
    const id = segments[atIdx + 2];
    if (id && /^\d{6,32}$/.test(id) && (kindSeg === "video" || kindSeg === "photo" || kindSeg === "v")) {
      return {
        kind: kindSeg === "photo" ? "photo" : "video",
        itemId: id,
        input: resource,
        shareUrl: `https://www.tiktok.com/@u/${kindSeg === "photo" ? "photo" : "video"}/${id}`
      };
    }
  }

  // www.tiktok.com/video/{id} (rare, link-in-bio style)
  const videoIdx = segments.indexOf("video");
  if (videoIdx >= 0 && segments[videoIdx + 1] && /^\d{6,32}$/.test(segments[videoIdx + 1])) {
    const id = segments[videoIdx + 1];
    return { kind: "video", itemId: id, input: resource, shareUrl: `https://www.tiktok.com/@u/video/${id}` };
  }

  return null;
}

export function canonicalTikTokUrl(itemId: string): string {
  return `https://www.tiktok.com/@tiktok/video/${itemId}`;
}

/**
 * Resolve the identity. Short links need ONE redirect-following GET to
 * learn the canonical URL + item id; canonical links stay offline.
 */
export async function resolveTikTokIdentity(resource: string, resolveShort: (shareUrl: string) => Promise<string | null>): Promise<ResourceIdentity | null> {
  const parsed = parseTikTokUrl(resource);
  if (!parsed) return null;

  if (parsed.itemId) {
    return makeIdentity("tiktok", "post", parsed.itemId, canonicalTikTokUrl(parsed.itemId), [resource]);
  }

  const finalUrl = await resolveShort(parsed.shareUrl);
  if (!finalUrl) return null;
  const resolved = parseTikTokUrl(finalUrl);
  if (resolved?.itemId) {
    return makeIdentity("tiktok", "post", resolved.itemId, canonicalTikTokUrl(resolved.itemId), [resource, finalUrl]);
  }
  // Unresolvable short link: identity keyed by short code (routes still work
  // because mirrors accept the share URL itself).
  return makeIdentity("tiktok", "post", `short:${parsed.shortCode}`, parsed.shareUrl, [resource]);
}
