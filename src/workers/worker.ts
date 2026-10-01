/**
 * Remote worker (spec §29-30): connects to a UAAL coordinator, claims jobs,
 * executes them through the same local engine (same verification gates),
 * and posts signed results back. Artifacts are returned inline (base64,
 * size-capped) or via contentUrl when too large.
 */
import { UAAL } from "../core/engine.js";
import type { RemoteJobPayload, RemoteJobResult } from "./protocol.js";
import { signPayload, validateCoordinatorUrl } from "./protocol.js";
import { Logger } from "../core/observability.js";
import { sha256File } from "../core/security/paths.js";
import { promises as fs } from "node:fs";

export interface WorkerOptions {
  coordinatorUrl: string;
  secret: string;
  pollIntervalMs?: number;
  /** Max inline artifact size (base64) before falling back to contentUrl. */
  inlineArtifactCapBytes?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
}

export class UaalWorker {
  private opts: Required<WorkerOptions>;
  private logger: Logger;
  private stopped = false;

  constructor(opts: WorkerOptions) {
    this.opts = {
      pollIntervalMs: 2_000,
      inlineArtifactCapBytes: 8 * 1024 * 1024,
      logLevel: "info",
      ...opts
    };
    this.logger = new Logger({ level: this.opts.logLevel });
    validateCoordinatorUrl(this.opts.coordinatorUrl, isLoopback(this.opts.coordinatorUrl));
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    const engine = await UAAL.create({ config: { logLevel: this.opts.logLevel } });
    this.logger.info("worker started", { coordinator: this.opts.coordinatorUrl.replace(/\/\/.*@/, "//[REDACTED]@") });
    while (!this.stopped) {
      try {
        const job = await this.claim();
        if (!job) {
          await sleep(this.opts.pollIntervalMs);
          continue;
        }
        this.logger.info("claimed job", { jobId: job.jobId, operation: job.operation });
        const result = await this.execute(engine, job);
        await this.submit(result);
      } catch (err) {
        this.logger.warn("worker loop error", { err: (err as Error).message.slice(0, 200) });
        await sleep(this.opts.pollIntervalMs);
      }
    }
  }

  private async claim(): Promise<RemoteJobPayload | null> {
    const url = `${this.opts.coordinatorUrl.replace(/\/$/, "")}/worker/jobs/claim`;
    const res = await fetch(url, { method: "POST", headers: this.headers({}), body: JSON.stringify(this.signed({})) });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`claim failed: HTTP ${res.status}`);
    return (await res.json()) as RemoteJobPayload;
  }

  private async execute(engine: UAAL, job: RemoteJobPayload): Promise<RemoteJobResult> {
    const request = {
      resource: job.resource,
      capability: job.capability,
      platform: job.constraints.platform,
      output: job.constraints.output,
      policy: job.constraints.policy
    };
    try {
      const envelope =
        job.operation === "acquire"
          ? await engine.acquire(request)
          : job.operation === "inspect"
            ? await engine.inspect(request)
            : job.operation === "verify"
              ? await engine.verifyArtifact({ artifactId: job.resource.startsWith("art_") ? job.resource : undefined, path: job.resource.startsWith("art_") ? undefined : job.resource })
              : await engine.resolve(request);

      const artifacts = [];
      for (const a of envelope.artifacts ?? []) {
        const stat = await fs.stat(a.path).catch(() => null);
        if (!stat) continue;
        const base = { filename: a.filename, mimeType: a.mimeType, size: a.size, checksum: a.checksum };
        if (a.size <= this.opts.inlineArtifactCapBytes) {
          const content = await fs.readFile(a.path);
          artifacts.push({ ...base, contentBase64: content.toString("base64") });
        } else {
          artifacts.push({ ...base, contentUrl: `uaal-artifact://${a.artifactId}` });
        }
      }
      return {
        jobId: job.jobId,
        status: envelope.status === "ok" ? "completed" : envelope.status === "partial" ? "partial" : "failed",
        envelope,
        artifacts
      };
    } catch (err) {
      return { jobId: job.jobId, status: "failed", errors: [{ code: "WORKER_ERROR", message: (err as Error).message.slice(0, 300) }] };
    }
  }

  private async submit(result: RemoteJobResult): Promise<void> {
    const url = `${this.opts.coordinatorUrl.replace(/\/$/, "")}/worker/jobs/${result.jobId}/result`;
    const res = await fetch(url, { method: "POST", headers: this.headers(result), body: JSON.stringify(this.signed(result)) });
    if (!res.ok) throw new Error(`submit failed: HTTP ${res.status}`);
  }

  /** The signature covers the JSON body; headers restate identity. */
  private signed(payload: object): Record<string, unknown> {
    return { ...(payload as Record<string, unknown>), signature: signPayload({ ...(payload as unknown as Omit<RemoteJobPayload, "signature">), jobId: ((payload as Record<string, unknown>).jobId as string) ?? "poll" }, this.opts.secret) };
  }

  private headers(body: unknown): Record<string, string> {
    return { "content-type": "application/json", "x-uaal-worker": "1", "x-uaal-poll": body && Object.keys(body).length === 0 ? "1" : "0" };
  }
}

function isLoopback(url: string): boolean {
  try {
    const u = new URL(url);
    return ["127.0.0.1", "::1", "localhost"].includes(u.hostname);
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { sha256File };
