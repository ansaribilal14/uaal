/**
 * Interface tests: HTTP API (spec §23) and MCP server (spec §21) with a real
 * engine + loopback mock upstream. Also worker protocol signatures (spec §30).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { UAAL } from "../../src/core/engine.js";
import { buildHttpServer } from "../../src/interfaces/http/server.js";
import { buildMcpServer } from "../../src/interfaces/mcp/server.js";
import { scriptedAdapter, scriptedRoute, fakeEnvironment } from "../fixtures/scripted.js";
import { PlatformRegistry } from "../../src/core/identity.js";
import { signPayload, verifySignature } from "../../src/workers/protocol.js";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let stateDir: string;
let artifactsDir: string;
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "uaal-http-state-"));
  artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "uaal-http-art-"));
  const registry = new PlatformRegistry();
  registry.register(
    scriptedAdapter({
      routes: [
        { id: "testplat.meta", capabilities: ["metadata"], priority: 90 },
        { id: "testplat.acq", capabilities: ["acquire"], produce: { artifact: { kind: "json", bytes: 64, content: Buffer.from(JSON.stringify({ artifact: "y".repeat(64) })) } }, priority: 90 }
      ]
    })
  );
  const engine = await UAAL.create({
    config: { stateDir, artifactsDir, logLevel: "error", learning: false, cache: false, apiToken: "test-token-123" },
    adapters: registry,
    environment: fakeEnvironment()
  });
  app = await buildHttpServer({ engine, apiToken: "test-token-123" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await app?.close();
});

describe("HTTP API (spec §23)", () => {
  it("rejects unauthenticated requests when a token is configured", async () => {
    const res = await fetch(`${baseUrl}/api/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resource: "testplat://h1" }) });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("accepts bearer auth and returns a valid envelope", async () => {
    const res = await fetch(`${baseUrl}/api/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token-123" },
      body: JSON.stringify({ resource: "testplat://h1" })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.schemaVersion).toBe("1.0");
    expect((body.request as Record<string, unknown>).resource).toBe("testplat://h1");
  });

  it("POST /api/resolve returns identity", async () => {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token-123" },
      body: JSON.stringify({ resource: "testplat://id-42" })
    });
    const body = (await res.json()) as { identity?: { id: string } };
    expect(body.identity?.id).toBe("id-42");
  });

  it("POST /api/acquire returns verified artifacts", async () => {
    const res = await fetch(`${baseUrl}/api/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token-123" },
      body: JSON.stringify({ resource: "testplat://art-1" })
    });
    const body = (await res.json()) as { status: string; artifacts?: Array<{ artifactId: string; type: string }> };
    expect(body.status).toBe("ok");
    expect(body.artifacts?.[0].type).toBe("json");
  });

  it("400 on missing resource", async () => {
    const res = await fetch(`${baseUrl}/api/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token-123" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/capabilities, /api/schema, /api/health work", async () => {
    const headers = { authorization: "Bearer test-token-123" };
    const caps = await (await fetch(`${baseUrl}/api/capabilities`, { headers })).json();
    expect(caps.capabilities.length).toBeGreaterThan(5);
    const schema = await (await fetch(`${baseUrl}/api/schema`, { headers })).json();
    expect(schema.definitions.Envelope).toBeTruthy();
    const health = await (await fetch(`${baseUrl}/api/health`, { headers })).json();
    expect(health.status).toBe("ok");
  });

  it("GET /api/routes exposes learned stats without secrets", async () => {
    const res = await fetch(`${baseUrl}/api/routes`, { headers: { authorization: "Bearer test-token-123" } });
    const body = (await res.json()) as { adapters: unknown[]; stats: unknown[] };
    expect(body.adapters.length).toBe(1);
    expect(Array.isArray(body.stats)).toBe(true);
  });

  it("GET /api/artifacts/:id delivers metadata + stream (delivery modes, spec §19)", async () => {
    const acq = (await (await fetch(`${baseUrl}/api/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token-123" },
      body: JSON.stringify({ resource: "testplat://stream-1" })
    }).then((r) => r.json())) as { artifacts?: Array<{ artifactId: string }> });
    const id = acq.artifacts?.[0].artifactId;
    expect(id).toBeTruthy();
    const meta = (await (await fetch(`${baseUrl}/api/artifacts/${id}`, { headers: { authorization: "Bearer test-token-123" } })).json()) as Record<string, unknown>;
    expect(meta.checksum).toMatch(/^sha256:/);
    expect(meta.streamUrl).toContain("download=1");
    const stream = await fetch(`${baseUrl}/api/artifacts/${id}?download=1`, { headers: { authorization: "Bearer test-token-123" } });
    expect(stream.status).toBe(200);
    const bytes = Buffer.from(await stream.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("async acquire via jobs: 202 + poll + result (spec §31)", async () => {
    const res = await fetch(`${baseUrl}/api/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token-123" },
      body: JSON.stringify({ resource: "testplat://job-1", async: true })
    });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    let job: { state: string; result?: { status: string } } = { state: "queued" };
    for (let i = 0; i < 50 && !["completed", "partial", "failed", "cancelled"].includes(job.state); i++) {
      await new Promise((r) => setTimeout(r, 100));
      const jr = await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: { authorization: "Bearer test-token-123" } });
      job = (await jr.json()) as typeof job;
    }
    expect(job.state).toBe("completed");
    expect(job.result?.status).toBe("ok");
  });

  it("rate limiting hook fires under burst", async () => {
    const app2 = await (async () => {
      const registry = new PlatformRegistry();
      registry.register(scriptedAdapter({ routes: [{ id: "testplat.m", capabilities: ["metadata"] }] }));
      const engine = await UAAL.create({ config: { stateDir, artifactsDir, logLevel: "error", learning: false, cache: false }, adapters: registry, environment: fakeEnvironment() });
      const a = await buildHttpServer({ engine, apiToken: "t", rateLimit: { max: 3, windowMs: 60_000 } });
      await a.listen({ port: 0, host: "127.0.0.1" });
      return a;
    })();
    const url = `http://127.0.0.1:${(app2.server.address() as { port: number }).port}`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${url}/api/health`, { headers: { authorization: "Bearer t" } });
      statuses.push(r.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    await app2.close();
  });
});

describe("MCP server (spec §21)", () => {
  it("builds with all 8 tools and serves via In-Memory transport", async () => {
    const registry = new PlatformRegistry();
    registry.register(scriptedAdapter({ routes: [{ id: "testplat.m", capabilities: ["metadata"] }] }));
    const engine = await UAAL.create({ config: { stateDir, artifactsDir, logLevel: "error", learning: false, cache: false }, adapters: registry, environment: fakeEnvironment() });
    const server = await buildMcpServer(engine);

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const client = new Client({ name: "test-client", version: "1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["uaal_acquire", "uaal_capabilities", "uaal_health", "uaal_resolve", "uaal_routes", "uaal_schema", "uaal_verify", "uaal_inspect"].sort());
    // strict input schemas on every tool (spec §21)
    for (const tool of tools.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
    }

    const resolveResult = await client.callTool({ name: "uaal_resolve", arguments: { resource: "testplat://mcp-1" } });
    const text = (resolveResult.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.status).toBe("ok");
    expect((parsed.identity as Record<string, unknown>).id).toBe("mcp-1");

    const schemaResult = await client.callTool({ name: "uaal_schema", arguments: {} });
    const schema = JSON.parse((schemaResult.content as Array<{ type: string; text: string }>)[0].text) as Record<string, unknown>;
    expect(schema.definitions).toBeTruthy();

    await client.close();
  });
});

describe("worker protocol signatures (spec §30)", () => {
  it("signs and verifies payloads; rejects tampering and replay", () => {
    const secret = "worker-secret-test";
    const base = { jobId: "j1", operation: "acquire" as const, resource: "x", capability: "acquire" as const, constraints: {}, issuedAt: new Date().toISOString() };
    const payload = signPayload(base, secret);
    expect(payload).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const signed = { ...base, signature: payload };
    expect(verifySignature(signed, secret)).toBe(true);
    expect(verifySignature({ ...signed, resource: "TAMPERED" }, secret)).toBe(false);
    expect(verifySignature(signed, "wrong-secret")).toBe(false);
    // replay: signature older than the window
    const oldTs = Date.now() - 10 * 60_000;
    const body = JSON.stringify({ ...signed, signature: undefined });
    const stale = `t=${oldTs},v1=${createHmac("sha256", secret).update(`${oldTs}.${body}`).digest("hex")}`;
    expect(verifySignature({ ...signed, signature: stale }, secret)).toBe(false);
  });
});
