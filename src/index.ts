/**
 * UAAL public API: embed the engine in-process, or boot the interfaces.
 */
export { UAAL, writeRuntimeConfig } from "./core/engine.js";
export { DEFAULT_CONFIG } from "./core/contracts.js";
export type {
  ResourceRequest,
  ResourceIdentity,
  UAALEnvelope,
  NormalizedResource,
  Artifact,
  VerificationResult,
  AccessRoute,
  PlatformAdapter,
  Capability,
  UAALConfig,
  JobRecord,
  EnvironmentProfile,
  DiscoveredRouteInfo,
  AttemptRecord
} from "./core/contracts.js";
export { FailureCode, UAALError } from "./core/errors.js";
export { validateEnvelope, exportJsonSchemas, envelopeSchema } from "./core/schemas.js";
export { capabilityRegistry, isCapability } from "./core/capabilities.js";
export { PlatformRegistry } from "./core/identity.js";
export { detectEnvironment } from "./core/environment.js";
export { Logger, redactSecrets } from "./core/observability.js";
export { buildCli } from "./interfaces/cli.js";
export { buildHttpServer, startHttpServer } from "./interfaces/http/server.js";
export { buildMcpServer, runMcpServer } from "./interfaces/mcp/server.js";
export { getBuiltinAdapters, YouTubeAdapter, XAdapter, RedditAdapter, GenericWebAdapter } from "./adapters/index.js";
export { UaalWorker } from "./workers/worker.js";
export { signPayload, verifySignature } from "./workers/protocol.js";
export { UAAL_VERSION, SCHEMA_VERSION } from "./version.js";
