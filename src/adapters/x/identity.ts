/**
 * X identity resolution — generalization of xthread-agent's normalize_input:
 * every x.com/twitter.com URL variant and bare snowflake IDs map to one
 * canonical form; t.co shortlinks expand through redirect AND 200
 * interstitial shapes (parsed, never executed).
 */
import type { ResourceIdentity } from "../../core/contracts.js";
import { makeIdentity } from "../../core/identity.js";

const SUPPORTED_HOSTS = new Set(["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"]);
const STATUS_ID_RE = /^\d{1,25}$/;

export interface ParsedStatus {
  statusId: string;
  canonicalUrl: string;
  input: string;
}

export function parseStatusUrl(raw: string): ParsedStatus | null {
  const input = raw.trim();
  if (STATUS_ID_RE.test(input)) {
    return { statusId: input, canonicalUrl: canonicalStatusUrl(input), input };
  }
  let url: URL;
  try {
    url = new URL(input.startsWith("http") ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!SUPPORTED_HOSTS.has(host)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    if ((segments[i] === "status" || segments[i] === "statuses") && segments[i + 1] && STATUS_ID_RE.test(segments[i + 1])) {
      return { statusId: segments[i + 1], canonicalUrl: canonicalStatusUrl(segments[i + 1]), input };
    }
  }
  return null;
}

export function canonicalStatusUrl(statusId: string): string {
  return `https://x.com/i/web/status/${statusId}`;
}

export function isTcoLink(raw: string): boolean {
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return u.hostname.toLowerCase() === "t.co" && u.pathname.length > 1;
  } catch {
    return false;
  }
}

/**
 * t.co expansion: follows HTTP redirects (final URL) and parses 200
 * interstitials (meta refresh / location.replace) — never executes them.
 */
export async function expandTcoLink(raw: string, httpGet: (url: string, opts: { timeoutMs: number; maxBytes: number }) => Promise<{ status: number; body: Buffer; finalUrl: string }>): Promise<ParsedStatus | null> {
  const target = raw.startsWith("http") ? raw : `https://${raw}`;
  try {
    const res = await httpGet(target, { timeoutMs: 20_000, maxBytes: 64 * 1024 });
    // redirect case: undici manual redirect handled by HttpLayer.get → follow? we get 3xx here only if redirects exhausted; finalUrl is authoritative
    const finalUrl = res.finalUrl;
    const parsed = parseStatusUrl(finalUrl);
    if (parsed) return parsed;
    // interstitial case: parse meta refresh / location.replace
    if (res.status === 200) {
      const html = res.body.toString("utf8");
      const dest = extractInterstitialDest(html);
      if (dest) {
        const parsedDest = parseStatusUrl(dest);
        if (parsedDest) return parsedDest;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function extractInterstitialDest(html: string): string | null {
  const meta = /http-equiv=["']?refresh["']?[^>]*url=([^"'>]+)/i.exec(html);
  if (meta) return decodeEntities(meta[1].trim());
  const replace = /location\.replace\(\s*["']([^"']+)["']\s*\)/i.exec(html);
  if (replace) return decodeEntities(replace[1].replace(/\\\//g, "/"));
  const canonical = /rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i.exec(html);
  if (canonical) return canonical[1];
  return null;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#38;/g, "&");
}

export function xIdentity(raw: string): ResourceIdentity | null {
  const parsed = parseStatusUrl(raw);
  if (!parsed) return null;
  return makeIdentity("x", "thread", parsed.statusId, parsed.canonicalUrl, [raw]);
}
