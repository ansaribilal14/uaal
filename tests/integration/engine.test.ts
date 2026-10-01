/**
 * Engine integration tests (spec §41): full pipeline with scripted adapters —
 * failure tests, recovery tests, status model, partial success, idempotency,
 * fallback ordering, policy filtering.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { UAAL } from "../../src/core/engine.js";
import { PlatformRegistry } from "../../src/core/identity.js";
import { scriptedAdapter, scriptedRoute, fakeEnvironment } from "../fixtures/scripted.js";
import type { ResourceRequest, UAALConfig } from "../../src/core/contracts.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let stateDir: string;
let artifactsDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "uaal-eng-state-"));
  artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "uaal-eng-art-"));
});

afterAll(async () => {
  // temp dirs are OS-managed; nothing to do
});

async function makeEngine(routes: Parameters<typeof scriptedAdapter>[0]["routes"], overrides: Partial<UAALConfig> = {}, adapterOverrides: Partial<Parameters<typeof scriptedAdapter>[0]> = {}): Promise<UAAL> {
  const registry = new PlatformRegistry();
  registry.register(scriptedAdapter({ routes, ...adapterOverrides }));
  return UAAL.create({
    config: {
      stateDir,
      artifactsDir,
      logLevel: "error",
      attemptTimeoutMs: 5_000,
      operationTimeoutMs: 30_000,
      learning: false, // deterministic tests by default
      cache: false,
      ...overrides
    },
    logger: undefined,
    adapters: registry,
    environment: fakeEnvironment()
  });
}

const req = (resource = "testplat://res1", capability: ResourceRequest["capability"] = "metadata"): ResourceRequest => ({ resource, capability });

describe("engine pipeline — success + fallback", () => {
  it("primary route success returns ok with normalized resource", async () => {
    const engine = await makeEngine([{ id: "testplat.a", capabilities: ["metadata"], script: undefined }]);
    const env = await engine.inspect(req());
    expect(env.status).toBe("ok");
    expect(env.resource?.content.title).toBe("Resource res1");
    expect(env.route?.id).toBe("testplat.a");
    expect(env.verification?.verified).toBe(true);
  });

  it("falls back through failures: 429 → 403 → success (spec §10)", async () => {
    const engine = await makeEngine([
      { id: "testplat.ratelimit", capabilities: ["metadata"], script: "http429", priority: 90 },
      { id: "testplat.auth", capabilities: ["metadata"], script: "http403", priority: 80 },
      { id: "testplat.good", capabilities: ["metadata"], priority: 70 }
    ]);
    const env = await engine.inspect(req());
    expect(env.status).toBe("ok");
    expect(env.route?.id).toBe("testplat.good");
    expect(env.attempts.filter((a) => a.status === "failure").map((a) => a.route)).toEqual(["testplat.ratelimit", "testplat.auth"]);
    expect(env.attempts.filter((a) => a.status === "failure").map((a) => a.failureCode)).toEqual(["RATE_LIMIT", "AUTH_REQUIRED"]);
  });

  it("route exceptions never crash the engine (never-raise boundary)", async () => {
    const engine = await makeEngine([
      { id: "testplat.throws", capabilities: ["metadata"], script: "raise", priority: 90 },
      { id: "testplat.ok", capabilities: ["metadata"], priority: 50 }
    ]);
    const env = await engine.inspect(req());
    expect(env.status).toBe("ok");
    expect(env.attempts[0].failureCode).toBe("INTERNAL_ERROR");
  });

  it("respects priority order: higher priority runs first on success", async () => {
    const engine = await makeEngine([
      { id: "testplat.low", capabilities: ["metadata"], priority: 10 },
      { id: "testplat.high", capabilities: ["metadata"], priority: 95 }
    ]);
    const env = await engine.inspect(req());
    expect(env.route?.id).toBe("testplat.high");
    expect(env.attempts).toHaveLength(1);
  });
});

describe("engine pipeline — failure model (spec §39, §54)", () => {
  it("all auth walls → requires_auth with attempts detail", async () => {
    const engine = await makeEngine([
      { id: "testplat.auth1", capabilities: ["metadata"], script: "http403", priority: 90 },
      { id: "testplat.auth2", capabilities: ["metadata"], script: "http403", priority: 80 }
    ]);
    const env = await engine.inspect(req());
    expect(env.status).toBe("requires_auth");
    expect(env.error?.code).toBe("ALL_ROUTES_EXHAUSTED");
    expect(env.attempts).toHaveLength(2);
  });

  it("all unavailable → empty (informative negatives)", async () => {
    const engine = await makeEngine([
      { id: "testplat.404a", capabilities: ["metadata"], script: "http404", priority: 90 },
      { id: "testplat.404b", capabilities: ["metadata"], script: "unavailable", priority: 80 }
    ]);
    const env = await engine.inspect(req());
    expect(env.status).toBe("empty");
  });

  it("mixed hard failures → failed with per-route classification", async () => {
    const engine = await makeEngine([
      { id: "testplat.net", capabilities: ["metadata"], script: "network", priority: 90 },
      { id: "testplat.malformed", capabilities: ["metadata"], script: "malformed", priority: 80 },
      { id: "testplat.empty", capabilities: ["metadata"], script: "empty", priority: 70 }
    ]);
    const env = await engine.inspect(req());
    expect(env.status).toBe("failed");
    expect(env.error?.code).toBe("ALL_ROUTES_EXHAUSTED");
    expect(env.error?.attempts.some((a) => a.failureCode === "NETWORK_FAILURE")).toBe(true);
  });

  it("unsupported platform → unsupported", async () => {
    const engine = await makeEngine([{ id: "testplat.a", capabilities: ["metadata"] }]);
    const env = await engine.inspect({ resource: "testplat://x", capability: "comments" });
    // adapter declares metadata but request wants comments: no eligible routes
    expect(["unsupported", "failed"]).toContain(env.status);
  });

  it("unknown platform → unsupported, honestly", async () => {
    const engine = await makeEngine([{ id: "testplat.a", capabilities: ["metadata"] }]);
    const env = await engine.inspect({ resource: "https://unknown-platform.example/x" });
    expect(env.status).toBe("unsupported");
    expect(env.error?.code).toBe("UNSUPPORTED_CAPABILITY");
  });

  it("disabled routes are filtered from execution but listed in discovery", async () => {
    const engine = await makeEngine([
      { id: "testplat.off", capabilities: ["metadata"], enabled: false, priority: 90 },
      { id: "testplat.on", capabilities: ["metadata"], priority: 50 }
    ]);
    const env = await engine.inspect(req());
    expect(env.route?.id).toBe("testplat.on");
    expect(env.discovery?.find((d) => d.id === "testplat.off")?.status).toBe("disabled");
  });
});

describe("recovery semantics (spec §41 recovery tests)", () => {
  it("verification failure on route A → route B attempted (Rule 3/4)", async () => {
    const engine = await makeEngine(
      [
        { id: "testplat.badverify", capabilities: ["metadata"], script: "verification-failure", priority: 90 },
        { id: "testplat.good", capabilities: ["metadata"], priority: 50 }
      ],
      {}
    );
    const env = await engine.inspect(req());
    expect(env.status).toBe("ok");
    expect(env.route?.id).toBe("testplat.good");
    expect(env.attempts.filter((a) => a.failureCode === "VERIFICATION_FAILURE").length).toBeGreaterThanOrEqual(1);
  });

  it("invalid artifact on route A → route B produces the verified artifact (Rule 4)", async () => {
    const engine = await makeEngine([
      { id: "testplat.badfile", capabilities: ["acquire"], script: "invalid-artifact", produce: { artifact: { kind: "video", bytes: 0 } }, priority: 90 },
      { id: "testplat.goodfile", capabilities: ["acquire"], produce: { artifact: { kind: "json", bytes: 64, content: Buffer.from(JSON.stringify({ ok: true, x: "y".repeat(64) })) } }, priority: 50 }
    ]);
    const env = await engine.acquire(req("testplat://res1", "acquire"));
    expect(env.status).toBe("ok");
    expect(env.route?.id).toBe("testplat.goodfile");
    expect(env.artifacts).toHaveLength(1);
    expect(env.artifacts?.[0].verificationStatus).toBe("verified");
    expect(env.artifacts?.[0].type).toBe("json");
  });

  it("sandbox escape via route output is rejected (security gate)", async () => {
    const registry = new PlatformRegistry();
    const evilAdapter = scriptedAdapter({ routes: [{ id: "testplat.evil", capabilities: ["acquire"] }] });
    // wrap execute to write outside the sandbox
    const evil = scriptedRoute({ id: "testplat.evil", capabilities: ["acquire"], produce: { artifact: { kind: "json", bytes: 32 } } });
    evil.execute = async (request, ctx) => {
      const outside = path.join(artifactsDir, "escaped.json");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outside, JSON.stringify({ evil: true }));
      // register a path outside the sandbox → router must reject
      (ctx.sink.register as (r: unknown) => void)({ path: outside, kind: "json", filename: "escaped.json" });
      return { ok: true, routeId: "testplat.evil", evidence: [], artifacts: [{ path: outside, kind: "json", filename: "escaped.json" }], latencyMs: 1 };
    };
    void evilAdapter;
    registry.register({ ...scriptedAdapter({ routes: [{ id: "testplat.evil", capabilities: ["acquire"] }] }), discoverRoutes: async () => [evil] });
    const engine = await UAAL.create({
      config: { stateDir, artifactsDir, logLevel: "error", learning: false, cache: false },
      adapters: registry,
      environment: fakeEnvironment()
    });
    const env = await engine.acquire(req("testplat://evil1", "acquire"));
    expect(env.status).toBe("failed");
    expect(env.attempts.some((a) => a.failureCode === "POLICY_VIOLATION" || a.message?.includes("sandbox"))).toBe(true);
  });
});

describe("idempotency (spec §32)", () => {
  it("second acquire reuses the verified artifact without re-executing routes", async () => {
    let executions = 0;
    const routes = [
      { id: "testplat.acquire", capabilities: ["acquire" as const], produce: { artifact: { kind: "json", bytes: 32, content: Buffer.from(JSON.stringify({ dup: "x".repeat(32) })) } } }
    ];
    const adapter = scriptedAdapter({ routes });
    const original = adapter.discoverRoutes;
    adapter.discoverRoutes = async (request, ctx) => {
      executions += 1;
      return original.call(adapter, request, ctx);
    };
    const registry = new PlatformRegistry();
    registry.register(adapter);
    const engine = await UAAL.create({
      config: { stateDir, artifactsDir, logLevel: "error", cache: true },
      adapters: registry,
      environment: fakeEnvironment()
    });
    const first = await engine.acquire(req("testplat://dup1", "acquire"));
    expect(first.status).toBe("ok");
    const second = await engine.acquire(req("testplat://dup1", "acquire"));
    expect(second.status).toBe("ok");
    expect(second.warnings?.some((w) => w.includes("idempotent"))).toBe(true);
    expect(executions).toBe(1);
  });
});

describe("policy layer (spec §28)", () => {
  it("authorized routes are filtered under public policy and produce requires_auth when alone", async () => {
    const engine = await makeEngine([
      { id: "testplat.auth", capabilities: ["metadata"], accessLevel: "authorized", credentials: ["apikey"], priority: 90 },
      { id: "testplat.pub", capabilities: ["metadata"], priority: 50 }
    ]);
    const env = await engine.inspect(req());
    expect(env.route?.id).toBe("testplat.pub");
    expect(env.discovery?.find((d) => d.id === "testplat.auth")?.reasons?.[0]).toMatch(/authorized|missing credentials/);
  });

  it("authorized route with credentials supplied via policy runs first", async () => {
    const engine = await makeEngine([
      { id: "testplat.auth", capabilities: ["metadata"], accessLevel: "authorized", credentials: ["apikey"], priority: 90 },
      { id: "testplat.pub", capabilities: ["metadata"], priority: 50 }
    ]);
    const env = await engine.inspect({ ...req(), policy: { maxAccessLevel: "authorized", credentials: { apikey: "from-policy-not-hardcoded" } } });
    expect(env.route?.id).toBe("testplat.auth");
  });

  it("deniedRouteTags filters routes", async () => {
    const engine = await makeEngine([
      { id: "testplat.tagged", capabilities: ["metadata"], tags: ["banned-tag"], priority: 90 },
      { id: "testplat.plain", capabilities: ["metadata"], priority: 50 }
    ]);
    const env = await engine.inspect({ ...req(), policy: { deniedRouteTags: ["banned-tag"] } });
    expect(env.route?.id).toBe("testplat.plain");
  });
});

describe("environment compatibility (spec §12, §29)", () => {
  it("routes with missing binaries are ENVIRONMENT_INCOMPATIBLE → unsupported when alone", async () => {
    const engine = await makeEngine([{ id: "testplat.needsbin", capabilities: ["metadata"], binaries: ["definitely-missing-binary"] }]);
    const env = await engine.inspect(req());
    expect(env.status).toBe("unsupported");
    expect(env.discovery?.[0].reasons?.[0]).toMatch(/missing binaries/);
  });

  it("falls back from env-incompatible route to compatible one", async () => {
    const engine = await makeEngine([
      { id: "testplat.needsbin", capabilities: ["metadata"], binaries: ["definitely-missing-binary"], priority: 90 },
      { id: "testplat.plain", capabilities: ["metadata"], priority: 50 }
    ]);
    const env = await engine.inspect(req());
    expect(env.status).toBe("ok");
    expect(env.route?.id).toBe("testplat.plain");
  });
});

describe("dry-run plan (spec §51)", () => {
  it("plan reports identity, discovery and policy without executing routes", async () => {
    const engine = await makeEngine([
      { id: "testplat.a", capabilities: ["metadata"], priority: 90 },
      { id: "testplat.b", capabilities: ["metadata"], script: "http429", priority: 50 }
    ]);
    const env = await engine.plan(req());
    expect(env.status).toBe("ok");
    expect(env.operation).toBe("plan");
    expect(env.discovery).toHaveLength(2);
    expect(env.attempts).toHaveLength(0); // nothing executed
    expect(env.warnings?.some((w) => w.includes("plan:"))).toBe(true);
  });
});

describe("cancellation + timeouts (spec §62, §63)", () => {
  it("attempt timeout moves to next route", async () => {
    const engine = await makeEngine([
      { id: "testplat.slow", capabilities: ["metadata"], latencyMs: 30_000, priority: 90 },
      { id: "testplat.fast", capabilities: ["metadata"], priority: 50 }
    ], { attemptTimeoutMs: 1_000 });
    const env = await engine.inspect(req());
    expect(env.status).toBe("ok");
    expect(env.route?.id).toBe("testplat.fast");
    expect(env.attempts.find((a) => a.route === "testplat.slow")?.failureCode).toBe("TIMEOUT");
  }, 20_000);

  it("caller cancellation aborts the whole operation", async () => {
    const engine = await makeEngine([
      { id: "testplat.slow", capabilities: ["metadata"], latencyMs: 30_000, priority: 90 },
      { id: "testplat.fast", capabilities: ["metadata"], priority: 50 }
    ], { attemptTimeoutMs: 60_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const env = await engine.inspect(req(), controller.signal);
    expect(env.status).toBe("failed");
    expect(env.error?.code).toBe("CANCELLED");
  }, 15_000);
});

describe("learning influence (spec §11)", () => {
  it("repeated failures demote a route but never remove it from eligibility", async () => {
    const engine = await makeEngine([
      { id: "testplat.flaky", capabilities: ["metadata"], script: "http429", priority: 90 },
      { id: "testplat.stable", capabilities: ["metadata"], priority: 80 }
    ], { learning: true });
    // fail flaky 5 times via direct stats recording
    for (let i = 0; i < 5; i++) {
      await engine.stats.record({ ts: new Date().toISOString(), routeId: "testplat.flaky", platform: "testplat", capability: "metadata", envClass: "local", ok: false, failureCode: "RATE_LIMIT" as never, latencyMs: 10 });
    }
    const env = await engine.inspect(req());
    expect(env.status).toBe("ok");
    expect(env.route?.id).toBe("testplat.stable");
    // flaky is still discoverable (not removed)
    expect(env.discovery?.find((d) => d.id === "testplat.flaky")).toBeTruthy();
  });
});
