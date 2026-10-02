/**
 * Instagram identity parsing — post/reel/tv shortcodes, with or without
 * a username segment. Local-only (zero network) like every identity parser.
 */
import { makeIdentity } from "../../core/identity.js";
import type { ResourceIdentity } from "../../core/contracts.js";

export const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com", "instagr.am", "ig.me"]);

export interface ParsedInstagram {
  kind: "post" | "reel" | "tv" | "story";
  shortcode: string;
  username?: string;
  input: string;
}

export function parseInstagramUrl(resource: string): ParsedInstagram | null {
  let url: URL;
  try {
    url = new URL(resource.startsWith("http") ? resource : `https://${resource}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!INSTAGRAM_HOSTS.has(host)) return null;
  const segments = url.pathname.split("/").filter(Boolean);

  // /p/{code}, /reel/{code}, /tv/{code} — stories are auth-walled and are
  // never parsed (fail-closed at the identity layer).
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = segments[i + 1];
    if ((seg === "p" || seg === "reel" || seg === "tv") && next && /^[A-Za-z0-9_-]{5,32}$/.test(next)) {
      return { kind: seg === "p" ? "post" : seg, shortcode: next, username: i > 0 ? segments[i - 1] : undefined, input: resource };
    }
  }
  return null;
}

export function canonicalInstagramUrl(shortcode: string, kind: string = "p"): string {
  const seg = kind === "reel" || kind === "tv" ? kind : "p";
  return `https://www.instagram.com/${seg}/${shortcode}/`;
}

export function instagramIdentity(resource: string): ResourceIdentity | null {
  const parsed = parseInstagramUrl(resource);
  if (!parsed || parsed.kind === "story") return null; // stories are auth-walled; never pretended
  return makeIdentity("instagram", parsed.kind, parsed.shortcode, canonicalInstagramUrl(parsed.shortcode, parsed.kind), [resource]);
}
