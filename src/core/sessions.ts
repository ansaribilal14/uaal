/**
 * Session / execution history (spec §35, AgentUse pattern): every operation
 * records its request, tool calls, route attempts, failures, verification,
 * artifacts and timings for later inspection. Sensitive values redacted at
 * write time by the observability layer.
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AttemptRecord, ResourceRequest, UAALEnvelope } from "./contracts.js";
import { atomicWriteJson, readFileJson } from "./security/paths.js";
import { Trace } from "./observability.js";

export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  request: ResourceRequest;
  operation: string;
  status?: string;
  trace: Array<{ at: string; event: string }>;
  attempts?: AttemptRecord[];
  artifacts?: Array<{ artifactId: string; type: string; size: number }>;
  final?: Pick<UAALEnvelope, "status" | "route" | "verification" | "error" | "timing">;
  durationMs?: number;
}

export class SessionStore {
  private dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "sessions");
  }

  begin(request: ResourceRequest, operation: string, trace: Trace): SessionRecord {
    const rec: SessionRecord = {
      sessionId: `sess_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      createdAt: new Date().toISOString(),
      request,
      operation,
      trace: trace.toRecords().map((e) => ({ at: e.at, event: e.event }))
    };
    void this.write(rec);
    return rec;
  }

  finish(rec: SessionRecord, envelope: UAALEnvelope, trace: Trace): void {
    rec.status = envelope.status;
    rec.attempts = envelope.attempts;
    rec.artifacts = envelope.artifacts?.map((a) => ({ artifactId: a.artifactId, type: a.type, size: a.size }));
    rec.final = { status: envelope.status, route: envelope.route, verification: envelope.verification, error: envelope.error, timing: envelope.timing };
    rec.durationMs = envelope.timing.durationMs;
    rec.trace = trace.toRecords().map((e) => ({ at: e.at, event: e.event }));
    void this.write(rec);
  }

  private async write(rec: SessionRecord): Promise<void> {
    try {
      await atomicWriteJson(path.join(this.dir, `${rec.sessionId}.json`), rec);
    } catch {
      /* session writes are best-effort */
    }
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    return readFileJson<SessionRecord | undefined>(path.join(this.dir, `${sessionId}.json`), undefined);
  }

  async list(limit = 50): Promise<SessionRecord[]> {
    const { readdir } = await import("node:fs/promises");
    try {
      const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit);
      const out: SessionRecord[] = [];
      for (const f of files) {
        const rec = await readFileJson<SessionRecord | null>(path.join(this.dir, f), null);
        if (rec) out.push(rec);
      }
      return out;
    } catch {
      return [];
    }
  }
}
