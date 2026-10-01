/**
 * HTTP API (spec §23): Fastify server exposing the universal contract.
 * Bearer-token auth hook (optional via UAAL_API_KEY), per-IP rate limiting
 * hook, request ids, structured errors, async jobs, artifact delivery,
 * graceful shutdown. Unsafe administrative operations are not exposed.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { UAAL } from "../../core/engine.js";
import type { ResourceRequest, UAALConfig } from "../../core/contracts.js";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";

export interface HttpServerOptions {
  engine: UAAL;
  port?: number;
  host?: string;
  apiToken?: string;
  rateLimit?: { max: number; windowMs: number };
}

interface RateBucket {
  count: number;
  resetAt: number;
}

export async function buildHttpServer(opts: HttpServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, requestTimeout: 300_000, bodyLimit: 2 * 1024 * 1024, genReqId: () => randomUUID() });
  const engine = opts.engine;
  const token = opts.apiToken ?? process.env.UAAL_API_KEY;
  const bucket = new Map<string, RateBucket>();
  const rl = opts.rateLimit ?? { max: 60, windowMs: 60_000 };

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    (req as unknown as { uaalStarted: number }).uaalStarted = Date.now();
    // rate limiting (per IP, in-memory)
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const b = bucket.get(ip);
    if (!b || b.resetAt < now) {
      bucket.set(ip, { count: 1, resetAt: now + rl.windowMs });
    } else {
      b.count += 1;
      if (b.count > rl.max) {
        return reply.code(429).send({ status: "failed", error: { code: "RATE_LIMITED", message: "too many requests" } });
      }
    }
    // auth hook (exempt health)
    if (token && req.url !== "/api/health") {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${token}`) {
        return reply.code(401).send({ status: "failed", error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } });
      }
    }
    // pass through (async hooks must return undefined when not replying)
  });

  const parseRequest = (body: unknown): ResourceRequest => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.resource !== "string" || b.resource.length === 0) {
      throw Object.assign(new Error("body.resource is required"), { statusCode: 400 });
    }
    const req: ResourceRequest = { resource: b.resource };
    if (typeof b.platform === "string") req.platform = b.platform;
    if (typeof b.capability === "string") req.capability = b.capability as ResourceRequest["capability"];
    if (b.output && typeof b.output === "object") req.output = b.output as ResourceRequest["output"];
    if (b.policy && typeof b.policy === "object") {
      const p = { ...(b.policy as Record<string, unknown>) };
      delete p.credentials; // credentials never accepted from HTTP body by default
      req.policy = p as ResourceRequest["policy"];
    }
    if (typeof b.requestId === "string") req.requestId = b.requestId;
    return req;
  };

  app.post("/api/resolve", async (req) => await engine.resolve(parseRequest(req.body)));
  app.post("/api/inspect", async (req) => engine.inspect(parseRequest(req.body)));
  app.post("/api/plan", async (req) => engine.plan(parseRequest(req.body)));

  app.post("/api/acquire", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const request = parseRequest(req.body);
    if (body.async === true) {
      const job = await engine.jobs.create(request, "acquire", { timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined, maxRetries: typeof body.maxRetries === "number" ? body.maxRetries : 0 });
      void engine.jobs.execute(job.jobId, {
        run: async (jobRec, update, signal) => {
          await update({ state: "executing" });
          const envelope = await engine.acquire(jobRec.request, signal);
          return envelope;
        }
      });
      reply.code(202);
      return { jobId: job.jobId, state: job.state, poll: `/api/jobs/${job.jobId}` };
    }
    return engine.acquire(request);
  });

  app.post("/api/verify", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return engine.verifyArtifact({ artifactId: typeof b.artifactId === "string" ? b.artifactId : undefined, path: typeof b.path === "string" ? b.path : undefined });
  });

  app.get("/api/routes", async () => ({
    schemaVersion: "1.0",
    stats: engine.stats.all(),
    adapters: engine.registry.all().map((a) => ({ platform: a.id, capabilities: a.capabilities().map((c) => c.name), limitations: a.limitations() }))
  }));

  app.get("/api/capabilities", async () => engine.capabilitiesInfo());
  app.get("/api/schema", async () => engine.schemaInfo());
  app.get("/api/health", async () => await engine.health());

  app.get("/api/jobs/:id", async (req, reply) => {
    const job = engine.jobs.get((req.params as { id: string }).id);
    if (!job) {
      reply.code(404);
      return { status: "failed", error: { code: "NOT_FOUND", message: "unknown job" } };
    }
    return job;
  });

  app.post("/api/jobs/:id/cancel", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = engine.jobs.cancel(id);
    if (!ok) {
      reply.code(409);
      return { status: "failed", error: { code: "NOT_CANCELLABLE", message: "job not running or already terminal" } };
    }
    return { cancelled: true, jobId: id };
  });

  app.get("/api/artifacts/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const artifact = engine.artifacts.get(id);
    if (!artifact) {
      reply.code(404);
      return { status: "failed", error: { code: "NOT_FOUND", message: "unknown artifact" } };
    }
    const download = (req.query as Record<string, string>).download === "1";
    if (download) {
      const stat = await fs.stat(artifact.path).catch(() => null);
      if (!stat) {
        reply.code(410);
        return { status: "failed", error: { code: "ARTIFACT_GONE", message: "artifact file missing" } };
      }
      reply.header("content-type", artifact.mimeType);
      reply.header("content-length", stat.size);
      reply.header("content-disposition", `attachment; filename="${artifact.filename}"`);
      return createReadStream(artifact.path);
    }
    return { ...engine.artifacts.delivery(artifact), path: undefined, localPath: undefined, streamUrl: `/api/artifacts/${id}?download=1` };
  });

  app.get("/api/sessions", async (req) => ({ sessions: await engine.sessions.list(Number((req.query as Record<string, string>).limit ?? 20)) }));

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    reply.code(statusCode).send({ status: "failed", error: { code: statusCode === 400 ? "BAD_REQUEST" : "INTERNAL_ERROR", message: err.message.slice(0, 300) } });
  });

  const graceful = async (signal: string): Promise<void> => {
    engine.logger.info(`http: ${signal} received, shutting down gracefully`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void graceful("SIGTERM"));
  process.on("SIGINT", () => void graceful("SIGINT"));

  return app;
}

export async function startHttpServer(config: UAALConfig, overrides: { port?: number; host?: string } = {}): Promise<{ app: FastifyInstance; url: string }> {
  const engine = await UAAL.create({ config });
  const app = await buildHttpServer({ engine, apiToken: config.apiToken });
  const port = overrides.port ?? numEnv("UAAL_HTTP_PORT") ?? 7800;
  const host = overrides.host ?? "127.0.0.1";
  await app.listen({ port, host });
  return { app, url: `http://${host}:${port}` };
}

function numEnv(name: string): number | undefined {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export { path };
