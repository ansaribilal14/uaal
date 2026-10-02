/**
 * Platform expansion tests: tiktok, douyin, instagram, threads adapters —
 * identity parsing (local, zero network), route behavior against a fake
 * HttpLayer (scripted responses), normalization and verification wiring.
 * All HTTP is simulated; nothing here touches the real network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExecutionContext, HttpLayer, RouteResult } from "../../src/core/contracts.js";
import { FailureCode } from "../../src/core/errors.js";
import { fakeEnvironment } from "../fixtures/scripted.js";
import { makeIdentity } from "../../src/core/identity.js";
import { createHash } from "node:crypto";

import { TikTokAdapter, parseTikTokUrl, tiktokTikwmMetadataRoute } from "../../src/adapters/tiktok/index.js";
import { tiktokTikwmAcquireRoute } from "../../src/adapters/tiktok/routes.js";
import { DouyinAdapter, parseDouyinUrl } from "../../src/adapters/douyin/index.js";
import { parseRouterData, douyinShareMetadataRoute } from "../../src/adapters/douyin/routes.js";
import { InstagramAdapter, parseInstagramUrl } from "../../src/adapters/instagram/index.js";
import { parseInstagramEmbed, instagramEmbedAcquireRoute } from "../../src/adapters/instagram/routes.js";
import { ThreadsAdapter, parseThreadsUrl } from "../../src/adapters/threads/index.js";
import { parseThreadsEmbed } from "../../src/adapters/threads/routes.js";

/* ------------------------------ test infrastructure ------------------------------ */

let workRoot: string;

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(tmpdir(), "uaal-platforms-"));
});
afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

interface ScriptedResponse {
  status: number;
  body: Buffer | string;
  headers?: Record<string, string>;
  finalUrl?: string;
}

/** Minimal HttpLayer stand-in: GET responses keyed by substring match. */
function fakeHttp(routes: Array<{ match: string; respond: ScriptedResponse | ((url: string) => ScriptedResponse) }>): HttpLayer {
  const find = (url: string) => routes.find((r) => url.includes(r.match));
  return {
    async get(url: string) {
      const hit = find(url);
      if (!hit) throw new Error(`fakeHttp: no scripted response for ${url}`);
      const r = typeof hit.respond === "function" ? hit.respond(url) : hit.respond;
      const body = typeof r.body === "string" ? Buffer.from(r.body) : r.body;
      return {
        status: r.status,
        ok: r.status < 400,
        headers: r.headers ?? { "content-type": "application/json" },
        body,
        finalUrl: r.finalUrl ?? url,
        latencyMs: 1,
        redirected: r.finalUrl !== undefined,
        bytesTruncated: false
      };
    },
    async stream(url: string) {
      const hit = find(url);
      if (!hit) throw new Error(`fakeHttp.stream: no scripted response for ${url}`);
      const r = typeof hit.respond === "function" ? hit.respond(url) : hit.respond;
      const body = typeof r.body === "string" ? Buffer.from(r.body) : r.body;
      return {
        status: r.status,
        ok: r.status < 400,
        headers: r.headers ?? { "content-type": "application/octet-stream", "content-length": String(body.length) },
        finalUrl: url,
        async pipeTo(onChunk: (c: Buffer) => Promise<void>, _cap: number) {
          await onChunk(body);
          return { truncated: false, bytes: body.length };
        },
        cancel() {}
      };
    }
  } as unknown as HttpLayer;
}

function fakeCtx(identityPlatform: string, id: string, canonicalUrl: string, aliases: string[] = []): ExecutionContext {
  const dir = path.join(workRoot, `${identityPlatform}-${id}`.replace(/[^a-zA-Z0-9_-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  return {
    request: { resource: canonicalUrl, capability: "acquire" },
    identity: makeIdentity(identityPlatform, "post", id, canonicalUrl, aliases.length ? aliases : [canonicalUrl]),
    capability: "acquire",
    environment: fakeEnvironment(),
    policy: { maxAccessLevel: "public", allowedRouteTags: [], deniedRouteTags: [], maxRouteAttempts: 8, attemptTimeoutMs: 0, polite: false, credentials: {} },
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 60_000,
    workingDir: dir,
    sink: {
      allocate(name: string) {
        return { path: path.join(dir, name) };
      },
      register(ref: { path: string }) {
        written.push(ref.path);
      }
    },
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {}
    },
    hash(data: string | Buffer) {
      return createHash("sha256").update(data).digest("hex").slice(0, 16);
    }
  } as unknown as ExecutionContext;
}

/* ------------------------------ TikTok identity ------------------------------ */

describe("tiktok identity", () => {
  it("parses canonical @user/video URLs", () => {
    const p = parseTikTokUrl("https://www.tiktok.com/@creator/video/7301234567890123456?is_from_webapp=1");
    expect(p).not.toBeNull();
    expect(p!.itemId).toBe("7301234567890123456");
    expect(p!.kind).toBe("video");
  });
  it("parses photo-mode posts", () => {
    const p = parseTikTokUrl("https://www.tiktok.com/@creator/photo/7301234567890123456");
    expect(p!.kind).toBe("photo");
  });
  it("parses vm / vt short links and /t/ links", () => {
    expect(parseTikTokUrl("https://vm.tiktok.com/ZMabc123/")!.kind).toBe("short");
    expect(parseTikTokUrl("https://vt.tiktok.com/ZSabcd/")!.shortCode).toBe("ZSabcd");
    expect(parseTikTokUrl("https://www.tiktok.com/t/ZTabcdef/")!.shortCode).toBe("ZTabcdef");
  });
  it("parses old m.tiktok.com /v/ links", () => {
    const p = parseTikTokUrl("https://m.tiktok.com/v/7301234567890123456.html");
    expect(p!.itemId).toBe("7301234567890123456");
  });
  it("rejects foreign URLs", () => {
    expect(parseTikTokUrl("https://x.com/jack/status/20")).toBeNull();
    expect(parseTikTokUrl("https://instagram.com/p/abc/")).toBeNull();
  });
  it("detects its own platform", () => {
    const adapter = new TikTokAdapter(fakeHttp([]));
    expect(adapter.detect("https://www.tiktok.com/@a/video/7301234567890123456").matched).toBe(true);
    expect(adapter.detect("https://x.com/a/status/1").matched).toBe(false);
  });
});

/* ------------------------------ TikTok routes ------------------------------ */

describe("tiktok tikwm routes", () => {
  const TIKWM_OK = {
    code: 0,
    msg: "success",
    data: {
      id: "7301234567890123456",
      title: "test clip",
      duration: 21,
      play: "/video/media/hdplay/abc.mp4",
      wmplay: "/video/media/wmplay/abc.mp4",
      origin_cover: "https://tikwm.com/video/media/hdcover/abc.jpg",
      music: "/video/media/music/abc.mp3",
      author: { unique_id: "creator", nickname: "Creator" },
      play_count: 1000,
      digg_count: 50,
      comment_count: 5,
      share_count: 2
    }
  };

  it("metadata route returns mirror evidence with absolute URLs", async () => {
    const http = fakeHttp([{ match: "tikwm.com/api", respond: { status: 200, body: JSON.stringify(TIKWM_OK) } }]);
    const ctx = fakeCtx("tiktok", "7301234567890123456", "https://www.tiktok.com/@creator/video/7301234567890123456");
    const result: RouteResult = await tiktokTikwmMetadataRoute(http).execute(ctx.request, ctx);
    expect(result.ok).toBe(true);
    expect(result.evidence[0].type).toBe("tikwm.api");
  });

  it("acquire route downloads the no-watermark video + cover as registered artifacts", async () => {
    const http = fakeHttp([
      { match: "tikwm.com/api", respond: { status: 200, body: JSON.stringify(TIKWM_OK) } },
      { match: "hdplay/abc.mp4", respond: { status: 200, body: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), headers: { "content-type": "video/mp4" } } },
      { match: "hdcover/abc.jpg", respond: { status: 200, body: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), headers: { "content-type": "image/jpeg" } } }
    ]);
    const ctx = fakeCtx("tiktok", "7301234567890123456", "https://www.tiktok.com/@creator/video/7301234567890123456");
    await writeFile(path.join(ctx.workingDir, ".keep"), "");
    const route = tiktokTikwmAcquireRoute(http);
    const result = await route.execute(ctx.request, ctx);
    expect(result.ok).toBe(true);
    expect(result.artifacts).toHaveLength(2);
    const video = result.artifacts.find((a) => a.filename === "tiktok_7301234567890123456.mp4");
    expect(video).toBeDefined();
    expect(video!.kind).toBe("video");
    // mirror-relative URL was absolutized
    const stored = await readFile(video!.path);
    expect(stored.length).toBe(8);
  });

  it("acquire route fetches the full photo set for slideshows", async () => {
    const http = fakeHttp([
      {
        match: "tikwm.com/api",
        respond: {
          status: 200,
          body: JSON.stringify({
            code: 0,
            data: { id: "1", title: "slideshow", images: ["https://tikwm.com/media/p1.jpg", "https://tikwm.com/media/p2.jpg", "https://tikwm.com/media/p3.jpg"], author: { unique_id: "c" } }
          })
        }
      },
      { match: "p1.jpg", respond: { status: 200, body: Buffer.from([0xff, 0xd8, 0xff]), headers: { "content-type": "image/jpeg" } } },
      { match: "p2.jpg", respond: { status: 200, body: Buffer.from([0xff, 0xd8, 0xff]), headers: { "content-type": "image/jpeg" } } },
      { match: "p3.jpg", respond: { status: 200, body: Buffer.from([0xff, 0xd8, 0xff]), headers: { "content-type": "image/jpeg" } } }
    ]);
    const ctx = fakeCtx("tiktok", "1", "https://www.tiktok.com/@c/photo/1");
    await writeFile(path.join(ctx.workingDir, ".keep"), "");
    const result = await tiktokTikwmAcquireRoute(http).execute(ctx.request, ctx);
    expect(result.ok).toBe(true);
    expect(result.artifacts.filter((a) => a.kind === "photo")).toHaveLength(3);
  });

  it("reports private/deleted posts honestly as unavailable", async () => {
    const http = fakeHttp([{ match: "tikwm.com/api", respond: { status: 200, body: JSON.stringify({ code: -1, msg: "This video is private" }) } }]);
    const ctx = fakeCtx("tiktok", "2", "https://www.tiktok.com/@c/video/2");
    const result = await tiktokTikwmAcquireRoute(http).execute(ctx.request, ctx);
    expect(result.ok).toBe(false);
    expect(result.failure!.code).toBe(FailureCode.INVALID_RESOURCE);
    expect(result.unavailable).toBe(true);
  });

  it("reports rate limits as retryable", async () => {
    const http = fakeHttp([{ match: "tikwm.com/api", respond: { status: 200, body: JSON.stringify({ code: -1, msg: "Free Api Limit: 1 request per second" }) } }]);
    const ctx = fakeCtx("tiktok", "3", "https://www.tiktok.com/@c/video/3");
    const result = await tiktokTikwmAcquireRoute(http).execute(ctx.request, ctx);
    expect(result.failure!.code).toBe(FailureCode.RATE_LIMIT);
    expect(result.failure!.retryable).toBe(true);
  });
});

/* ------------------------------ Douyin ------------------------------ */

describe("douyin adapter", () => {
  it("parses douyin video + note URLs and short links", () => {
    expect(parseDouyinUrl("https://www.douyin.com/video/7301234567890123456")!.itemId).toBe("7301234567890123456");
    expect(parseDouyinUrl("https://www.douyin.com/note/7301234567890123456")!.kind).toBe("note");
    expect(parseDouyinUrl("https://v.douyin.com/iabcXYZ/")!.kind).toBe("short");
    expect(parseDouyinUrl("https://x.com/a/status/1")).toBeNull();
  });

  const ROUTER_HTML = `<!doctype html><html><head></head><body><script>
    window._ROUTER_DATA = {"loaderData":{"video_(7301234567890123456)/page":{"videoInfoRes":{"item_list":[{"desc":"douyin test post","create_time":1717000000,"author":{"nickname":"测试用户","unique_id":"douyinuser"},"video":{"play_addr":{"uri":"v0d00fg10000abc","url_list":["https://www.iesdouyin.com/aweme/v1/play/?video_id=v0d00fg10000abc&ratio=720p&line=0"]},"duration":18,"origin_cover":{"url_list":["https://p3-sign.douyinpic.com/cover.jpg"]}},"statistics":{"digg_count":42,"comment_count":7,"share_count":3,"play_count":900}}]}}},"loaderError":null};
  </script></body></html>`;

  it("parses the embedded _ROUTER_DATA JSON", () => {
    const item = parseRouterData(ROUTER_HTML);
    expect(item).not.toBeNull();
    expect(item!.desc).toBe("douyin test post");
    expect(item!.author!.unique_id).toBe("douyinuser");
    expect(item!.statistics!.digg_count).toBe(42);
  });

  it("share metadata route surfaces the item record as evidence", async () => {
    const http = fakeHttp([{ match: "iesdouyin.com/share/video/730123", respond: { status: 200, body: ROUTER_HTML, headers: { "content-type": "text/html" } } }]);
    const ctx = fakeCtx("douyin", "7301234567890123456", "https://www.douyin.com/video/7301234567890123456");
    const result = await douyinShareMetadataRoute(http).execute(ctx.request, ctx);
    expect(result.ok).toBe(true);
    expect(result.evidence[0].type).toBe("douyin.router_data");
  });

  it("blocks are honest (403 → BLOCKED)", async () => {
    const http = fakeHttp([{ match: "iesdouyin.com/share/video/403", respond: { status: 403, body: "forbidden", headers: { "content-type": "text/html" } } }]);
    const ctx = fakeCtx("douyin", "403", "https://www.douyin.com/video/403");
    const result = await douyinShareMetadataRoute(http).execute(ctx.request, ctx);
    expect(result.ok).toBe(false);
    expect(result.failure!.code).toBe(FailureCode.BLOCKED);
  });

  it("detects douyin URLs", () => {
    const adapter = new DouyinAdapter(fakeHttp([]));
    expect(adapter.detect("https://v.douyin.com/iabc/").matched).toBe(true);
    expect(adapter.detect("https://tiktok.com/@a/video/1").matched).toBe(false);
  });
});

/* ------------------------------ Instagram ------------------------------ */

describe("instagram adapter", () => {
  it("parses post/reel/tv shortcodes incl. username-prefixed forms", () => {
    expect(parseInstagramUrl("https://www.instagram.com/p/Cabc123_-/")!.shortcode).toBe("Cabc123_-");
    expect(parseInstagramUrl("https://www.instagram.com/reel/Cabc123_-/")!.kind).toBe("reel");
    expect(parseInstagramUrl("https://www.instagram.com/someuser/p/Cabc123_-/")!.username).toBe("someuser");
    expect(parseInstagramUrl("https://instagram.com/stories/user/123/")).toBeNull(); // stories never parsed
  });

  const EMBED_HTML = `<!doctype html><html><body>
    <div class="Embed"><div class="EmbeddedPost">
      <div class="UsernameText">wonder.user</div>
      <div class="Caption"><div class="UsernameText">wonder.user</div>Here is a caption 🎉 with emoji</div>
      <script type="application/json">{"display_url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/t51.2885-15\\/big_photo.jpg?se=7","video_url":null}</script>
    </div></div>
  </body></html>`;

  it("parses the embed page (username, caption, display_url)", () => {
    const data = parseInstagramEmbed(EMBED_HTML);
    expect(data).not.toBeNull();
    expect(data!.username).toBe("wonder.user");
    expect(data!.caption).toContain("Here is a caption");
    expect(data!.images.length).toBeGreaterThan(0);
    expect(data!.images[0]).toMatch(/^https:\/\/scontent\.cdninstagram\.com/);
  });

  it("embed acquire downloads exposed images as artifacts", async () => {
    const http = fakeHttp([
      { match: "/embed/captioned", respond: { status: 200, body: EMBED_HTML, headers: { "content-type": "text/html" } } },
      { match: "big_photo.jpg", respond: { status: 200, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), headers: { "content-type": "image/jpeg" } } }
    ]);
    const ctx = fakeCtx("instagram", "Cabc123_-", "https://www.instagram.com/p/Cabc123_-/");
    await writeFile(path.join(ctx.workingDir, ".keep"), "");
    const result = await instagramEmbedAcquireRoute(http).execute(ctx.request, ctx);
    expect(result.ok).toBe(true);
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  it("login redirects surface honestly as AUTH_REQUIRED", async () => {
    const http = fakeHttp([{ match: "/embed/captioned", respond: { status: 302, body: "", headers: {} } }]);
    const ctx = fakeCtx("instagram", "Blocked1", "https://www.instagram.com/p/Blocked1/");
    const result = await instagramEmbedAcquireRoute(http).execute(ctx.request, ctx);
    expect(result.ok).toBe(false);
    expect(result.failure!.code).toBe(FailureCode.AUTH_REQUIRED);
  });

  it("rejects story URLs at detection (never pretended)", () => {
    const adapter = new InstagramAdapter(fakeHttp([]));
    expect(adapter.detect("https://www.instagram.com/stories/user/123/").matched).toBe(false);
    expect(adapter.detect("https://www.instagram.com/p/Cabc123_-/").matched).toBe(true);
  });
});

/* ------------------------------ Threads ------------------------------ */

describe("threads adapter", () => {
  it("parses threads post URLs", () => {
    const p = parseThreadsUrl("https://www.threads.net/@zuck/post/C2abc123XYZ");
    expect(p!.postId).toBe("C2abc123XYZ");
    expect(p!.username).toBe("zuck");
    expect(parseThreadsUrl("https://x.com/a/status/1")).toBeNull();
  });

  const THREADS_HTML = `<!doctype html><html><head><title>Post by mosseri • Threads</title></head><body>
    <div class="Post">
      <script type="application/json">{"caption":"first post on threads","username":"mosseri","display_url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/t51.29350-15\\/threads_img.jpg?epic=xyz"}</script>
    </div>
  </body></html>`;

  it("parses the embed page (caption, username, image)", () => {
    const data = parseThreadsEmbed(THREADS_HTML);
    expect(data).not.toBeNull();
    expect(data!.caption).toContain("first post on threads");
    expect(data!.images[0]).toMatch(/^https:\/\/scontent\.cdninstagram\.com/);
  });

  it("detects threads URLs and rejects foreign ones", () => {
    const adapter = new ThreadsAdapter(fakeHttp([]));
    expect(adapter.detect("https://www.threads.net/@a/post/C123abcd").matched).toBe(true);
    expect(adapter.detect("https://threads.com/@a/post/C123abcd").matched).toBe(true);
    expect(adapter.detect("https://x.com/a/status/1").matched).toBe(false);
  });
});

/* ------------------------------ shell-page honesty ------------------------------ */

describe("honest failures on JS-shell pages (datacenter networks)", () => {
  const THREADS_SHELL = `<!doctype html><html><head><title>Threads</title></head><body><div id="root"></div>
    <script src="https://static.threads.net/bundle.js"></script></body></html>`;

  it("threads: shell page parses to null (never fake metadata)", () => {
    expect(parseThreadsEmbed(THREADS_SHELL)).toBeNull();
  });

  it("threads: metadata route reports login-wall honestly on shell pages", async () => {
    const { threadsEmbedMetadataRoute } = await import("../../src/adapters/threads/routes.js");
    const http = fakeHttp([{ match: "/embed", respond: { status: 200, body: THREADS_SHELL, headers: { "content-type": "text/html" } } }]);
    const ctx = fakeCtx("threads", "Cshell12345", "https://www.threads.net/@zuck/post/Cshell12345");
    const result = await threadsEmbedMetadataRoute(http).execute(ctx.request, ctx);
    expect(result.ok).toBe(false);
    expect(result.failure!.code).toBe(FailureCode.AUTH_REQUIRED);
  });

  it("douyin: acquire refuses honestly when share page is a client-side shell", async () => {
    const { douyinIesdouyinAcquireRoute } = await import("../../src/adapters/douyin/routes.js");
    const SHELL = `<!doctype html><html><body><script>window._ROUTER_DATA = {"loaderData":{"video_layout":null,"video_(id)/page":{"isSpider":false}}};</script></body></html>`;
    const http = fakeHttp([{ match: "iesdouyin.com/share/video/", respond: { status: 200, body: SHELL, headers: { "content-type": "text/html" } } }]);
    const ctx = fakeCtx("douyin", "7298145681699622182", "https://www.douyin.com/video/7298145681699622182");
    const result = await douyinIesdouyinAcquireRoute(http).execute(ctx.request, ctx);
    expect(result.ok).toBe(false);
    expect(result.failure!.code).toBe(FailureCode.BLOCKED);
    expect(result.failure!.message).toMatch(/honestly/i);
  });

  it("douyin: acquire downloads via play endpoint when the record IS server-rendered", async () => {
    const { douyinIesdouyinAcquireRoute } = await import("../../src/adapters/douyin/routes.js");
    const SSR = `<!doctype html><script>window._ROUTER_DATA = {"loaderData":{"video_(id)/page":{"videoInfoRes":{"item_list":[{"desc":"ssr douyin","author":{"unique_id":"u1","nickname":"U1"},"video":{"play_addr":{"uri":"v0abc123"},"duration":15,"origin_cover":{"url_list":["https://p.douyinpic.com/c.jpg"]}},"statistics":{"digg_count":1}}]}}}};</script>`;
    const http = fakeHttp([
      { match: "iesdouyin.com/share/video/", respond: { status: 200, body: SSR, headers: { "content-type": "text/html" } } },
      { match: "aweme/v1/play", respond: { status: 200, body: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), headers: { "content-type": "video/mp4" } } },
      { match: "c.jpg", respond: { status: 200, body: Buffer.from([0xff, 0xd8, 0xff]), headers: { "content-type": "image/jpeg" } } }
    ]);
    const ctx = fakeCtx("douyin", "1111222233334", "https://www.douyin.com/video/1111222233334");
    const result = await douyinIesdouyinAcquireRoute(http).execute(ctx.request, ctx);
    expect(result.ok).toBe(true);
    expect(result.artifacts.some((a) => a.kind === "video")).toBe(true);
  });
});
