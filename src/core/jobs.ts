/**
 * Job manager (spec §31): long-running operations with states
 * queued→probing→executing→verifying→completed|partial|failed|cancelled,
 * cancellation propagation, timeouts, retries. State persisted atomically
 * per job; interrupted jobs are never falsely completed (spec §61).
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { JobRecord, JobState, ResourceRequest, UAALEnvelope } from "./contracts.js";
import { atomicWriteJson, readFileJson } from "./security/paths.js";

export interface JobHooks {
  run: (job: JobRecord, update: (patch: Partial<JobRecord>) => Promise<void>, signal: AbortSignal) => Promise<UAALEnvelope>;
}

export class JobManager {
  private dir: string;
  private jobs = new Map<string, JobRecord>();
  private controllers = new Map<string, AbortController>();
  private running = new Set<string>();

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "jobs");
  }

  async loadExisting(): Promise<number> {
    // recovery: any job not in a terminal state when we crashed is failed (never falsely completed)
    let recovered = 0;
    try {
      const files = await fs.readdir(this.dir);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const rec = await readFileJson<JobRecord | null>(path.join(this.dir, f), null);
        if (!rec) continue;
        const terminal = ["completed", "partial", "failed", "cancelled"];
        if (!terminal.includes(rec.state)) {
          rec.state = "failed";
          rec.error = { code: "INTERRUPTED", message: "process restarted while job was in flight; job did not complete" };
          rec.updatedAt = new Date().toISOString();
          rec.finishedAt = rec.updatedAt;
          await this.persist(rec);
          recovered++;
        }
        this.jobs.set(rec.jobId, rec);
      }
    } catch {
      /* fresh install */
    }
    return recovered;
  }

  async create(request: ResourceRequest, operation: JobRecord["operation"], opts: { timeoutMs?: number; maxRetries?: number } = {}): Promise<JobRecord> {
    const job: JobRecord = {
      jobId: `job_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      state: "queued",
      operation,
      request,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 0,
      maxRetries: opts.maxRetries ?? 0,
      timeoutMs: opts.timeoutMs
    };
    this.jobs.set(job.jobId, job);
    await this.persist(job);
    return job;
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  list(limit = 50): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async update(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord | undefined> {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await this.persist(job);
    return job;
  }

  private async persist(job: JobRecord): Promise<void> {
    await atomicWriteJson(path.join(this.dir, `${job.jobId}.json`), job);
  }

  /** Execute a job under supervision: cancellation + timeout + retries. */
  async execute(jobId: string, hooks: JobHooks): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (this.running.has(jobId)) return job;
    this.running.add(jobId);

    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    let timer: NodeJS.Timeout | null = null;

    try {
      await this.update(jobId, { state: "probing", startedAt: new Date().toISOString() });
      if (job.timeoutMs) {
        timer = setTimeout(() => controller.abort(new Error(`job timeout after ${job.timeoutMs}ms`)), job.timeoutMs);
      }
      const maxTries = (job.maxRetries ?? 0) + 1;
      let lastError: Error | undefined;

      for (let tryNo = 1; tryNo <= maxTries; tryNo++) {
        if (controller.signal.aborted) break;
        await this.update(jobId, { attempts: tryNo, state: "executing", cancelRequested: false });
        try {
          const envelope = await hooks.run(job, async (patch) => { await this.update(jobId, patch); }, controller.signal);
          const finalState: JobState = envelope.status === "ok" ? "completed" : envelope.status === "partial" ? "partial" : envelope.status === "failed" ? "failed" : "failed";
          const cancelled = controller.signal.aborted && !envelope;
          await this.update(jobId, {
            state: cancelled ? "cancelled" : finalState,
            result: envelope,
            finishedAt: new Date().toISOString()
          });
          return this.jobs.get(jobId)!;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (controller.signal.aborted) break;
          // retry only on transient failures, with backoff
          const transient = /timeout|network|429|5\d\d/i.test(lastError.message);
          if (tryNo < maxTries && transient) {
            await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** tryNo)));
            continue;
          }
          break;
        }
      }

      if (controller.signal.aborted) {
        await this.update(jobId, {
          state: "cancelled",
          error: { code: "CANCELLED", message: lastError?.message ?? "cancelled" },
          finishedAt: new Date().toISOString()
        });
      } else {
        await this.update(jobId, {
          state: "failed",
          error: { code: "JOB_FAILED", message: lastError?.message ?? "unknown error" },
          finishedAt: new Date().toISOString()
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.running.delete(jobId);
      this.controllers.delete(jobId);
    }
    return this.jobs.get(jobId)!;
  }

  cancel(jobId: string): boolean {
    const controller = this.controllers.get(jobId);
    if (!controller) {
      const job = this.jobs.get(jobId);
      if (job && !["completed", "partial", "failed", "cancelled"].includes(job.state)) {
        void this.update(jobId, { cancelRequested: true, state: "cancelled", error: { code: "CANCELLED", message: "cancelled before start" }, finishedAt: new Date().toISOString() });
        return true;
      }
      return false;
    }
    controller.abort(new Error("cancelled by caller"));
    void this.update(jobId, { cancelRequested: true });
    return true;
  }
}
