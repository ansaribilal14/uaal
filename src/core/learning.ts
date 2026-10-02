/**
 * Route-performance store + bounded learning (spec §11, §36). Learning is
 * optimization, NOT truth: learned penalties reorder routes but never remove
 * them from eligibility (deterministic fallback survives), never override
 * policy/safety constraints, and are fully reviewable/resettable.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { appendJsonl, atomicWriteJson, readFileJson } from "./security/paths.js";
import { FailureCode } from "./errors.js";

export interface RouteObservation {
  ts: string;
  routeId: string;
  platform: string;
  capability: string;
  envClass: string;
  ok: boolean;
  failureCode?: FailureCode;
  latencyMs: number;
  verified?: boolean;
}

export interface RouteStats {
  routeId: string;
  attempts: number;
  successes: number;
  failures: number;
  byFailure: Record<string, number>;
  successRatio: number;
  recentSuccessRatio: number;
  recentWindow: number;
  failureStreak: number;
  avgLatencyMs: number;
  verifiedRatio: number;
  /** Learned penalty applied during ranking (0 = none). Capped. */
  rankPenalty: number;
  cooldownUntil?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureCode?: FailureCode;
}

const MAX_FAILURE_STREAK_FOR_COOLDOWN = 3;
const MAX_RANK_PENALTY = 4;
const RECENT_WINDOW = 20;
const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 15 * 60_000;

export class RouteStatsStore {
  private stats = new Map<string, RouteStats>();
  private recent: RouteObservation[] = [];
  private readonly maxRecent = 500;
  private dirty = false;
  private filePath: string;
  private logPath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "route-stats.json");
    this.logPath = path.join(stateDir, "route-observations.jsonl");
  }

  async load(): Promise<void> {
    const loaded = await readFileJson<{ stats: Record<string, RouteStats> }>(this.filePath, { stats: {} });
    for (const [k, v] of Object.entries(loaded.stats ?? {})) {
      this.stats.set(k, v);
    }
  }

  private key(obs: Pick<RouteObservation, "routeId" | "capability" | "envClass">): string {
    return `${obs.routeId}::${obs.capability}::${obs.envClass}`;
  }

  async record(obs: RouteObservation): Promise<RouteStats> {
    // durable audit first (never lose the observation — ytagent pattern)
    try {
      await appendJsonl(this.logPath, obs, 5000);
    } catch {
      /* best effort */
    }
    const k = this.key(obs);
    let s = this.stats.get(k);
    if (!s) {
      s = emptyStats(obs.routeId);
      this.stats.set(k, s);
    }
    s.attempts += 1;
    s.avgLatencyMs = (s.avgLatencyMs * (s.attempts - 1) + obs.latencyMs) / s.attempts;
    if (obs.ok) {
      s.successes += 1;
      s.failureStreak = 0;
      s.lastSuccessAt = obs.ts;
      if (obs.verified !== false) {
        s.rankPenalty = Math.max(0, s.rankPenalty - 0.5);
      }
    } else {
      s.failures += 1;
      s.failureStreak += 1;
      s.lastFailureAt = obs.ts;
      s.lastFailureCode = obs.failureCode;
      s.byFailure[obs.failureCode ?? "UNKNOWN"] = (s.byFailure[obs.failureCode ?? "UNKNOWN"] ?? 0) + 1;
      // failure-type-aware cooldown (rate limits & blocks back off; env failures don't)
      if (s.failureStreak >= MAX_FAILURE_STREAK_FOR_COOLDOWN && (obs.failureCode === FailureCode.RATE_LIMIT || obs.failureCode === FailureCode.BLOCKED)) {
        const ms = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (s.failureStreak - MAX_FAILURE_STREAK_FOR_COOLDOWN));
        s.cooldownUntil = new Date(Date.now() + ms).toISOString();
      }
      s.rankPenalty = Math.min(MAX_RANK_PENALTY, s.rankPenalty + 1);
    }
    s.successRatio = s.attempts === 0 ? 0 : s.successes / s.attempts;
    this.recent.push(obs);
    if (this.recent.length > this.maxRecent) this.recent.splice(0, this.recent.length - this.maxRecent);
    const routeRecent = this.recent.filter((r) => this.key(r) === k).slice(-RECENT_WINDOW);
    const wins = routeRecent.filter((r) => r.ok).length;
    s.recentSuccessRatio = routeRecent.length > 0 ? wins / routeRecent.length : 0;
    s.recentWindow = routeRecent.length;
    if (obs.verified !== undefined) {
      const withVerdict = routeRecent.filter((r) => r.verified !== undefined);
      s.verifiedRatio = withVerdict.length > 0 ? withVerdict.filter((r) => r.verified).length / withVerdict.length : 0;
    }
    this.dirty = true;
    return s;
  }

  async persist(): Promise<void> {
    if (!this.dirty) return;
    const payload: Record<string, RouteStats> = {};
    for (const [k, v] of this.stats) payload[k] = v;
    await atomicWriteJson(this.filePath, { version: 1, updatedAt: new Date().toISOString(), stats: payload });
    this.dirty = false;
  }

  get(routeId: string, capability: string, envClass: string): RouteStats | undefined {
    return this.stats.get(`${routeId}::${capability}::${envClass}`);
  }

  all(): Array<RouteStats & { key: string }> {
    return [...this.stats.entries()].map(([key, s]) => ({ ...s, key }));
  }

  /** Learning-derived score for ranking (higher is better). Deterministic. */
  learningScore(routeId: string, capability: string, envClass: string, now = Date.now()): number {
    const s = this.get(routeId, capability, envClass);
    if (!s) return 0;
    let score = 0;
    score -= s.rankPenalty;
    if (s.recentWindow >= 5) score += (s.recentSuccessRatio - 0.5) * 2;
    if (s.cooldownUntil && new Date(s.cooldownUntil).getTime() > now) score -= 2.5;
    return score;
  }

  inCooldown(routeId: string, capability: string, envClass: string, now = Date.now()): boolean {
    const s = this.get(routeId, capability, envClass);
    return !!s?.cooldownUntil && new Date(s.cooldownUntil).getTime() > now;
  }

  /** Reversibility (spec §36): wipe learning, keep nothing. */
  async reset(routeId?: string): Promise<void> {
    if (!routeId) {
      this.stats.clear();
      this.recent = [];
    } else {
      for (const k of [...this.stats.keys()]) {
        if (k.startsWith(`${routeId}::`)) this.stats.delete(k);
      }
      this.recent = this.recent.filter((r) => r.routeId !== routeId);
    }
    this.dirty = true;
    await this.persist();
  }
}

function emptyStats(routeId: string): RouteStats {
  return {
    routeId,
    attempts: 0,
    successes: 0,
    failures: 0,
    byFailure: {},
    successRatio: 0,
    recentSuccessRatio: 0,
    recentWindow: 0,
    failureStreak: 0,
    avgLatencyMs: 0,
    verifiedRatio: 0,
    rankPenalty: 0
  };
}

/** Route observations logger directory bootstrap helper. */
export async function ensureStateDir(stateDir: string): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
}
