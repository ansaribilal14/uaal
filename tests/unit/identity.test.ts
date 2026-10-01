import { describe, it, expect } from "vitest";
import { parseYouTubeVideoId, canonicalWatchUrl } from "../../src/adapters/youtube/identity.js";
import { parseStatusUrl, isTcoLink, xIdentity, extractInterstitialDest } from "../../src/adapters/x/identity.js";
import { parseRedditPost } from "../../src/adapters/reddit/adapter.js";
import { extractHtmlMetadata } from "../../src/adapters/generic-web/adapter.js";
import { PlatformRegistry } from "../../src/core/identity.js";
import { getBuiltinAdapters } from "../../src/adapters/index.js";
import { fingerprintIdentity } from "../../src/core/identity.js";

describe("youtube identity", () => {
  const CASES: Array<[string, string]> = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?vi=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"]
  ];
  for (const [input, expected] of CASES) {
    it(`parses ${input}`, () => {
      expect(parseYouTubeVideoId(input)).toBe(expected);
    });
  }
  it("rejects non-youtube hosts and bad ids", () => {
    expect(parseYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseYouTubeVideoId("https://youtu.be/short")).toBeNull();
    expect(parseYouTubeVideoId("")).toBeNull();
    expect(parseYouTubeVideoId("https://youtube.com/watch?v=has!nvalid")).toBeNull();
  });
  it("canonicalizes", () => {
    expect(canonicalWatchUrl("abc123")).toBe("https://www.youtube.com/watch?v=abc123");
  });
});

describe("x identity", () => {
  const CASES: Array<[string, string]> = [
    ["https://x.com/jack/status/20", "20"],
    ["https://twitter.com/jack/status/20", "20"],
    ["https://mobile.twitter.com/jack/status/20", "20"],
    ["https://x.com/jack/status/20/video/1", "20"],
    ["https://x.com/jack/status/20?foo=bar", "20"],
    ["https://x.com/i/web/status/1234567890123456789", "1234567890123456789"],
    ["x.com/jack/statuses/20", "20"],
    ["123456789012345678", "123456789012345678"]
  ];
  for (const [input, expected] of CASES) {
    it(`parses ${input}`, () => {
      expect(parseStatusUrl(input)?.statusId).toBe(expected);
    });
  }
  it("rejects profile urls, garbage, oversized ids", () => {
    expect(parseStatusUrl("https://x.com/jack")).toBeNull();
    expect(parseStatusUrl("https://x.com/hashtag/foo")).toBeNull();
    expect(parseStatusUrl("https://example.com/status/20")).toBeNull();
    expect(parseStatusUrl("123456789012345678901234567890123456")).toBeNull();
  });
  it("detects t.co links", () => {
    expect(isTcoLink("https://t.co/abc123")).toBe(true);
    expect(isTcoLink("https://example.com/x")).toBe(false);
  });
  it("parses interstitial destinations", () => {
    expect(extractInterstitialDest(`<noscript><meta http-equiv="refresh" content="0; url=https://x.com/jack/status/20"></noscript>`)).toBe("https://x.com/jack/status/20");
    expect(extractInterstitialDest(`<script>location.replace("https:\\/\\/x.com\\/jack\\/status\\/20")</script>`)).toBe("https://x.com/jack/status/20");
    expect(extractInterstitialDest("<html>nothing</html>")).toBeNull();
  });
  it("builds identity with canonical url", () => {
    const id = xIdentity("https://twitter.com/jack/status/20");
    expect(id?.canonicalUrl).toBe("https://x.com/i/web/status/20");
    expect(id?.platform).toBe("x");
  });
});

describe("reddit identity", () => {
  it("parses comment urls", () => {
    expect(parseRedditPost("https://www.reddit.com/r/node/comments/1abc123/title_slug/")?.postId).toBe("1abc123");
    expect(parseRedditPost("https://old.reddit.com/comments/1abc123")?.postId).toBe("1abc123");
    expect(parseRedditPost("https://example.com/comments/1abc123")).toBeNull();
  });
});

describe("generic-web detection + extraction", () => {
  it("extracts OG/Twitter/JSON-LD metadata", () => {
    const html = `<!doctype html><html><head>
      <title>Fallback Title</title>
      <meta property="og:title" content="OG Title">
      <meta name="description" content="Meta description">
      <meta property="og:image" content="https://example.com/img.png">
      <meta property="article:published_time" content="2024-01-01T00:00:00Z">
      <script type="application/ld+json">{"@type":"Article"}</script>
    </head><body></body></html>`;
    const meta = extractHtmlMetadata(html);
    expect(meta.title).toBe("OG Title");
    expect(meta.description).toBe("Meta description");
    expect(meta.image).toBe("https://example.com/img.png");
    expect(meta.publishedTime).toBe("2024-01-01T00:00:00Z");
    expect((meta.jsonLd ?? []).length).toBe(1);
  });
  it("decodes entities", () => {
    const meta = extractHtmlMetadata(`<meta property="og:title" content="A &amp; B &#39;C&#39;">`);
    expect(meta.title).toBe(`A & B 'C'`);
  });
});

describe("platform registry", () => {
  const registry = new PlatformRegistry();
  for (const a of getBuiltinAdapters({})) registry.register(a);
  it("routes urls to the most specific adapter (generic-web last)", () => {
    expect(registry.detect("https://www.youtube.com/watch?v=dQw4w9WgXcQ").adapter?.id).toBe("youtube");
    expect(registry.detect("https://x.com/jack/status/20").adapter?.id).toBe("x");
    expect(registry.detect("https://www.reddit.com/r/n/comments/1abc123/x/").adapter?.id).toBe("reddit");
    expect(registry.detect("https://example.com/page").adapter?.id).toBe("generic-web");
  });
  it("refuses duplicate registration", () => {
    expect(() => registry.register(getBuiltinAdapters({})[0])).toThrow(/already registered/);
  });
  it("stable fingerprints", () => {
    expect(fingerprintIdentity("x", "thread", "20")).toBe(fingerprintIdentity("x", "thread", "20"));
    expect(fingerprintIdentity("x", "thread", "20")).not.toBe(fingerprintIdentity("x", "thread", "21"));
  });
});
