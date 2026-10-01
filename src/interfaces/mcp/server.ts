/**
 * MCP server (spec §21, §45): exposes the universal contract as strict,
 * machine-readable tools. stdio transport via @modelcontextprotocol/sdk.
 * Tool descriptions state purpose, inputs, outputs, errors, side effects,
 * and artifact behavior per the spec.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { UAAL } from "../../core/engine.js";
import type { ResourceRequest } from "../../core/contracts.js";
import { CAPABILITIES } from "../../core/contracts.js";
import { UAAL_VERSION } from "../../version.js";

export async function buildMcpServer(engine: UAAL): Promise<McpServer> {
  const server = new McpServer(
    { name: "uaal", version: UAAL_VERSION },
    {
      instructions:
        "UAAL (Universal Agent Access Layer): request platform resources by URL + capability. The system handles platform detection, access-route discovery, fallback, reconstruction, normalization and verification. Results carry a strict schema_version. Failure statuses are honest: ok|partial|empty|failed|unsupported|requires_auth|blocked. Do NOT parse internal route details unless you need diagnostics — read envelope.attempts only when a result fails."
    }
  );

  const resourceFields = {
    resource: z.string().describe("The resource URL (any supported platform shape; platform is auto-detected)"),
    platform: z.string().optional().describe("Force platform (youtube|x|reddit|generic-web)"),
    capability: z.enum(CAPABILITIES as unknown as [string, ...string[]]).optional().describe("Requested capability; defaults per tool"),
    format: z.array(z.string()).optional().describe("Output format hints, e.g. [\"video\"] or [\"audio\"]"),
    maxBytes: z.number().optional().describe("Max artifact size in bytes")
  };

  function toRequest(args: { resource: string; platform?: string; capability?: string; format?: string[]; maxBytes?: number; requestId?: string }): ResourceRequest {
    const req: ResourceRequest = {
      resource: args.resource,
      platform: args.platform,
      capability: args.capability as ResourceRequest["capability"],
      output: args.format || args.maxBytes ? { ...(args.format ? { format: args.format } : {}), ...(args.maxBytes ? { maxBytes: args.maxBytes } : {}) } : undefined,
      requestId: args.requestId
    };
    return req;
  }

  const text = (value: unknown): { content: Array<{ type: "text"; text: string }> } => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  });

  server.tool(
    "uaal_resolve",
    "Resolve a resource to its canonical identity (platform, type, id, canonical URL). Purpose: dedup/caching/identity. No network-heavy work. Output: envelope with identity. Errors: failed|unsupported when no adapter can parse the resource. Side effects: may expand shortlinks (t.co) over the network.",
    resourceFields,
    async (args) => text(await engine.resolve(toRequest(args)))
  );

  server.tool(
    "uaal_inspect",
    "Inspect what is available for a resource without heavy acquisition. Purpose: cheap metadata answer. Output: envelope with resource (normalized metadata) and attempts. Errors: honest failure statuses; empty means the resource does not exist.",
    resourceFields,
    async (args) => text(await engine.inspect(toRequest(args)))
  );

  server.tool(
    "uaal_acquire",
    "Acquire VERIFIED artifacts for a resource (video/audio/image/json/manifest). Purpose: actual acquisition. Output: envelope with artifacts[] (artifactId, checksum, size, mimeType, delivery info) and verification. Errors: failed with ALL_ROUTES_EXHAUSTED + attempts; requires_auth/blocked surface honestly. Side effects: writes files into the artifact store; idempotent (repeated requests reuse the same verified artifact).",
    resourceFields,
    async (args) => text(await engine.acquire(toRequest(args)))
  );

  server.tool(
    "uaal_verify",
    "Verify an artifact produced earlier. Inputs: artifactId OR path. Output: verification result with named checks (exists, size, magic bytes, ffprobe, checksum...). No side effects.",
    { artifactId: z.string().optional().describe("Artifact id from a previous acquire"), path: z.string().optional().describe("Local artifact path") },
    async (args) => text(await engine.verifyArtifact(args))
  );

  server.tool(
    "uaal_routes",
    "List route registry + learned per-route statistics (success ratios, cooldowns, failure streaks). Read-only diagnostics.",
    {},
    async () =>
      text({
        schemaVersion: "1.0",
        adapters: engine.registry.all().map((a) => ({ platform: a.id, capabilities: a.capabilities().map((c) => c.name), limitations: a.limitations() })),
        stats: engine.stats.all()
      })
  );

  server.tool(
    "uaal_capabilities",
    "List the capability registry and per-platform capability support + documented limitations. Read-only.",
    {},
    async () => text(engine.capabilitiesInfo())
  );

  server.tool(
    "uaal_schema",
    "Return JSON Schemas for all UAAL response contracts (envelope, resource, artifact, verification). Purpose: let agents validate results themselves.",
    {},
    async () => text(engine.schemaInfo())
  );

  server.tool(
    "uaal_health",
    "System health: core version, environment class, adapters, route health, storage, dependency availability (ffmpeg/ffprobe/yt-dlp). Non-destructive.",
    {},
    async () => text(await engine.health())
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const engine = await UAAL.create({
    config: {
      stateDir: process.env.UAAL_STATE_DIR ?? (process.env.UAAL_HOME ? `${process.env.UAAL_HOME}/state` : undefined),
      artifactsDir: process.env.UAAL_ARTIFACTS_DIR,
      logLevel: (process.env.UAAL_LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "warn"
    }
  });
  const server = await buildMcpServer(engine);
  await server.connect(new StdioServerTransport());
  // stdio transport: process stays alive; stdout belongs to MCP, logs go to stderr via logger
}
