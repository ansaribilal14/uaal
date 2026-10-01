/**
 * End-to-end smoke test (offline-safe): boots the engine, runs resolve /
 * inspect / acquire against the scripted pipeline, validates envelopes, and
 * prints a pass/fail summary. Live network checks run via `uaal` CLI instead.
 */
import { UAAL } from "../src/core/engine.js";
import { validateEnvelope } from "../src/core/schemas.js";
import { PlatformRegistry } from "../src/core/identity.js";
import { scriptedAdapter, fakeEnvironment } from "../tests/fixtures/scripted.js";

async function main(): Promise<void> {
  const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string): void => results.push({ check: name, ok, detail });

  const registry = new PlatformRegistry();
  registry.register(
    scriptedAdapter({
      routes: [
        { id: "testplat.a", capabilities: ["metadata"], script: "http429", priority: 90 },
        { id: "testplat.b", capabilities: ["metadata"], priority: 50 },
        { id: "testplat.acq", capabilities: ["acquire"], produce: { artifact: { kind: "json", bytes: 128, content: Buffer.from(JSON.stringify({ smoke: "x".repeat(128) })) } }, priority: 50 }
      ]
    })
  );
  const engine = await UAAL.create({ config: { logLevel: "error", learning: false, cache: false }, adapters: registry, environment: fakeEnvironment() });

  const resolved = await engine.resolve({ resource: "testplat://smoke-1" });
  check("resolve returns ok", resolved.status === "ok");
  check("resolve envelope validates", validateEnvelope(resolved).ok);

  const inspected = await engine.inspect({ resource: "testplat://smoke-1" });
  check("inspect falls back past 429", inspected.status === "ok" && inspected.route?.id === "testplat.b");

  const acquired = await engine.acquire({ resource: "testplat://smoke-2" });
  check("acquire produces verified artifact", acquired.status === "ok" && acquired.artifacts?.[0].verificationStatus === "verified");
  const reAcquired = await engine.acquire({ resource: "testplat://smoke-2" });
  check("acquire is idempotent", reAcquired.warnings?.some((w) => w.includes("idempotent")) === true);

  const health = (await engine.health()) as { status: string; dependencies: Record<string, boolean> };
  check("health reports ok", health.status === "ok");

  const schema = engine.schemaInfo() as { definitions: Record<string, unknown> };
  check("schema export includes envelope", !!schema.definitions?.Envelope);

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.check}${r.detail ? ` — ${r.detail}` : ""}`);
  if (failed.length > 0) {
    console.error(`smoke: ${failed.length} failure(s)`);
    process.exit(1);
  }
  console.log(`smoke: all ${results.length} checks passed`);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
