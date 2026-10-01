/**
 * Capability router (spec §8, §9, §10, §11).
 *
 * Discovery (deterministic + explainable):
 *   discover routes → filter incompatible/disabled/policy-ineligible →
 *   probe where useful → rank (priority + bounded learning + probe confidence)
 *
 * Execution (single attempt per call; the engine owns the fallback loop):
 *   sandboxed temp dir → deadline + cancellation → never-raise →
 *   failure classification → observation recording → cooldown handling.
 *
 * Learning reorders but NEVER removes routes from eligibility (spec §11).
 */
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AccessPolicy } from "./contracts.js";
import type {
  AccessRoute,
  AttemptRecord,
  Capability,
  DiscoveredRouteInfo,
  EnvironmentProfile,
  Evidence,
  ExecutionContext,
  PlatformAdapter,
  RawArtifactRef,
  ResourceIdentity,
  ResourceRequest,
  RouteResult
} from "./contracts.js";
import { FailureCode, UAALError, type Failure } from "./errors.js";
import { evaluateRoutePolicy } from "./policy.js";
import { RouteStatsStore } from "./learning.js";
import { ArtifactStore } from "./artifacts/store.js";
import { Logger, Trace } from "./observability.js";
import { classifyFailure } from "./errors.js";
import { sanitizeFilename } from "./security/paths.js";

export interface RouterDeps {
  stats: RouteStatsStore;
  artifacts: ArtifactStore;
  logger: Logger;
  attemptTimeoutMs: number;
  maxDownloadBytes: number;
}

export interface RankedRoute {
  route: AccessRoute;
  score: number;
  confidence: number;
  eligible: boolean;
  reason: string;
}

export interface DiscoveryOutput {
  ranked: RankedRoute[];
  discovery: DiscoveredRouteInfo[];
}

export interface AttemptOutput {
  result: RouteResult | null;
  attempt: AttemptRecord;
  failure?: Failure;
  verifiedArtifacts: import("./contracts.js").Artifact[];
}

export class CapabilityRouter {
  private deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.deps = deps;
  }

  /**
   * Deterministic route discovery for one (adapter, capability, environment,
   * policy) tuple. Returns explanations for every candidate (spec §9).
   */
  async discover(
    adapter: PlatformAdapter,
    request: ResourceRequest,
    identity: ResourceIdentity,
    capability: Capability,
    environment: EnvironmentProfile,
    policy: Required<AccessPolicy>
  ): Promise<DiscoveryOutput> {
    const routes = await adapter.discoverRoutes(request, {
      environment,
      policy,
      identity,
      capability
    });

    const envClass = environment.envClass;
    const ranked: RankedRoute[] = [];

    for (const route of routes) {
      const reasons: string[] = [];
      let eligible = true;
      let confidence = 0.5;

      if (!route.enabled) {
        eligible = false;
        reasons.push("route disabled");
      }
      if (!route.capabilities.includes(capability)) {
        eligible = false;
        reasons.push(`capability ${capability} not served (serves: ${route.capabilities.join(",")})`);
      }
      // environment compatibility
      const reqBins = route.requirements.binaries ?? [];
      const missingBins = reqBins.filter((b) => !environment.binaries[b]);
      if (missingBins.length > 0) {
        eligible = false;
        reasons.push(`missing binaries: ${missingBins.join(", ")}`);
      }
      if (route.requirements.network && !environment.network.ipv4 && !environment.network.ipv6) {
        eligible = false;
        reasons.push("no network capability");
      }
      // local/remote compatibility (spec §29)
      if (route.environmentCompatibility.local === false && !request.environment?.execution) {
        eligible = false;
        reasons.push("route requires remote execution provider");
      }
      // policy
      const decision = evaluateRoutePolicy(route, policy);
      if (!decision.eligible) {
        eligible = false;
        reasons.push(decision.reason);
      }

      // learning + cooldown (never removes eligibility — spec §11)
      const learnScore = this.deps.stats.learningScore(route.id, capability, envClass);
      const cooldown = this.deps.stats.inCooldown(route.id, capability, envClass);
      const stats = this.deps.stats.get(route.id, capability, envClass);
      if (stats && stats.attempts >= 3) {
        confidence = Math.max(0.05, Math.min(0.95, stats.recentSuccessRatio));
        reasons.push(`learning: recent success ${(stats.recentSuccessRatio * 100).toFixed(0)}% over ${stats.recentWindow}`);
      } else {
        confidence = route.priority >= 80 ? 0.8 : route.priority >= 50 ? 0.6 : 0.4;
      }
      if (cooldown) reasons.push(`in cooldown until ${stats?.cooldownUntil}`);

      const score = route.priority + learnScore + (cooldown ? -2.5 : 0);
      ranked.push({ route, score, confidence, eligible, reason: reasons.join("; ") || "eligible" });
    }

    // deterministic order: eligible first, then score desc, then id asc
    ranked.sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.route.id.localeCompare(b.route.id);
    });

    const discovery: DiscoveredRouteInfo[] = ranked.map((r) => ({
      id: r.route.id,
      platform: r.route.platform,
      capabilities: r.route.capabilities,
      status: r.eligible ? "available" : r.route.enabled ? "filtered" : "disabled",
      confidence: Number(r.confidence.toFixed(2)),
      priority: r.route.priority,
      tags: r.route.tags,
      accessLevel: r.route.accessLevel,
      reasons: r.reason ? [r.reason] : undefined
    }));

    return { ranked, discovery };
  }

  /**
   * Execute ONE route with full isolation. Never raises (ytagent boundary):
   * every failure becomes a classified RouteResult/AttemptRecord.
   */
  async attempt(
    route: AccessRoute,
    request: ResourceRequest,
    identity: ResourceIdentity,
    capability: Capability,
    environment: EnvironmentProfile,
    policy: Required<AccessPolicy>,
    signal: AbortSignal,
    deadlineAt: number,
    trace: Trace
  ): Promise<AttemptOutput> {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const remainingMs = Math.max(1_000, deadlineAt - startedMs);
    const attemptTimeoutMs = policy.attemptTimeoutMs > 0 ? policy.attemptTimeoutMs : this.deps.attemptTimeoutMs;
    const effectiveTimeout = Math.min(remainingMs, attemptTimeoutMs);

    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort(new Error("cancelled by caller"));
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`route timeout after ${effectiveTimeout}ms`)), effectiveTimeout);

    const tmpDir = await this.deps.artifacts.tempDirFor(route.id, identity.fingerprint);
    const collected: RawArtifactRef[] = [];
    const sink = {
      allocate: (suggestedName: string) => ({ path: path.join(tmpDir, sanitizeFilename(suggestedName || randomUUID().slice(0, 8))) }),
      register: (ref: RawArtifactRef) => {
        // defensive: route outputs must stay inside its sandbox
        const resolved = path.resolve(ref.path);
        if (!resolved.startsWith(path.resolve(tmpDir))) {
          throw new UAALError({ code: FailureCode.POLICY_VIOLATION, message: `route wrote outside its sandbox: ${ref.path}`, subject: route.id, retryable: false });
        }
        collected.push(ref);
      }
    };

    const log = this.deps.logger.child({ route: route.id });
    const ctx: ExecutionContext = {
      request,
      identity,
      capability,
      environment,
      policy,
      signal: controller.signal,
      deadlineAt: startedMs + effectiveTimeout,
      workingDir: tmpDir,
      sink,
      log: {
        debug: (m, f) => log.debug(m, { route: route.id, ...f }),
        info: (m, f) => log.info(m, { route: route.id, ...f }),
        warn: (m, f) => log.warn(m, { route: route.id, ...f }),
        error: (m, f) => log.error(m, { route: route.id, ...f })
      },
      hash: (data) => createHash("sha256").update(data).digest("hex")
    };

    let result: RouteResult;
    try {
      trace.add("route.execute.start", { route: route.id });
      // Race execution against the deadline/abort signal: routes that ignore
      // the abort signal must never hang the fallback loop (spec §62/§63).
      const execution = route.execute(request, ctx);
      execution.catch(() => {}); // no unhandled rejection when the race is lost
      const abortRace = new Promise<RouteResult>((resolve) => {
        const settle = (): void => {
          const reason = String(controller.signal.reason?.message ?? "");
          const code = /cancelled by caller/i.test(reason) ? FailureCode.CANCELLED : FailureCode.TIMEOUT;
          resolve({
            ok: false,
            routeId: route.id,
            evidence: [],
            artifacts: [],
            failure: { code, message: reason || `route deadline after ${effectiveTimeout}ms`, subject: route.id, retryable: code === FailureCode.TIMEOUT },
            latencyMs: Date.now() - startedMs
          });
        };
        if (controller.signal.aborted) settle();
        else controller.signal.addEventListener("abort", settle, { once: true });
      });
      result = await Promise.race([execution, abortRace]);
      if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
        throw new UAALError({ code: FailureCode.INTERNAL_ERROR, message: "route returned malformed RouteResult", subject: route.id, retryable: false });
      }
    } catch (err) {
      const classified = classifyFailure(err, route.id);
      if (classified.code === FailureCode.CANCELLED && !signal.aborted && controller.signal.reason?.message?.includes("timeout")) {
        classified.code = FailureCode.TIMEOUT;
      }
      result = {
        ok: false,
        routeId: route.id,
        evidence: [],
        artifacts: [],
        failure: { code: classified.code, message: classified.message, httpStatus: classified.httpStatus, subject: route.id, retryable: classified.retryable, cause: err instanceof Error ? err.message.slice(0, 300) : undefined },
        latencyMs: Date.now() - startedMs
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
    }

    const durationMs = Date.now() - startedMs;
    const verifiedArtifacts: import("./contracts.js").Artifact[] = [];

    if (result.ok) {
      // promote + verify artifacts through the store (file verification gate)
      for (const ref of result.artifacts ?? []) {
        const promotion = await this.deps.artifacts.promote(ref, {
          resourceId: identity.fingerprint,
          sourceRoute: route.id,
          expectedBytes: ref.expectedBytes
        });
        if (promotion.artifact) {
          verifiedArtifacts.push(promotion.artifact);
        } else {
          result.ok = false;
          result.partial = result.evidence.length > 0;
          result.failure = {
            code: FailureCode.INVALID_ARTIFACT,
            message: `artifact verification failed: ${promotion.verification.failures.join("; ")}`,
            subject: route.id,
            retryable: true
          };
        }
      }
    }

    const attempt: AttemptRecord = {
      route: route.id,
      startedAt,
      durationMs,
      status: result.ok ? "success" : "failure",
      failureCode: result.failure?.code,
      message: result.ok ? undefined : result.failure?.message,
      bytesDownloaded: verifiedArtifacts.reduce((acc, a) => acc + a.size, 0),
      verified: result.ok ? verifiedArtifacts.length > 0 || (result.artifacts?.length ?? 0) === 0 : undefined
    };

    // record observation (bounded learning)
    if (!result.ok) {
      await this.deps.stats.record({
        ts: new Date().toISOString(),
        routeId: route.id,
        platform: String(route.platform),
        capability,
        envClass: environment.envClass,
        ok: false,
        failureCode: result.failure?.code,
        latencyMs: durationMs
      });
      trace.add("route.failure", { route: route.id, code: result.failure?.code, ms: durationMs });
      await this.deps.artifacts.cleanupTemp(identity.fingerprint);
    } else {
      await this.deps.stats.record({
        ts: new Date().toISOString(),
        routeId: route.id,
        platform: String(route.platform),
        capability,
        envClass: environment.envClass,
        ok: true,
        latencyMs: durationMs,
        verified: true
      });
      trace.add("route.success", { route: route.id, ms: durationMs, artifacts: verifiedArtifacts.length });
    }

    return { result: result.ok ? result : null, attempt, failure: result.ok ? undefined : result.failure, verifiedArtifacts };
  }
}
