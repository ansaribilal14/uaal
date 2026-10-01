/**
 * UAAL core contracts (spec §§5-20, 29-30, 39, 66-71).
 *
 * The core engine operates ONLY against these interfaces. Platform adapters
 * provide concrete implementations. Adding a platform must never require
 * modifying the engine (spec Rule 12).
 */

import type { Failure, FailureCode } from "./errors.js";

/* ------------------------------------------------------------------ */
/* Capabilities (spec §7)                                              */
/* ------------------------------------------------------------------ */

export const CAPABILITIES = [
  "resolve",          // canonical identity of the resource (engine-local when possible)
  "inspect",          // what is available without heavy acquisition work
  "metadata",         // descriptive metadata
  "extract",          // raw platform extraction (platform_data populated)
  "reconstruct",      // structural reconstruction (threads/chains)
  "media",            // media inventory (urls, variants) without downloading
  "acquire",          // produce verified downloadable artifacts
  "thread",           // ordered post chain
  "comments",         // comment tree
  "author",           // author information
  "media_metadata",   // per-media details
  "artifact",         // explicit artifact production
  "verify"            // verify an existing artifact (engine-level)
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityDescriptor {
  name: Capability;
  description: string;
  /** Engine-level capabilities are satisfied by the core, not by routes. */
  engineLevel: boolean;
}

/* ------------------------------------------------------------------ */
/* Resource model (spec §6, §56)                                       */
/* ------------------------------------------------------------------ */

export type PlatformId =
  | "youtube"
  | "x"
  | "reddit"
  | "instagram"
  | "tiktok"
  | "facebook"
  | "telegram"
  | "generic-web"
  | (string & {});

export interface OutputRequirements {
  /** Requested artifact formats, e.g. ["video"], ["audio"], ["json"]. */
  format?: string[];
  /** Preferred container/extension, e.g. "mp4". */
  container?: string;
  /** Maximum acceptable artifact size in bytes. */
  maxBytes?: number;
  /** Extra adapter-specific output hints. */
  [key: string]: unknown;
}

export interface EnvironmentConstraints {
  /** Prefer routes executable in this process ("local") or on a worker. */
  execution?: "local" | "remote" | "either";
  /** Explicitly required binaries, e.g. ["yt-dlp"]. */
  requireBinaries?: string[];
  [key: string]: unknown;
}

export type AccessLevel = "public" | "authorized";

export interface AccessPolicy {
  /** Highest access level the caller permits. Default "public". */
  maxAccessLevel?: AccessLevel;
  /** Route tags to allow (when set, only tagged routes are eligible). */
  allowedRouteTags?: string[];
  /** Route tags to exclude. */
  deniedRouteTags?: string[];
  /** Maximum routes to attempt in one operation. */
  maxRouteAttempts?: number;
  /** Per-attempt timeout override (ms). */
  attemptTimeoutMs?: number;
  /** Abort politely: enable politeness budgets (default true). */
  polite?: boolean;
  /** Explicit credential material for authorized routes (never logged). */
  credentials?: Record<string, string>;
  [key: string]: unknown;
}

export interface ResourceRequest {
  resource: string;
  platform?: PlatformId;
  capability?: Capability;
  output?: OutputRequirements;
  environment?: EnvironmentConstraints;
  policy?: AccessPolicy;
  /** Caller-supplied opaque correlation id. */
  requestId?: string;
}

/* ------------------------------------------------------------------ */
/* Resource identity (spec §56)                                        */
/* ------------------------------------------------------------------ */

export interface ResourceIdentity {
  platform: PlatformId;
  /** Platform-native resource type, e.g. "video", "thread", "page", "post". */
  type: string;
  /** Platform-native id. */
  id: string;
  /** Canonical URL form (one shape per resource). */
  canonicalUrl: string;
  /** All raw inputs that mapped to this identity. */
  aliases: string[];
  /** Additional ids (e.g. media ids) attached during discovery. */
  relatedIds?: string[];
  /** Deterministic fingerprint: sha256(platform|type|id|outputHints). */
  fingerprint: string;
}

/* ------------------------------------------------------------------ */
/* Evidence (spec §13, §69)                                            */
/* ------------------------------------------------------------------ */

export interface Evidence {
  id: string;
  /** Route id that produced this evidence. */
  source: string;
  /** Free-form type, e.g. "oembed", "innertube.player", "fxtweet", "og.html". */
  type: string;
  data: unknown;
  retrievedAt: string;
  /** 0..1 route-reported reliability of this evidence kind. */
  reliability?: number;
  /** Provenance notes (endpoint class, instance, etc.). */
  provenance?: Record<string, unknown>;
}

export interface EvidenceSource {
  collect(request: ResourceRequest, ctx: ExecutionContext): Promise<Evidence[]>;
}

/* ------------------------------------------------------------------ */
/* Environment (spec §12)                                              */
/* ------------------------------------------------------------------ */

export interface EnvironmentProfile {
  os: string;
  osVersion: string;
  arch: string;
  runtime: "node";
  runtimeVersion: string;
  containerized: boolean;
  ci: boolean;
  ciProvider?: string;
  cloud?: string;
  envClass: "local" | "container" | "ci" | "cloud" | "server";
  binaries: Record<string, string | false>;
  network: { ipv4: boolean; ipv6: boolean };
  fs: { tmpWritable: boolean };
  detectedAt: string;
}

/* ------------------------------------------------------------------ */
/* Routes (spec §8, §67)                                               */
/* ------------------------------------------------------------------ */

export interface RouteRequirement {
  /** Binaries that must exist on PATH. */
  binaries?: string[];
  /** Minimum node major version. */
  node?: number;
  network?: boolean;
  /** Credentials that must be present in policy.credentials or env. */
  credentials?: string[];
  /** Extra free-form requirements, evaluated by the adapter. */
  [key: string]: unknown;
}

export interface EnvironmentCompatibility {
  /** true = runs in-process on this machine; false = requires a worker. */
  local: boolean;
  /** true = may run on a remote worker. */
  remote: boolean;
  /** Binaries checked against the environment profile. */
  requiredBinaries?: string[];
}

export interface RouteEligibility {
  eligible: boolean;
  confidence: number; // 0..1
  reasons: string[];
}

export interface ProbeResult {
  viable: boolean;
  confidence: number; // 0..1
  reason: string;
  latencyMs?: number;
}

export interface RawArtifactRef {
  /** Absolute path of the temp file produced by the route. */
  path: string;
  /** Declared kind, e.g. "video", "audio", "json", "text". */
  kind: string;
  /** Original filename suggestion (sanitized before use). */
  filename?: string;
  mimeType?: string;
  /** Expected size when known (used by transfer + truncation checks). */
  expectedBytes?: number;
  /** Adapter-provided metadata for the artifact (duration, width, ...). */
  meta?: Record<string, unknown>;
}

export interface RouteResult {
  ok: boolean;
  routeId: string;
  evidence: Evidence[];
  artifacts: RawArtifactRef[];
  /** Machine failure classification when ok=false. */
  failure?: Failure;
  /** Route-specific notes that survive into the envelope warnings. */
  notes?: string[];
  /** True when the route asserts the resource cannot exist (404-class filter signal). */
  unavailable?: boolean;
  /** True when the route produced some but not all of what it attempted. */
  partial?: boolean;
  latencyMs: number;
}

export type RouteTag = "official" | "public-mirror" | "self-hosted" | "subprocess" | "scrape" | (string & {});

/**
 * An access route is ONE independent way of obtaining evidence/artifacts for
 * one platform capability. Routes must never raise: failures come back as
 * RouteResult with a classified failure (ytagent never-raise boundary).
 */
export interface AccessRoute {
  id: string;
  platform: PlatformId;
  /** Capabilities this route can serve. */
  capabilities: Capability[];
  requirements: RouteRequirement;
  environmentCompatibility: EnvironmentCompatibility;
  /** Base priority; higher runs first. Learning adjusts ordering dynamically. */
  priority: number;
  enabled: boolean;
  /** access level this route operates at. */
  accessLevel: AccessLevel;
  tags: RouteTag[];
  /** Human + machine description of what this route does. */
  description: string;
  /** Cost/latency estimate in ms for ranking. */
  estimatedCostMs?: number;
  /** Optional probe used before committing to full execution. */
  probe?(request: ResourceRequest, ctx: ExecutionContext): Promise<ProbeResult>;
  execute(request: ResourceRequest, ctx: ExecutionContext): Promise<RouteResult>;
}

/** Declares everything the engine needs to know about one platform. */
export interface PlatformAdapter {
  id: PlatformId;
  /** Can this adapter handle the given raw resource string? */
  detect(resource: string): DetectionResult;
  /** Capabilities the platform supports overall. */
  capabilities(): CapabilityDescriptor[];
  /** Known limitations surfaced through schema/health introspection. */
  limitations(): string[];
  /** Build candidate routes for this request (spec §9: discovery, not hardcoding). */
  discoverRoutes(request: ResourceRequest, ctx: RouteDiscoveryContext): Promise<AccessRoute[]>;
  /** Combine evidence into a normalized resource. */
  normalize(evidence: Evidence[], request: ResourceRequest, identity: ResourceIdentity): Promise<NormalizedResource>;
  /** Platform-specific verification requirements on top of generic checks. */
  verify(resource: NormalizedResource, artifacts: Artifact[]): Promise<VerificationResult>;
  /** Optional resource identity resolution (URL canonicalization). */
  resolveIdentity?(resource: string, ctx?: { signal?: AbortSignal }): Promise<ResourceIdentity>;
}

export interface DetectionResult {
  matched: boolean;
  confidence: number;
  platform?: PlatformId;
  resourceType?: string;
  detail?: string;
}

export interface RouteDiscoveryContext {
  environment: EnvironmentProfile;
  policy: AccessPolicy;
  identity: ResourceIdentity;
  capability: Capability;
}

/* ------------------------------------------------------------------ */
/* Execution context (spec §63, §62, §27)                              */
/* ------------------------------------------------------------------ */

export interface ArtifactSink {
  /** Allocate a temp file inside this route's sandboxed working dir. */
  allocate(suggestedName: string): { path: string };
  /** Register a produced temp file as a raw artifact (verification pending). */
  register(ref: RawArtifactRef): void;
}

export interface ExecutionContext {
  request: ResourceRequest;
  identity: ResourceIdentity;
  capability: Capability;
  environment: EnvironmentProfile;
  policy: AccessPolicy;
  /** Abort signal: cancellation + timeout propagation (spec §62). */
  signal: AbortSignal;
  /** Per-attempt deadline (epoch ms). */
  deadlineAt: number;
  /** Sandboxed per-route working directory (temp). */
  workingDir: string;
  sink: ArtifactSink;
  /** Redacting structured logger. */
  log: ScopedLogger;
  /** Deterministic sha256 helper. */
  hash(data: string | Buffer): string;
}

export interface ScopedLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/* ------------------------------------------------------------------ */
/* Reconstruction / normalization (spec §14, §15)                      */
/* ------------------------------------------------------------------ */

export interface NormalizedAuthor {
  id?: string;
  name?: string;
  handle?: string;
  url?: string;
  avatarUrl?: string;
  verified?: boolean;
  [key: string]: unknown;
}

export interface NormalizedMedia {
  kind: "photo" | "video" | "audio" | "gif" | "document" | (string & {});
  url?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  thumbnailUrl?: string;
  /** True when a locally produced artifact exists for this media. */
  downloadable?: boolean;
  /** Honest explanation when not downloadable (e.g. "hls_only"). */
  unavailableReason?: string;
  variants?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface NormalizedRelationship {
  type: string; // e.g. "reply", "parent", "quote"
  from: string;
  to: string;
  position?: number;
}

export interface NormalizedContent {
  text?: string;
  title?: string;
  description?: string;
  language?: string;
  publishedAt?: string;
  metrics?: Record<string, number | null>;
  [key: string]: unknown;
}

export interface ReconstructionNote {
  code: string;
  message: string;
  severity: "info" | "warn" | "error";
}

export interface NormalizedResource {
  schemaVersion: string;
  platform: PlatformId;
  resource: {
    id: string;
    url: string;
    type: string;
    platform: PlatformId;
  };
  content: NormalizedContent;
  author?: NormalizedAuthor;
  media: NormalizedMedia[];
  relationships: NormalizedRelationship[];
  /** Platform-specific payload preserved for advanced consumers. */
  platformData: Record<string, unknown>;
  evidence: Array<Pick<Evidence, "id" | "source" | "type" | "retrievedAt" | "reliability">>;
  /** Reconstruction honesty: what is missing/uncertain. */
  uncertainty: {
    confidence: number;
    missing: string[];
    notes: ReconstructionNote[];
  };
}

/* ------------------------------------------------------------------ */
/* Verification (spec §16, §68)                                        */
/* ------------------------------------------------------------------ */

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail?: string;
  /** Which artifact the check applied to (when applicable). */
  artifactId?: string;
}

export interface VerificationResult {
  verified: boolean;
  checks: VerificationCheck[];
  summary?: string;
  durationMs?: number;
}

export interface Verifier<T = unknown> {
  verify(value: T, context: VerificationContext): Promise<VerificationResult>;
}

export interface VerificationContext {
  capability?: Capability;
  identity?: ResourceIdentity;
  request?: ResourceRequest;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* Artifacts (spec §17, §70)                                           */
/* ------------------------------------------------------------------ */

export type ArtifactType = "video" | "audio" | "image" | "document" | "json" | "manifest" | "metadata" | "archive" | "text" | (string & {});

export interface Artifact {
  artifactId: string;
  resourceId: string; // identity fingerprint
  type: ArtifactType;
  path: string;
  size: number;
  checksum: string; // sha256
  mimeType: string;
  createdAt: string;
  verificationStatus: "verified" | "unverified" | "failed";
  sourceRoute: string;
  /** Media-derived facts where applicable (spec §57). */
  media?: {
    container?: string;
    durationSec?: number;
    videoCodec?: string;
    audioCodec?: string;
    width?: number;
    height?: number;
  };
  filename: string;
}

/* ------------------------------------------------------------------ */
/* Attempts / tracing (spec §34, §71)                                  */
/* ------------------------------------------------------------------ */

export interface AttemptRecord {
  route: string;
  startedAt: string;
  durationMs: number;
  status: "success" | "failure" | "skipped" | "probe";
  failureCode?: FailureCode;
  message?: string;
  bytesDownloaded?: number;
  verified?: boolean;
}

/* ------------------------------------------------------------------ */
/* Jobs (spec §31)                                                     */
/* ------------------------------------------------------------------ */

export type JobState =
  | "queued"
  | "probing"
  | "executing"
  | "verifying"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export interface JobRecord {
  jobId: string;
  state: JobState;
  operation: "resolve" | "inspect" | "acquire" | "verify";
  request: ResourceRequest;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts?: number;
  maxRetries?: number;
  timeoutMs?: number;
  result?: UAALEnvelope;
  error?: { code: string; message: string };
  cancelRequested?: boolean;
}

/* ------------------------------------------------------------------ */
/* Envelope — the universal response contract (spec §20, §39, §54)      */
/* ------------------------------------------------------------------ */

export interface EnvelopeTiming {
  startedAt: string;
  durationMs: number;
}

export interface UAALEnvelope {
  schemaVersion: string;
  status: UAALStatusString;
  operation: string;
  request: {
    resource: string;
    capability: Capability;
    platform?: PlatformId;
  };
  identity?: ResourceIdentity;
  resource?: NormalizedResource;
  artifacts?: Artifact[];
  verification?: VerificationResult;
  /** The route that ultimately succeeded (Rule 11: informational, not required). */
  route?: { id: string; platform: PlatformId; tags: RouteTag[] };
  attempts: AttemptRecord[];
  discovery?: DiscoveredRouteInfo[];
  error?: { code: string; message: string; attempts: AttemptRecord[] };
  /** available/missing for partial results (spec §55). */
  available?: string[];
  missing?: string[];
  warnings?: string[];
  timing: EnvelopeTiming;
  traceId: string;
  requestId?: string;
}

export type UAALStatusString = "ok" | "partial" | "empty" | "failed" | "unsupported" | "requires_auth" | "blocked";

export interface DiscoveredRouteInfo {
  id: string;
  platform: PlatformId;
  capabilities: Capability[];
  status: "available" | "filtered" | "probe-failed" | "disabled";
  confidence: number;
  priority: number;
  tags: RouteTag[];
  accessLevel: AccessLevel;
  reasons?: string[];
}

/* ------------------------------------------------------------------ */
/* Execution providers (spec §29) + workers (spec §30)                 */
/* ------------------------------------------------------------------ */

export type ExecutionProviderId = "local" | "remote-worker" | (string & {});

export interface RemoteJobPayload {
  jobId: string;
  operation: "resolve" | "inspect" | "acquire" | "verify";
  resource: string;
  capability: Capability;
  constraints: {
    output?: OutputRequirements;
    environment?: EnvironmentConstraints;
    policy?: AccessPolicy;
    platform?: PlatformId;
  };
  issuedAt: string;
  /** HMAC signature covers the rest of the payload (spec §30). */
  signature?: string;
}

export interface RemoteJobResult {
  jobId: string;
  status: "completed" | "partial" | "failed";
  envelope?: UAALEnvelope;
  artifacts?: Array<{ filename: string; mimeType: string; size: number; checksum: string; contentBase64?: string; contentUrl?: string }>;
  errors?: Array<{ code: string; message: string }>;
}

export interface ExecutionProvider {
  id: ExecutionProviderId;
  /** Can this provider run the given route right now? */
  supports(route: AccessRoute, environment: EnvironmentProfile): boolean;
  /** Execute a route through this provider. */
  executeRoute(route: AccessRoute, request: ResourceRequest, ctx: ExecutionContext): Promise<RouteResult>;
}

/* ------------------------------------------------------------------ */
/* Configuration (spec §58)                                            */
/* ------------------------------------------------------------------ */

export interface UAALConfig {
  /** Base directory for runtime state (jobs, sessions, stats, cache). */
  stateDir?: string;
  /** Where verified artifacts are stored. */
  artifactsDir?: string;
  /** Per-attempt default timeout ms. */
  attemptTimeoutMs?: number;
  /** Whole-operation timeout ms. */
  operationTimeoutMs?: number;
  /** Download size cap (bytes). */
  maxDownloadBytes?: number;
  /** Max HTTP redirects. */
  maxRedirects?: number;
  /** Optional HTTP API bearer token (HTTP interface). */
  apiToken?: string;
  /** Log level: debug | info | warn | error. */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Enable the learning layer (default true; bounded, reversible). */
  learning?: boolean;
  /** Enable caching of metadata (default true). */
  cache?: boolean;
  /** Politeness: minimum ms between requests to the same host. */
  politenessMs?: number;
  /** Extra adapter config. */
  adapters?: Record<string, Record<string, unknown>>;
  /** TEST/DEV ONLY: allow plain http to loopback (integration tests against local mock servers). */
  allowLoopbackHttp?: boolean;
  /** Execution providers to enable (default ["local"]). */
  executionProviders?: ExecutionProviderId[];
}

export const DEFAULT_CONFIG: Required<Pick<UAALConfig, "attemptTimeoutMs" | "operationTimeoutMs" | "maxDownloadBytes" | "maxRedirects" | "logLevel" | "learning" | "cache" | "politenessMs">> = {
  attemptTimeoutMs: 180_000,
  operationTimeoutMs: 300_000,
  maxDownloadBytes: 2 * 1024 * 1024 * 1024,
  maxRedirects: 5,
  logLevel: "info",
  learning: true,
  cache: true,
  politenessMs: 400
};
