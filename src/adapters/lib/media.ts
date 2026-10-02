/**
 * Shared route helpers for media-bearing public routes.
 *
 * Extracted from the x adapter so every public-mirror adapter (tiktok,
 * douyin, instagram, threads, youtube mirrors) uses the SAME hardening:
 * - streaming download through the HttpLayer (SSRF guard, byte cap,
 *   politeness, transfer-integrity check)
 * - artifacts are written into the route sandbox via the ArtifactSink and
 *   registered for verification (fail-closed: a bad download is discarded,
 *   never promoted)
 */
import type { ExecutionContext, RawArtifactRef } from "../../core/contracts.js";
import type { HttpLayer } from "../../core/http.js";

/** Stream a remote URL into the route sandbox and register it as a raw artifact. */
export async function downloadTo(
  ctx: ExecutionContext,
  http: HttpLayer,
  url: string,
  filename: string,
  kind: string,
  maxBytes: number,
  source = "public-mirror"
): Promise<RawArtifactRef | null> {
  const dest = ctx.sink.allocate(filename);
  const stream = await http.stream(url, { timeoutMs: 180_000, maxBytes }).catch((err) => {
    ctx.log.warn("media download failed", { url: url.slice(0, 120), err: (err as Error).message.slice(0, 120) });
    return null;
  });
  if (!stream || !stream.ok) {
    stream?.cancel();
    return null;
  }
  const fsp = await import("node:fs/promises");
  const { open } = await import("node:fs/promises");
  const handle = await open(dest.path, "w");
  let bytes = 0;
  try {
    const res = await stream.pipeTo(
      async (chunk) => {
        await handle.write(chunk);
        bytes += chunk.length;
      },
      maxBytes
    );
    if (res.truncated) {
      ctx.log.warn("media download truncated at cap", { bytes });
      return null;
    }
    // transfer integrity: declared Content-Length must match when present
    const declared = Number(stream.headers["content-length"] ?? 0);
    if (declared > 0 && declared !== bytes) {
      ctx.log.warn("truncated transfer", { bytes, declared });
      return null;
    }
  } finally {
    await handle.close();
  }
  const stat = await fsp.stat(dest.path);
  if (stat.size === 0) return null;
  const ref: RawArtifactRef = { path: dest.path, kind, filename, expectedBytes: stat.size, meta: { source } };
  ctx.sink.register(ref);
  return ref;
}

/* ------------------------------ HTML / JSON string helpers ------------------------------ */

/** Decode \uXXXX, \u0026-style escapes, \/ and common HTML entities. */
export function unescapeJsString(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

export function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** Strip tags + collapse whitespace (captions from embed pages). */
export function stripTags(s: string): string {
  return unescapeHtml(s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract escaped-JSON string fields out of an embed/HTML page. Handles the
 * classic "\\u0026"-escaped JSON blobs platforms inline in their embed HTML.
 * Returns ALL matches (multi-image posts) with JS escapes decoded.
 */
export function extractEscapedJsonField(html: string, field: string): string[] {
  const out: string[] = [];
  const patterns = [
    new RegExp(`\\"${field}\\":\\"(.*?)\\"`, "g"), // JSON-escaped: "field":"value"
    new RegExp(`"${field}":"(.*?)"`, "g"), // plain JSON
    new RegExp(`${field}=\\\\"(.*?)\\\\"`, "g") // double-escaped inline attrs
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const val = unescapeJsString(m[1]);
      if (val && !out.includes(val)) out.push(val);
    }
    if (out.length > 0) break; // first pattern that works wins
  }
  return out;
}

/** Extract the first <meta property="og:..." content="..."> or content attr value. */
export function extractOgField(html: string, property: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  if (!tag) return undefined;
  const content = tag.match(/content=["']([\s\S]*?)["']/i)?.[1];
  return content ? unescapeHtml(content) : undefined;
}

/** Extract window.<anchor> = {...} JSON blobs embedded in a page. */
export function extractWindowJson(html: string, anchor: string): unknown {
  const winRe = new RegExp(`window\\.${anchor}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;?\\s*<`);
  const winMatch = html.match(winRe);
  if (winMatch) {
    try {
      return JSON.parse(winMatch[1]);
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

/** Safe filename fragment from an id. */
export function safeIdFragment(id: string, max = 40): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, max) || "res";
}

/** Guess artifact kind from a URL path + explicit hint. */
export function kindFromUrl(url: string, hintVideo = "video", hintImage = "photo"): string {
  const path = url.split("?")[0].toLowerCase();
  if (/\.(mp4|mov|webm|m4v)$/.test(path)) return hintVideo;
  if (/\.(jpe?g|png|webp|gif|heic)$/.test(path)) return hintImage;
  return hintVideo;
}
