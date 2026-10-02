/**
 * Shared test fixtures: fake adapters/routes for failure injection,
 * recovery, and contract tests. No network needed.
 */
import type {
  AccessRoute,
  AttemptRecord,
  Capability,
  DetectionResult,
  Evidence,
  EnvironmentProfile,
  ExecutionContext,
  NormalizedResource,
  PlatformAdapter,
  RawArtifactRef,
  ResourceIdentity,
  ResourceRequest,
  RouteDiscoveryContext,
  RouteResult,
  CapabilityDescriptor,
  VerificationResult
} from "../../src/core/contracts.js";
import { SCHEMA_VERSION } from "../../src/version.js";
import { FailureCode } from "../../src/core/errors.js";

export function fakeEnvironment(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
  return {
    os: "linux",
    osVersion: "test",
    arch: "x64",
    runtime: "node",
    runtimeVersion: process.version,
    containerized: false,
    ci: false,
    envClass: "local",
    binaries: { "yt-dlp": "/usr/bin/fake-ytdlp", ffmpeg: "/usr/bin/fake-ffmpeg", ffprobe: false },
    network: { ipv4: true, ipv6: false },
    fs: { tmpWritable: true },
    detectedAt: new Date().toISOString(),
    ...overrides
  };
}

export type ScriptedFailure =
  | "timeout"
  | "http404"
  | "http403"
  | "http429"
  | "network"
  | "empty"
  | "malformed"
  | "invalid-artifact"
  | "verification-failure"
  | "raise"
  | "unavailable";

export interface ScriptedRouteSpec {
  id: string;
  capabilities: Capability[];
  priority?: number;
  enabled?: boolean;
  script?: ScriptedFailure;
  /** When succeeding, produce evidence and/or an artifact. */
  produce?: { evidence?: boolean; artifact?: { kind: string; bytes: number; content?: Buffer } };
  latencyMs?: number;
  binaries?: string[];
  tags?: string[];
  accessLevel?: "public" | "authorized";
  credentials?: string[];
}

export function scriptedRoute(spec: ScriptedRouteSpec): AccessRoute {
  const id = spec.id;
  return {
    id,
    platform: "testplat",
    capabilities: spec.capabilities,
    requirements: { binaries: spec.binaries ?? [], credentials: spec.credentials ?? [] },
    environmentCompatibility: { local: true, remote: true },
    priority: spec.priority ?? 50,
    enabled: spec.enabled ?? true,
    accessLevel: spec.accessLevel ?? "public",
    tags: spec.tags ?? ["test"],
    description: `scripted route ${id} (failure=${spec.script ?? "none"})`,
    async execute(request: ResourceRequest, ctx: ExecutionContext): Promise<RouteResult> {
      const started = Date.now();
      const artifacts: RawArtifactRef[] = [];
      if (spec.latencyMs) await new Promise((r) => setTimeout(r, spec.latencyMs));
      switch (spec.script) {
        case "timeout":
          await new Promise((r) => setTimeout(r, 10_000));
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.TIMEOUT, message: "scripted timeout", subject: id, retryable: true }, latencyMs: Date.now() - started };
        case "http404":
        case "unavailable":
          return { ok: false, routeId: id, evidence: [], artifacts: [], unavailable: true, failure: { code: FailureCode.INVALID_RESOURCE, message: "HTTP 404 (filter signal)", subject: id, retryable: false }, latencyMs: Date.now() - started };
        case "http403":
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.AUTH_REQUIRED, message: "HTTP 403", subject: id, retryable: false }, latencyMs: Date.now() - started };
        case "http429":
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.RATE_LIMIT, message: "HTTP 429", subject: id, retryable: true }, latencyMs: Date.now() - started };
        case "network":
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.NETWORK_FAILURE, message: "fetch failed", subject: id, retryable: true }, latencyMs: Date.now() - started };
        case "empty":
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.EMPTY_RESULT, message: "empty response", subject: id, retryable: true }, latencyMs: Date.now() - started };
        case "malformed":
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.PARSER_FAILURE, message: "invalid JSON", subject: id, retryable: true }, latencyMs: Date.now() - started };
        case "invalid-artifact": {
          if (spec.produce?.artifact) {
            const p = ctx.sink.allocate("fake.mp4");
            const { writeFile } = await import("node:fs/promises");
            await writeFile(p.path, Buffer.from("<!doctype html><html>fake</html>"));
            const ref: RawArtifactRef = { path: p.path, kind: "video", filename: "fake.mp4" };
            ctx.sink.register(ref);
            artifacts.push(ref);
            return { ok: true, routeId: id, evidence: [], artifacts, latencyMs: Date.now() - started };
          }
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.INVALID_ARTIFACT, message: "scripted", subject: id, retryable: true }, latencyMs: Date.now() - started };
        }
        case "raise":
          throw new Error("scripted raise");
        case "verification-failure":
          return {
            ok: true,
            routeId: id,
            evidence: [{ id: `ev_${id}`, source: id, type: "bogus", data: { inconsistent: true }, retrievedAt: new Date().toISOString(), reliability: 0.1 }],
            artifacts: [],
            latencyMs: Date.now() - started
          };
        default: {
          const evidence: Evidence[] = [];
          if (spec.produce?.evidence !== false) {
            evidence.push({
              id: `ev_${ctx.hash(`${id}:${ctx.identity.id}`)}`,
              source: id,
              type: "testplat.data",
              data: { title: `Resource ${ctx.identity.id}`, kind: "test", routeId: id },
              retrievedAt: new Date().toISOString(),
              reliability: 0.85
            });
          }
          if (spec.produce?.artifact) {
            const p = ctx.sink.allocate("out.bin");
            const { writeFile } = await import("node:fs/promises");
            const content = spec.produce.artifact.content ?? Buffer.alloc(spec.produce.artifact.bytes, 7);
            await writeFile(p.path, content);
            const ref: RawArtifactRef = { path: p.path, kind: spec.produce.artifact.kind, filename: "out.bin", expectedBytes: content.length };
            ctx.sink.register(ref);
            artifacts.push(ref);
          }
          return { ok: true, routeId: id, evidence, artifacts, latencyMs: Date.now() - started };
        }
      }
    }
  };
}

/** A scripted adapter with configurable route list + normalization behavior. */
export function scriptedAdapter(opts: {
  routes: ScriptedRouteSpec[];
  brokenNormalization?: boolean;
  declaredCapabilities?: Capability[];
}): PlatformAdapter {
  const capabilities: CapabilityDescriptor[] = (opts.declaredCapabilities ?? ["metadata", "acquire", "thread", "media"]).map((name) => ({ name, description: "test", engineLevel: false }));
  return {
    id: "testplat",
    detect(resource: string): DetectionResult {
      return resource.startsWith("testplat://") ? { matched: true, confidence: 1, platform: "testplat", resourceType: "item", detail: resource.replace("testplat://", "") } : { matched: false, confidence: 0 };
    },
    capabilities: () => capabilities,
    limitations: () => ["test adapter"],
    async discoverRoutes(_request: ResourceRequest, _ctx: RouteDiscoveryContext): Promise<AccessRoute[]> {
      return opts.routes.map(scriptedRoute);
    },
    async resolveIdentity(resource: string): Promise<ResourceIdentity> {
      const id = resource.replace("testplat://", "");
      return {
        platform: "testplat",
        type: "item",
        id,
        canonicalUrl: `https://test.example/${id}`,
        aliases: [resource],
        fingerprint: `test-${id}`
      };
    },
    async normalize(evidence: Evidence[], _request: ResourceRequest, identity: ResourceIdentity): Promise<NormalizedResource> {
      const firstType = evidence[0]?.type;
      if (opts.brokenNormalization || firstType === "bogus") {
        // schema-invalid resource: empty url must fail verification (VERIFICATION_FAILURE)
        return {
          schemaVersion: SCHEMA_VERSION,
          platform: "testplat",
          resource: { id: identity.id, url: "", type: "item", platform: "testplat" },
          content: {},
          media: [],
          relationships: [],
          platformData: {},
          evidence: [],
          uncertainty: { confidence: 0.1, missing: ["everything"], notes: [] }
        };
      }
      const data = (evidence[0]?.data ?? {}) as Record<string, unknown>;
      return {
        schemaVersion: SCHEMA_VERSION,
        platform: "testplat",
        resource: { id: identity.id, url: `https://test.example/${identity.id}`, type: "item", platform: "testplat" },
        content: { title: (data.title as string) ?? "" },
        media: [],
        relationships: [],
        platformData: { sources: evidence.map((e) => e.source) },
        evidence: evidence.map(({ id, source, type, retrievedAt, reliability }) => ({ id, source, type, retrievedAt, reliability })),
        uncertainty: { confidence: 0.9, missing: [], notes: [] }
      };
    },
    async verify(): Promise<VerificationResult> {
      return { verified: true, checks: [{ name: "adapter.verify", passed: true }] };
    }
  };
}

export function emptyAttempts(): AttemptRecord[] {
  return [];
}
