/**
 * Adapter contract tests (spec §41 contract tests): every built-in adapter
 * must satisfy the same core interface — detection, capability declarations,
 * route discovery with the universal AccessRoute contract, normalization to
 * the common schema, and verification wiring.
 */
import { describe, it, expect } from "vitest";
import { getBuiltinAdapters } from "../../src/adapters/index.js";
import { CAPABILITIES, type PlatformAdapter, type ResourceRequest } from "../../src/core/contracts.js";
import { fakeEnvironment } from "../fixtures/scripted.js";
import { isCapability } from "../../src/core/capabilities.js";

const ADAPTER_URLS: Record<string, string> = {
  youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  x: "https://x.com/jack/status/20",
  reddit: "https://www.reddit.com/r/node/comments/1abc123/test/",
  tiktok: "https://www.tiktok.com/@user/video/7301234567890123456",
  douyin: "https://www.douyin.com/video/7301234567890123456",
  instagram: "https://www.instagram.com/p/Cxyz123abc_/",
  threads: "https://www.threads.net/@user/post/Cxyz123abcA",
  "generic-web": "https://example.com/page"
};

function discoveryCtx(adapter: PlatformAdapter, url: string) {
  return {
    environment: fakeEnvironment(),
    policy: { maxAccessLevel: "public" as const, allowedRouteTags: [], deniedRouteTags: [], maxRouteAttempts: 8, attemptTimeoutMs: 0, polite: true, credentials: {} },
    identity: {
      platform: adapter.id,
      type: "test",
      id: "id1",
      canonicalUrl: url,
      aliases: [url],
      fingerprint: `fp-${adapter.id}`
    },
    capability: "metadata" as const
  };
}

describe("adapter contract (all built-in adapters)", () => {
  const adapters = getBuiltinAdapters({});

  it("registers the v2 platform adapters", () => {
    expect(adapters.map((a) => a.id).sort()).toEqual([
      "douyin",
      "generic-web",
      "instagram",
      "reddit",
      "threads",
      "tiktok",
      "x",
      "youtube"
    ]);
  });

  for (const adapter of adapters) {
    describe(`adapter: ${adapter.id}`, () => {
      it("detects its own URLs and rejects foreign ones", () => {
        const own = adapter.detect(ADAPTER_URLS[adapter.id]);
        expect(own.matched).toBe(true);
        expect(own.platform).toBe(adapter.id);
        // generic-web is the catch-all: it matches everything http(s)
        if (adapter.id !== "generic-web") {
          for (const [other, url] of Object.entries(ADAPTER_URLS)) {
            if (other === adapter.id || other === "generic-web") continue;
            const foreign = adapter.detect(url);
            expect(foreign.matched).toBe(false);
          }
        }
      });

      it("declares only known capabilities with descriptions", () => {
        const caps = adapter.capabilities();
        expect(caps.length).toBeGreaterThan(0);
        for (const c of caps) {
          expect(isCapability(c.name)).toBe(true);
          expect(CAPABILITIES).toContain(c.name);
          expect(c.description.length).toBeGreaterThan(5);
        }
      });

      it("documents limitations honestly", () => {
        expect(adapter.limitations().length).toBeGreaterThan(0);
      });

      it("discovers routes satisfying the universal route contract", async () => {
        const url = ADAPTER_URLS[adapter.id];
        const routes = await adapter.discoverRoutes({ resource: url, capability: "metadata" }, discoveryCtx(adapter, url));
        expect(routes.length).toBeGreaterThan(0);
        for (const route of routes) {
          expect(route.id).toMatch(new RegExp(`^${adapter.id}\\.`));
          expect(route.capabilities.length).toBeGreaterThan(0);
          expect(route.enabled).toBe(true);
          expect(["public", "authorized"]).toContain(route.accessLevel);
          expect(route.tags.length).toBeGreaterThan(0);
          expect(route.description.length).toBeGreaterThan(20);
          expect(route.environmentCompatibility.local).toBe(true);
          expect(typeof route.execute).toBe("function");
          expect(route.priority).toBeGreaterThanOrEqual(0);
        }
      });

      it("normalizes evidence into the common schema (spec §15)", async () => {
        const url = ADAPTER_URLS[adapter.id];
        const identity = {
          platform: adapter.id,
          type: "test",
          id: "id1",
          canonicalUrl: url,
          aliases: [url],
          fingerprint: `fp-${adapter.id}`
        };
        const evidence = [
          {
            id: "e1",
            source: "test.route",
            type: adapter.id === "x" ? "fxtweet" : "test.data",
            data: adapter.id === "x" ? { id: "20", text: "hello", author: { screen_name: "jack" }, media: null, likes: 1 } : { title: "T", description: "D" },
            retrievedAt: new Date().toISOString(),
            reliability: 0.8
          }
        ];
        const resource = await adapter.normalize(evidence, { resource: url }, identity);
        expect(resource.schemaVersion).toBe("1.0");
        expect(resource.platform).toBe(adapter.id);
        expect(resource.resource.id).toBe("id1");
        expect(resource.resource.url).toBeTruthy();
        expect(resource.evidence).toHaveLength(1);
        expect(resource.uncertainty).toHaveProperty("confidence");
        expect(Array.isArray(resource.media)).toBe(true);
        expect(Array.isArray(resource.relationships)).toBe(true);
      });

      it("verify() returns structured check results", async () => {
        const url = ADAPTER_URLS[adapter.id];
        const identity = { platform: adapter.id, type: "test", id: "id1", canonicalUrl: url, aliases: [url], fingerprint: "fp" };
        const resource = await adapter.normalize(
          [{ id: "e1", source: "r", type: "t", data: { title: "x" }, retrievedAt: new Date().toISOString(), reliability: 0.8 }],
          { resource: url },
          identity
        );
        const res = await adapter.verify(resource, []);
        expect(res.verified).toBeTypeOf("boolean");
        expect(res.checks.length).toBeGreaterThan(0);
        expect(res.checks.every((c) => typeof c.name === "string" && typeof c.passed === "boolean")).toBe(true);
      });
    });
  }
});

describe("per-adapter normalization honesty", () => {
  it("x: replying_to_status survives into platformData with provenance", async () => {
    const x = getBuiltinAdapters({}).find((a) => a.id === "x")!;
    const resource = await x.normalize(
      [{ id: "e1", source: "x.status.metadata", type: "fxtweet", data: { id: "20", text: "hi", replying_to_status: "19", _extraction_source: "fxtwitter" }, retrievedAt: new Date().toISOString(), reliability: 0.9 }],
      { resource: ADAPTER_URLS.x },
      { platform: "x", type: "thread", id: "20", canonicalUrl: "https://x.com/i/web/status/20", aliases: [], fingerprint: "fp-x" }
    );
    expect(resource.platformData.extractionSource).toBe("fxtwitter");
    expect(resource.platformData.replyingToStatus).toBe("19");
  });

  it("youtube: evidence conflicts resolved by reliability and recorded", async () => {
    const yt = getBuiltinAdapters({}).find((a) => a.id === "youtube")!;
    const identity = { platform: "youtube", type: "video", id: "abc", canonicalUrl: "https://www.youtube.com/watch?v=abc", aliases: [], fingerprint: "fp-yt" };
    const resource = await yt.normalize(
      [
        { id: "e1", source: "r1", type: "oembed", data: { title: "OEmbed Title", videoId: "abc" }, retrievedAt: new Date().toISOString(), reliability: 0.9 },
        { id: "e2", source: "r2", type: "piped.streams", data: { title: "Piped Title" }, retrievedAt: new Date().toISOString(), reliability: 0.7 }
      ],
      { resource: identity.canonicalUrl },
      identity
    );
    // oembed (0.9) beats piped (0.7)
    expect(resource.content.title).toBe("OEmbed Title");
    expect(resource.uncertainty.notes.some((n) => n.code === "conflict.title")).toBe(true);
  });

  it("youtube: evidence about a different video id is rejected (spec §14.4)", async () => {
    const yt = getBuiltinAdapters({}).find((a) => a.id === "youtube")!;
    const identity = { platform: "youtube", type: "video", id: "abc", canonicalUrl: "https://www.youtube.com/watch?v=abc", aliases: [], fingerprint: "fp-yt" };
    const resource = await yt.normalize(
      [
        { id: "e1", source: "r1", type: "oembed", data: { title: "Other Video", videoId: "zzz" }, retrievedAt: new Date().toISOString(), reliability: 0.9 }
      ],
      { resource: identity.canonicalUrl },
      identity
    );
    expect(resource.uncertainty.notes.some((n) => n.code === "evidence.filtered")).toBe(true);
    expect(resource.evidence).toHaveLength(0);
  });
});

void ({} as ResourceRequest);
