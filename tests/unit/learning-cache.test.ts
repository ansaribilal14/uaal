import { describe, it, expect, beforeEach } from "vitest";
import { RouteStatsStore } from "../../src/core/learning.js";
import { Cache, ArtifactIndex, cacheKey } from "../../src/core/cache.js";
import { makeIdentity } from "../../src/core/identity.js";
import { FailureCode } from "../../src/core/errors.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function tmpState(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "uaal-stats-"));
}

describe("route learning store (spec §11, §36)", () => {
  let store: RouteStatsStore;
  let dir: string;

  beforeEach(async () => {
    dir = await tmpState();
    store = new RouteStatsStore(dir);
  });

  it("records observations and computes ratios", async () => {
    for (let i = 0; i < 8; i++) {
      await store.record({ ts: new Date().toISOString(), routeId: "r1", platform: "youtube", capability: "metadata", envClass: "local", ok: true, latencyMs: 100 });
    }
    await store.record({ ts: new Date().toISOString(), routeId: "r1", platform: "youtube", capability: "metadata", envClass: "local", ok: false, failureCode: FailureCode.TIMEOUT, latencyMs: 200 });
    const s = store.get("r1", "metadata", "local");
    expect(s?.attempts).toBe(9);
    expect(s?.successes).toBe(8);
    expect(s?.failureStreak).toBe(1);
    expect(s?.byFailure["TIMEOUT"]).toBe(1);
  });

  it("applies cooldowns after repeated rate limits but keeps routes eligible", async () => {
    for (let i = 0; i < 4; i++) {
      await store.record({ ts: new Date().toISOString(), routeId: "r2", platform: "x", capability: "metadata", envClass: "local", ok: false, failureCode: FailureCode.RATE_LIMIT, latencyMs: 50 });
    }
    const s = store.get("r2", "metadata", "local");
    expect(s?.failureStreak).toBe(4);
    expect(s?.cooldownUntil).toBeTruthy();
    expect(store.inCooldown("r2", "metadata", "local")).toBe(true);
    // learning score is penalized but the route can still be ranked (never removed)
    expect(store.learningScore("r2", "metadata", "local")).toBeLessThan(0);
  });

  it("no cooldown for environmental failures", async () => {
    for (let i = 0; i < 5; i++) {
      await store.record({ ts: new Date().toISOString(), routeId: "r3", platform: "x", capability: "metadata", envClass: "local", ok: false, failureCode: FailureCode.ENVIRONMENT_INCOMPATIBLE, latencyMs: 5 });
    }
    expect(store.inCooldown("r3", "metadata", "local")).toBe(false);
  });

  it("persists and reloads (durable learning)", async () => {
    await store.record({ ts: new Date().toISOString(), routeId: "r4", platform: "x", capability: "metadata", envClass: "local", ok: true, latencyMs: 10 });
    await store.persist();
    const store2 = new RouteStatsStore(dir);
    await store2.load();
    expect(store2.get("r4", "metadata", "local")?.attempts).toBe(1);
  });

  it("reset is reversible (spec §36)", async () => {
    await store.record({ ts: new Date().toISOString(), routeId: "r5", platform: "x", capability: "metadata", envClass: "local", ok: false, failureCode: FailureCode.BLOCKED, latencyMs: 1 });
    await store.reset("r5");
    expect(store.get("r5", "metadata", "local")).toBeUndefined();
  });

  it("learning is bounded (recent window capped)", async () => {
    for (let i = 0; i < 100; i++) {
      await store.record({ ts: new Date().toISOString(), routeId: "r6", platform: "x", capability: "metadata", envClass: "local", ok: i % 2 === 0, failureCode: FailureCode.TIMEOUT, latencyMs: 1 });
    }
    const s = store.get("r6", "metadata", "local")!;
    expect(s.recentWindow).toBeLessThanOrEqual(20);
  });
});

describe("cache + idempotency (spec §32, §33)", () => {
  it("round-trips with TTL classes", async () => {
    const dir = await tmpState();
    const cache = new Cache(dir);
    await cache.put("meta", "k1", { a: 1 });
    expect(await cache.get("meta", "k1")).toEqual({ a: 1 });
    expect(await cache.get("meta", "missing")).toBeUndefined();
  });
  it("disabled cache never stores", async () => {
    const dir = await tmpState();
    const cache = new Cache(dir, false);
    await cache.put("meta", "k2", { a: 2 });
    expect(await cache.get("meta", "k2")).toBeUndefined();
  });
  it("cache keys are deterministic and output-sensitive", () => {
    const id = makeIdentity("youtube", "video", "abc", "https://www.youtube.com/watch?v=abc", []);
    const a = cacheKey(id, "acquire");
    const b = cacheKey(id, "acquire");
    const c = cacheKey(id, "acquire", { format: ["audio"] });
    const d = cacheKey(id, "acquire", { format: ["video"] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(c).not.toBe(d);
    // key order in output requirements must not matter (sorted deep)
    expect(cacheKey(id, "acquire", { format: ["a", "b"], maxBytes: 5 })).toBe(cacheKey(id, "acquire", { maxBytes: 5, format: ["a", "b"] }));
  });
  it("artifact index round-trips and stays bounded", async () => {
    const dir = await tmpState();
    const idx = new ArtifactIndex(dir);
    await idx.put("k", "art_1", "/tmp/a.mp4");
    expect((await idx.find("k"))?.artifactId).toBe("art_1");
  });
});
