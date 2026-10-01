/**
 * UAAL engine facade (spec §3, §20, §39, §54, §55).
 *
 * resolve/inspect/acquire/verify all share ONE pipeline:
 *   identity → discovery → ranked fallback loop → evidence →
 *   reconstruction → normalization → verification → artifacts → envelope.
 *
 * Fail-closed rules (spec §75): HTTP success ≠ success; a route's ok is a
 * claim until verification passes; verification failure demotes the attempt
 * and the loop continues to the next independent route.
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type {
  AccessRoute,
  AttemptRecord,
  Capability,
  EnvironmentProfile,
  Evidence,
  NormalizedResource,
  ResourceRequest,
  UAALEnvelope,
  UAALConfig,
  Artifact
} from "./contracts.js";
import { DEFAULT_CONFIG } from "./contracts.js";
import { FailureCode, UAALError, aggregateStatus, type Failure } from "./errors.js";
import { SCHEMA_VERSION, UAAL_VERSION } from "../version.js";
import { Logger, Trace, newTraceId } from "./observability.js";
import { detectEnvironment } from "./environment.js";
import { capabilityRegistry, isCapability, ARTIFACT_CAPABILITIES } from "./capabilities.js";
import { effectivePolicy, DEFAULT_POLICY } from "./policy.js";
import { PlatformRegistry, resolveIdentity } from "./identity.js";
import { CapabilityRouter } from "./router.js";
import { RouteStatsStore, ensureStateDir } from "./learning.js";
import { Cache, ArtifactIndex, cacheKey } from "./cache.js";
import { ArtifactStore } from "./artifacts/store.js";
import { SessionStore } from "./sessions.js";
import { JobManager } from "./jobs.js";
import { HttpLayer } from "./http.js";
import { verifyNormalizedResource, verifyArtifacts } from "./verify/index.js";
import { findBinary } from "./security/exec.js";
import { readFileJson, atomicWriteJson } from "./security/paths.js";
import { exportJsonSchemas } from "./schemas.js";
import { getBuiltinAdapters } from "../adapters/index.js";
import { LocalExecutionProvider } from "../exec/local.js";

export interface UAALOptions {
  config?: UAALConfig;
  logger?: Logger;
  adapters?: PlatformRegistry;
  environment?: EnvironmentProfile;
}

export const ENGINE_LEVEL_CAPABILITIES: ReadonlySet<Capability> = new Set(["resolve", "inspect", "verify"]);

export class UAAL {
  readonly config: UAALConfig;
  readonly logger: Logger;
  readonly registry: PlatformRegistry;
  readonly router: CapabilityRouter;
  readonly stats: RouteStatsStore;
  readonly cache: Cache;
  readonly artifactIndex: ArtifactIndex;
  readonly artifacts: ArtifactStore;
  readonly sessions: SessionStore;
  readonly jobs: JobManager;
  readonly http: HttpLayer;
  environment!: EnvironmentProfile;
  private localProvider = new LocalExecutionProvider();

  private constructor(config: UAALConfig, logger: Logger, registry: PlatformRegistry, stateDir: string, artifactsDir: string) {
    this.config = { ...config };
    this.logger = logger;
    this.registry = registry;
    this.stats = new RouteStatsStore(stateDir);
    this.cache = new Cache(stateDir, config.cache ?? true);
    this.artifactIndex = new ArtifactIndex(stateDir);
    this.artifacts = new ArtifactStore({ artifactsDir, ffprobeBin: false });
    this.sessions = new SessionStore(stateDir);
    this.jobs = new JobManager(stateDir);
    this.http = new HttpLayer({ politenessMs: config.politenessMs ?? DEFAULT_CONFIG.politenessMs, maxBytes: config.maxDownloadBytes ?? DEFAULT_CONFIG.maxDownloadBytes, maxRedirects: config.maxRedirects ?? DEFAULT_CONFIG.maxRedirects, allowLoopback: config.allowLoopbackHttp === true });
    this.router = new CapabilityRouter({
      stats: this.stats,
      artifacts: this.artifacts,
      logger,
      attemptTimeoutMs: config.attemptTimeoutMs ?? DEFAULT_CONFIG.attemptTimeoutMs,
      maxDownloadBytes: config.maxDownloadBytes ?? DEFAULT_CONFIG.maxDownloadBytes
    });
  }

  static async create(opts: UAALOptions = {}): Promise<UAAL> {
    const config = { ...DEFAULT_CONFIG, ...opts.config };
    const stateDir = config.stateDir ?? path.join(process.cwd(), "state");
    const artifactsDir = config.artifactsDir ?? path.join(process.cwd(), "artifacts");
    await ensureStateDir(stateDir);
    await ensureStateDir(artifactsDir);

    const logger = opts.logger ?? new Logger({ level: config.logLevel ?? "info" });
    const registry = opts.adapters ?? new PlatformRegistry();
    if (registry.all().length === 0) {
      for (const adapter of getBuiltinAdapters(config)) registry.register(adapter);
    }

    const engine = new UAAL(config, logger, registry, stateDir, artifactsDir);
    engine.environment = opts.environment ?? (await detectEnvironment());
    engine.artifacts.setFfprobe((await findBinary("ffprobe")) as string | false);
    await engine.stats.load();
    await engine.artifacts.load();
    const recovered = await engine.jobs.loadExisting();
    if (recovered > 0) logger.warn(`recovered ${recovered} interrupted job(s) as failed (never falsely completed)`);
    return engine;
  }

  /* ------------------------------------------------------------------ */
  /* Public operations (spec §20)                                        */
  /* ------------------------------------------------------------------ */

  async resolve(request: ResourceRequest, signal?: AbortSignal): Promise<UAALEnvelope> {
    return this.run(request, { ...request, capability: request.capability ?? "resolve" }, "resolve", signal);
  }

  async inspect(request: ResourceRequest, signal?: AbortSignal): Promise<UAALEnvelope> {
    return this.run(request, { ...request, capability: request.capability ?? "inspect" }, "inspect", signal);
  }

  async acquire(request: ResourceRequest, signal?: AbortSignal): Promise<UAALEnvelope> {
    return this.run(request, { ...request, capability: request.capability ?? "acquire" }, "acquire", signal);
  }

  /** Verify an existing artifact by id or path (engine-level capability). */
  async verifyArtifact(ref: { artifactId?: string; path?: string }, signal?: AbortSignal): Promise<UAALEnvelope> {
    const trace = new Trace();
    const started = new Date().toISOString();
    trace.add("verify.begin", ref);
    const ffprobeBin = (this.artifacts as unknown as { ffprobeBin: string | false }).ffprobeBin;
    let artifact: Artifact | undefined;
    if (ref.artifactId) artifact = this.artifacts.get(ref.artifactId);
    if (!artifact && ref.path) {
      const found = this.artifacts.list().find((a) => path.resolve(a.path) === path.resolve(ref.path!));
      artifact = found;
    }
    let verification;
    if (artifact) {
      verification = await verifyArtifacts([artifact], { ffprobeBin, sandboxRoot: this.artifacts.root });
    } else if (ref.path) {
      const { verifyArtifactFile } = await import("./verify/file.js");
      const res = await verifyArtifactFile(ref.path, { ffprobeBin, sandboxRoot: this.artifacts.root });
      verification = res;
    } else {
      return this.simpleEnvelope("verify", "failed", started, trace, {
        error: { code: "ARTIFACT_NOT_FOUND", message: "no artifact matched the given artifactId/path", attempts: [] },
        attempts: []
      });
    }
    trace.add("verify.done", { verified: verification.verified });
    return this.simpleEnvelope("verify", verification.verified ? "ok" : "failed", started, trace, {
      verification,
      attempts: [],
      warnings: artifact ? undefined : ["path verified outside the artifact registry"]
    });
  }

  /* ---------------- introspection (spec §52, §53) ---------------- */

  routesInfo(): unknown {
    return {
      schemaVersion: SCHEMA_VERSION,
      routes: this.registry.all().flatMap((adapter) => adapter.capabilities().map((c) => ({ platform: adapter.id }))).length > 0 ? undefined : undefined,
      stats: this.stats.all(),
      adapters: this.registry.all().map((a) => ({
        id: a.id,
        capabilities: a.capabilities().map((c) => c.name),
        limitations: a.limitations()
      }))
    };
  }

  capabilitiesInfo(): unknown {
    return {
      schemaVersion: SCHEMA_VERSION,
      capabilities: capabilityRegistry(),
      adapters: this.registry.all().map((a) => ({
        platform: a.id,
        capabilities: a.capabilities().map((c) => c.name),
        limitations: a.limitations()
      }))
    };
  }

  schemaInfo(): unknown {
    return exportJsonSchemas();
  }

  async health(): Promise<unknown> {
    const ffprobeBin = (this.artifacts as unknown as { ffprobeBin: string | false }).ffprobeBin;
    const ytdlp = await findBinary("yt-dlp");
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "ok",
      core: { version: UAAL_VERSION, schemaVersion: SCHEMA_VERSION, uptimeSec: Math.round(process.uptime()) },
      environment: { os: this.environment.os, arch: this.environment.arch, envClass: this.environment.envClass, containerized: this.environment.containerized, ci: this.environment.ci },
      adapters: this.registry.all().map((a) => ({ id: a.id, capabilities: a.capabilities().map((c) => c.name) })),
      routeHealth: this.stats.all().map((s) => ({ routeId: s.routeId, key: s.key, attempts: s.attempts, recentSuccessRatio: Number(s.recentSuccessRatio.toFixed(2)), failureStreak: s.failureStreak, cooldownUntil: s.cooldownUntil ?? null })),
      storage: { artifactsDir: this.artifacts.root, artifactCount: this.artifacts.list().length },
      dependencies: { ffmpeg: !!this.environment.binaries["ffmpeg"], ffprobe: !!ffprobeBin, ytDlp: !!ytdlp },
      degraded: []
    };
  }

  /** Dry-run (spec §51): discovery + plan without executing any route. */
  async plan(request: ResourceRequest, outerSignal?: AbortSignal): Promise<UAALEnvelope> {
    const started = new Date().toISOString();
    const trace = new Trace(newTraceId());
    const capability = request.capability ?? "metadata";
    try {
      const { identity, adapter } = await resolveIdentity(this.registry, request);
      const policy = effectivePolicy(request);
      const discovery = adapter
        ? await this.router.discover(adapter, request, identity, capability, this.environment, policy)
        : { discovery: [] as import("./contracts.js").DiscoveredRouteInfo[], ranked: [] };
      return this.envelope("plan", request, capability, started, trace, {
        status: "ok",
        identity,
        discovery: discovery.discovery,
        attempts: [],
        warnings: [
          `environment: ${this.environment.envClass} (${this.environment.os}/${this.environment.arch}, node ${this.environment.runtimeVersion})`,
          `policy: maxAccessLevel=${policy.maxAccessLevel}, maxRouteAttempts=${policy.maxRouteAttempts}`,
          `plan: ${discovery.ranked.filter((r) => r.eligible).length} eligible route(s); first choice: ${discovery.ranked.find((r) => r.eligible)?.route.id ?? "none"}`
        ]
      });
    } catch (err) {
      const failure = err instanceof UAALError ? err.failure : { code: FailureCode.INVALID_RESOURCE, message: (err as Error).message, retryable: false };
      return this.envelope("plan", request, capability, started, trace, {
        status: "failed",
        attempts: [],
        error: { code: failure.code, message: failure.message, attempts: [] }
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Core pipeline                                                       */
  /* ------------------------------------------------------------------ */

  private async run(original: ResourceRequest, request: ResourceRequest, operation: string, outerSignal?: AbortSignal): Promise<UAALEnvelope> {
    const started = new Date().toISOString();
    const startedMs = Date.now();
    const trace = new Trace(newTraceId());
    const log = this.logger.withTrace(trace.traceId);
    if (request.requestId) trace.add("request.id", { requestId: request.requestId });
    trace.add("operation", { operation, resource: request.resource.slice(0, 200) });

    const capability = request.capability ?? "metadata";
    if (!isCapability(capability)) {
      return this.simpleEnvelope(operation, "failed", started, trace, {
        error: { code: "INVALID_CAPABILITY", message: `unknown capability: ${capability}`, attempts: [] },
        attempts: []
      });
    }

    const policy = effectivePolicy(request);
    const deadlineAt = startedMs + (this.config.operationTimeoutMs ?? DEFAULT_CONFIG.operationTimeoutMs);
    const controller = new AbortController();
    const onOuter = (): void => controller.abort(new Error("cancelled by caller"));
    outerSignal?.addEventListener("abort", onOuter, { once: true });
    if (outerSignal?.aborted) onOuter();
    if (policy.attemptTimeoutMs && policy.attemptTimeoutMs > 0 && deadlineAt > startedMs + policy.attemptTimeoutMs * 8) {
      // caller narrowed timeouts via policy; respect an overall deadline derived from it
    }
    const opTimer = setTimeout(() => controller.abort(new Error("operation timeout")), Math.max(1_000, deadlineAt - Date.now()));

    const session = this.sessions.begin(request, operation, trace);
    const attempts: AttemptRecord[] = [];
    const warnings: string[] = [];
    const failures: Failure[] = [];
    let finalEnvelope: UAALEnvelope | undefined;

    try {
      // 1. Identity (canonicalization; may expand shortlinks via network)
      trace.add("identity.begin");
      let identity;
      try {
        const r = await resolveIdentity(this.registry, request);
        identity = r.identity;
      } catch (err) {
        const failure = err instanceof UAALError ? err.failure : { code: FailureCode.INVALID_RESOURCE, message: (err as Error).message, retryable: false };
        trace.add("identity.fail", { code: failure.code });
        finalEnvelope = this.envelope(operation, request, capability, started, trace, {
          status: failure.code === FailureCode.UNSUPPORTED_CAPABILITY ? "unsupported" : "failed",
          attempts,
          error: { code: failure.code, message: failure.message, attempts },
          warnings
        });
        return finalEnvelope;
      }
      trace.add("identity.ok", { platform: identity.platform, type: identity.type, id: identity.id });

      // 2. Idempotency for artifact operations (spec §32)
      if (ARTIFACT_CAPABILITIES.has(capability)) {
        const iKey = cacheKey(identity, capability, request.output);
        const cached = await this.artifactIndex.find(iKey);
        if (cached) {
          const artifact = this.artifacts.get(cached.artifactId);
          if (artifact) {
            trace.add("idempotency.hit", { artifactId: artifact.artifactId });
            warnings.push(`idempotent reuse of verified artifact ${artifact.artifactId}`);
            finalEnvelope = this.envelope(operation, request, capability, started, trace, {
              status: "ok",
              identity,
              artifacts: [artifact],
              attempts,
              warnings
            });
            return finalEnvelope;
          }
        }
      }

      // 3. Engine-level capabilities (resolve/inspect/verify) — no routes needed
      if (ENGINE_LEVEL_CAPABILITIES.has(capability)) {
        if (capability === "resolve") {
          finalEnvelope = this.envelope(operation, request, capability, started, trace, {
            status: "ok",
            identity,
            attempts,
            warnings
          });
          return finalEnvelope;
        }
        if (capability === "inspect") {
          // inspect = metadata capability executed with best-effort semantics
          const adapter = this.registry.get(identity.platform);
          if (!adapter) {
            finalEnvelope = this.envelope(operation, request, capability, started, trace, {
              status: "unsupported",
              identity,
              attempts,
              error: { code: "NO_ADAPTER", message: `no adapter for platform ${identity.platform}`, attempts },
              warnings
            });
            return finalEnvelope;
          }
          const inspectResult = await this.executePipeline({
            adapter,
            request,
            capability: "metadata",
            identity,
            policy,
            controller,
            deadlineAt,
            trace,
            attempts,
            failures,
            warnings,
            operation
          });
          finalEnvelope = inspectResult;
          return finalEnvelope;
        }
      }

      // 4. Adapter + discovery + fallback loop
      const adapter = this.registry.get(identity.platform);
      if (!adapter) {
        finalEnvelope = this.envelope(operation, request, capability, started, trace, {
          status: "unsupported",
          identity,
          attempts,
          error: { code: "NO_ADAPTER", message: `no adapter for platform ${identity.platform}`, attempts },
          warnings
        });
        return finalEnvelope;
      }
      const supportsCap = adapter.capabilities().some((c) => c.name === capability || (capability === "acquire" && ARTIFACT_CAPABILITIES.has(capability)) || (capability === "thread" && c.name === "thread"));
      if (!supportsCap && !ARTIFACT_CAPABILITIES.has(capability)) {
        // let discovery decide; adapters may still offer routes with capability mapping
      }

      finalEnvelope = await this.executePipeline({
        adapter,
        request,
        capability,
        identity,
        policy,
        controller,
        deadlineAt,
        trace,
        attempts,
        failures,
        warnings,
        operation
      });
      return finalEnvelope;
    } catch (err) {
      const failure = err instanceof UAALError ? err.failure : { code: FailureCode.INTERNAL_ERROR, message: (err as Error).message, retryable: false };
      log.error("engine.unhandled", { code: failure.code, message: failure.message });
      trace.add("engine.error", { code: failure.code });
      finalEnvelope = this.envelope(operation, request, capability, started, trace, {
        status: "failed",
        attempts,
        error: { code: failure.code, message: failure.message, attempts },
        warnings
      });
      return finalEnvelope;
    } finally {
      clearTimeout(opTimer);
      outerSignal?.removeEventListener("abort", onOuter);
      trace.add("operation.end", { status: finalEnvelope?.status ?? "unknown" });
      if (finalEnvelope) {
        this.sessions.finish(session, finalEnvelope, trace);
      }
      void this.stats.persist();
    }
  }

  /** Discovery + fallback + verification pipeline shared by all route-based capabilities. */
  private async executePipeline(args: {
    adapter: import("./contracts.js").PlatformAdapter;
    request: ResourceRequest;
    capability: Capability;
    identity: import("./contracts.js").ResourceIdentity;
    policy: Required<import("./contracts.js").AccessPolicy>;
    controller: AbortController;
    deadlineAt: number;
    trace: Trace;
    attempts: AttemptRecord[];
    failures: Failure[];
    warnings: string[];
    operation: string;
  }): Promise<UAALEnvelope> {
    const { adapter, request, capability, identity, policy, controller, deadlineAt, trace, attempts, failures, warnings, operation } = args;
    const started = trace.events[0]?.at ?? new Date().toISOString();

    const discovery = await this.router.discover(adapter, request, identity, capability, this.environment, policy);
    const eligible = discovery.ranked.filter((r) => r.eligible);
    trace.add("discovery.done", { candidates: discovery.ranked.length, eligible: eligible.length });

    if (eligible.length === 0) {
      const allAuth = discovery.discovery.length > 0 && discovery.discovery.every((d) => (d.reasons ?? []).some((x) => x.includes("authorized access") || x.includes("missing credentials")));
      const allEnv = discovery.discovery.length > 0 && discovery.discovery.every((d) => (d.reasons ?? []).some((x) => x.includes("missing binaries") || x.includes("no network") || x.includes("remote execution")));
      return this.envelope(operation, request, capability, started, trace, {
        status: allAuth ? "requires_auth" : discovery.ranked.length === 0 || allEnv ? "unsupported" : "failed",
        identity,
        discovery: discovery.discovery,
        attempts,
        warnings,
        error: {
          code: discovery.ranked.length === 0 ? "NO_ROUTES_DECLARED" : allAuth ? "AUTH_REQUIRED" : allEnv ? "ENVIRONMENT_INCOMPATIBLE" : "ALL_ROUTES_FILTERED",
          message:
            discovery.ranked.length === 0
              ? `adapter ${adapter.id} declares no routes for capability ${capability}`
              : `no eligible routes: ${discovery.ranked.map((r) => `${r.route.id}: ${r.reason}`).join(" | ")}`,
          attempts
        }
      });
    }

    // fallback loop (spec §10): never blindly retry the same failing method —
    // each route is an independent method; failures classify + demote.
    const maxAttempts = Math.min(policy.maxRouteAttempts ?? DEFAULT_POLICY.maxRouteAttempts, eligible.length);
    let successEnvelope: UAALEnvelope | undefined;
    let bestPartial: { resource: NormalizedResource; artifacts: Artifact[]; routeId: string; missing: string[]; available: string[] } | undefined;

    for (let i = 0; i < maxAttempts; i++) {
      if (controller.signal.aborted) {
        trace.add("loop.cancelled", { at: i });
        break;
      }
      const ranked = eligible[i];
      const route = ranked.route;
      if (this.localProvider.supports(route, this.environment)) {
        // local execution (default provider)
      } else {
        attempts.push({ route: route.id, startedAt: new Date().toISOString(), durationMs: 0, status: "skipped", message: "no execution provider available for this route" });
        continue;
      }

      const attempt = await this.router.attempt(route, request, identity, capability, this.environment, policy, controller.signal, deadlineAt, trace);
      attempts.push(attempt.attempt);

      if (attempt.result && (attempt.result.ok || (attempt.result.evidence.length > 0 && attempt.result.partial))) {
        // verification gate: reconstruct + normalize + verify BEFORE declaring success
        let resource: NormalizedResource | undefined;
        try {
          if (attempt.result.evidence.length > 0) {
            resource = await adapter.normalize(attempt.result.evidence, request, identity);
            const vres = verifyNormalizedResource(resource, { capability });
            if (!vres.verified && capability !== "media" && capability !== "acquire") {
              trace.add("verification.fail", { route: route.id, summary: vres.summary });
              warnings.push(`route ${route.id}: resource verification failed: ${vres.summary}`);
              attempts.push({
                route: route.id,
                startedAt: new Date().toISOString(),
                durationMs: 0,
                status: "failure",
                failureCode: FailureCode.VERIFICATION_FAILURE,
                message: `resource verification failed: ${vres.summary}`,
                verified: false
              });
              failures.push({ code: FailureCode.VERIFICATION_FAILURE, message: vres.summary ?? "verification failed", subject: route.id, retryable: true });
              await this.stats.record({
                ts: new Date().toISOString(),
                routeId: route.id,
                platform: String(route.platform),
                capability,
                envClass: this.environment.envClass,
                ok: false,
                failureCode: FailureCode.VERIFICATION_FAILURE,
                latencyMs: attempt.attempt.durationMs,
                verified: false
              });
              continue; // recovery semantics: route B attempted after A's verification failure
            }
          }
        } catch (err) {
          warnings.push(`route ${route.id}: normalization failed: ${(err as Error).message.slice(0, 200)}`);
          failures.push({ code: FailureCode.PARSER_FAILURE, message: `normalization failed: ${(err as Error).message.slice(0, 200)}`, subject: route.id, retryable: true });
          continue;
        }

        const artifacts = attempt.verifiedArtifacts;
        const wantArtifacts = ARTIFACT_CAPABILITIES.has(capability);
        if (wantArtifacts && artifacts.length === 0) {
          // route claims ok but produced no verified artifacts — fail closed for acquire
          warnings.push(`route ${route.id}: produced no verified artifacts`);
          failures.push({ code: FailureCode.INVALID_ARTIFACT, message: "no verified artifacts produced", subject: route.id, retryable: true });
          continue;
        }

        // idempotency bookkeeping
        if (wantArtifacts && artifacts.length > 0) {
          const { cacheKey } = await import("./cache.js");
          const iKey = cacheKey(identity, capability, request.output);
          await this.artifactIndex.put(iKey, artifacts[0].artifactId, artifacts[0].path);
        }

        // full artifact verification pass (artifact capabilities gate on artifact checks, not media_present)
        let verification = resource ? verifyNormalizedResource(resource, { capability: wantArtifacts ? "metadata" : capability }) : undefined;
        if (artifacts.length > 0) {
          const artVer = await verifyArtifacts(artifacts, { ffprobeBin: (this.artifacts as unknown as { ffprobeBin: string | false }).ffprobeBin, sandboxRoot: this.artifacts.root });
          verification = verification ? { verified: verification.verified && artVer.verified, checks: [...verification.checks, ...artVer.checks], summary: [verification.summary, artVer.summary].filter(Boolean).join("; ") } : artVer;
        }

        successEnvelope = this.envelope(operation, request, capability, started, trace, {
          status: "ok",
          identity,
          resource,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
          verification,
          route: { id: route.id, platform: route.platform, tags: route.tags },
          discovery: discovery.discovery,
          attempts,
          warnings
        });

        // record idempotent artifact index for single-artifact data ops too
        await this.stats.persist();
        break;
      }

      // partial success bookkeeping (spec §55): evidence exists but incomplete
      if (attempt.result && attempt.result.partial && attempt.result.evidence.length > 0) {
        try {
          const resource = await adapter.normalize(attempt.result.evidence, request, identity);
          bestPartial = {
            resource,
            artifacts: attempt.verifiedArtifacts,
            routeId: route.id,
            missing: attempt.result.notes ?? ["unknown"],
            available: [capability]
          };
        } catch {
          /* normalization of partial evidence failed; keep going */
        }
      }

      if (attempt.failure) failures.push(attempt.failure);
      if (attempt.result?.unavailable) {
        // informative negative: candidate genuinely does not exist
        failures.push({ code: FailureCode.INVALID_RESOURCE, message: attempt.failure?.message ?? "resource unavailable", subject: route.id, retryable: false });
      }
    }

    if (successEnvelope) return successEnvelope;

    // exhaustion: honest aggregate status (spec §39, §54)
    const verifiedSomething = bestPartial !== undefined;
    const status = controller.signal.aborted && attempts.length > 0 ? "failed" : aggregateStatus(true, failures, verifiedSomething);
    const triedUnavailable = failures.length > 0 && failures.every((f) => f.code === FailureCode.INVALID_RESOURCE);

    const envelope = this.envelope(operation, request, capability, started, trace, {
      status: triedUnavailable ? "empty" : status,
      identity,
      discovery: discovery.discovery,
      attempts,
      resource: bestPartial?.resource,
      artifacts: bestPartial?.artifacts.length ? bestPartial.artifacts : undefined,
      available: bestPartial?.available,
      missing: bestPartial?.missing,
      warnings,
      error: {
        code: controller.signal.aborted ? "CANCELLED" : "ALL_ROUTES_EXHAUSTED",
        message:
          failures.length > 0
            ? `no route produced a verified result. attempts: ${attempts.filter((a) => a.status === "failure").map((a) => `${a.route}=${a.failureCode}`).join(", ")}`
            : "no route produced a result",
        attempts
      }
    });
    return envelope;
  }

  /* ---------------------------- envelope helpers ---------------------------- */

  private envelope(
    operation: string,
    request: ResourceRequest,
    capability: Capability,
    started: string,
    trace: Trace,
    parts: Partial<UAALEnvelope> & { status: UAALEnvelope["status"]; attempts: AttemptRecord[] }
  ): UAALEnvelope {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: parts.status,
      operation,
      request: { resource: request.resource, capability, platform: parts.identity?.platform ?? request.platform },
      identity: parts.identity,
      resource: parts.resource,
      artifacts: parts.artifacts,
      verification: parts.verification,
      route: parts.route,
      attempts: parts.attempts,
      discovery: parts.discovery,
      error: parts.error,
      available: parts.available,
      missing: parts.missing,
      warnings: parts.warnings,
      timing: { startedAt: started, durationMs: Date.now() - new Date(started).getTime() },
      traceId: trace.traceId,
      requestId: request.requestId
    };
  }

  private simpleEnvelope(
    operation: string,
    status: UAALEnvelope["status"],
    started: string,
    trace: Trace,
    parts: Partial<UAALEnvelope>
  ): UAALEnvelope {
    return {
      schemaVersion: SCHEMA_VERSION,
      status,
      operation,
      request: { resource: "", capability: "verify" },
      attempts: [],
      timing: { startedAt: started, durationMs: Date.now() - new Date(started).getTime() },
      traceId: trace.traceId,
      ...parts
    };
  }
}

/** Persist helper used by tests/ops to snapshot config (never credentials). */
export async function writeRuntimeConfig(stateDir: string, config: UAALConfig): Promise<void> {
  const safe = { ...config } as Record<string, unknown>;
  delete safe.credentials; // never persist credential material
  await atomicWriteJson(path.join(stateDir, "runtime-config.json"), safe);
}

export { readFileJson };
