/**
 * CLI (spec §22, §50, §51, §52, §53): machine-readable JSON on stdout,
 * human logs on stderr. Exit codes: 0 ok/partial, 4 empty, 1 failed/
 * unsupported/requires_auth/blocked, 2 usage.
 */
import { Command } from "commander";
import { UAAL } from "../core/engine.js";
import { Logger } from "../core/observability.js";
import { DEFAULT_CONFIG, type ResourceRequest, type UAALConfig } from "../core/contracts.js";
import type { UAALStatus } from "../core/errors.js";
import { isCapability } from "../core/capabilities.js";

function numEnv(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Exit without truncating pending async writes (stdout/stderr may be pipes). */
async function exitFlushed(code: number): Promise<never> {
  await new Promise<void>((res) => process.stdout.write("", () => res()));
  await new Promise<void>((res) => process.stderr.write("", () => res()));
  process.exit(code);
}

function configFromEnv(overrides: Partial<UAALConfig> = {}): UAALConfig {
  const cfg: UAALConfig = {
    stateDir: process.env.UAAL_STATE_DIR ?? (process.env.UAAL_HOME ? `${process.env.UAAL_HOME}/state` : undefined),
    artifactsDir: process.env.UAAL_ARTIFACTS_DIR,
    attemptTimeoutMs: numEnv("UAAL_ATTEMPT_TIMEOUT_MS"),
    operationTimeoutMs: numEnv("UAAL_OPERATION_TIMEOUT_MS"),
    maxDownloadBytes: numEnv("UAAL_MAX_DOWNLOAD_BYTES"),
    logLevel: (process.env.UAAL_LOG_LEVEL as UAALConfig["logLevel"]) ?? DEFAULT_CONFIG.logLevel,
    learning: process.env.UAAL_LEARNING !== "0",
    cache: process.env.UAAL_CACHE !== "0"
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (cfg as Record<string, unknown>)[k] = v;
  }
  return cfg;
}

function printEnvelope(envelope: unknown): void {
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

const EXIT_CODES: Record<UAALStatus, number> = {
  ok: 0,
  partial: 0,
  empty: 4,
  failed: 1,
  unsupported: 1,
  requires_auth: 1,
  blocked: 1
};

interface CommonOpts {
  platform?: string;
  capability?: string;
  format?: string;
  maxBytes?: number;
  verbose?: boolean;
  dryRun?: boolean;
  timeout?: number;
  requestId?: string;
}

function buildRequest(url: string, opts: CommonOpsAlias): ResourceRequest {
  const req: ResourceRequest = { resource: url };
  if (opts.platform) req.platform = String(opts.platform);
  if (opts.capability) {
    if (!isCapability(String(opts.capability))) throw new Error(`unknown capability: ${String(opts.capability)}`);
    req.capability = String(opts.capability) as ResourceRequest["capability"];
  }
  const format = typeof opts.format === "string" ? opts.format.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  if (format || opts.maxBytes) {
    req.output = {
      ...(format ? { format } : {}),
      ...(opts.maxBytes ? { maxBytes: Number(opts.maxBytes) } : {})
    };
  }
  if (opts.timeout) {
    req.policy = { ...(req.policy ?? {}), attemptTimeoutMs: Number(opts.timeout) };
  }
  if (opts.requestId) req.requestId = String(opts.requestId);
  return req;
}
type CommonOpsAlias = CommonOpts;

async function makeEngine(opts: { verbose?: boolean; silent?: boolean }): Promise<UAAL> {
  const logger = new Logger({
    level: opts.verbose ? "debug" : ((process.env.UAAL_LOG_LEVEL as UAALConfig["logLevel"]) ?? DEFAULT_CONFIG.logLevel),
    silent: opts.silent
  });
  return UAAL.create({ config: configFromEnv({ logLevel: opts.verbose ? "debug" : undefined }), logger });
}

function addCommon(cmd: Command): Command {
  return cmd
    .option("--platform <platform>", "force platform (youtube|x|reddit|generic-web)")
    .option("--capability <capability>", "override capability")
    .option("--format <formats>", "output formats, comma separated (video,audio)")
    .option("--max-bytes <n>", "max artifact bytes", Number)
    .option("--verbose", "debug logging to stderr")
    .option("--dry-run", "discovery + plan only, no routes executed")
    .option("--timeout <ms>", "per-attempt timeout override", Number)
    .option("--request-id <id>", "caller correlation id");
}

async function runOp(engine: UAAL, op: "resolve" | "inspect" | "acquire", url: string, opts: CommonOpts): Promise<void> {
  const request = buildRequest(url, opts);
  if (!request.capability) request.capability = op === "acquire" ? "acquire" : op === "inspect" ? "inspect" : "resolve";
  if (opts.dryRun) {
    const plan = await engine.plan(request);
    printEnvelope(plan);
    process.exit(EXIT_CODES[plan.status] ?? 1);
  }
  const envelope = op === "resolve" ? await engine.resolve(request) : op === "inspect" ? await engine.inspect(request) : await engine.acquire(request);
  printEnvelope(envelope);
  process.exit(EXIT_CODES[envelope.status] ?? 1);
}

export function buildCli(): Command {
  const program = new Command();
  program.name("uaal").description("Universal Agent Access Layer — platform-agnostic resource access for AI agents").version("1.0.0");

  // No subcommand → interactive grab wizard (one command, guided flow)
  program.action(async () => {
    const { runWizard } = await import("./wizard.js");
    const result = await runWizard();
    await exitFlushed(result.exitCode);
  });

  program
    .command("grab [url]")
    .description("Interactive grab: paste a link, choose storage, watch progress (url optional)")
    .action(async (url: string | undefined) => {
      const { runWizard } = await import("./wizard.js");
      const result = await runWizard({ url });
      await exitFlushed(result.exitCode);
    });

  addCommon(program.command("resolve <url>").description("Resolve canonical resource identity (engine-level)"));
  program.commands[program.commands.length - 1].action(async (url: string, opts: CommonOpts) => {
    const engine = await makeEngine({ verbose: opts.verbose });
    await runOp(engine, "resolve", url, opts);
  });
  addCommon(program.command("inspect <url>").description("Inspect what is available without heavy acquisition"));
  program.commands[program.commands.length - 1].action(async (url: string, opts: CommonOpts) => {
    const engine = await makeEngine({ verbose: opts.verbose });
    await runOp(engine, "inspect", url, opts);
  });
  addCommon(program.command("acquire <url>").description("Acquire verified artifacts (media, snapshots, manifests)"));
  program.commands[program.commands.length - 1].action(async (url: string, opts: CommonOpts) => {
    const engine = await makeEngine({ verbose: opts.verbose });
    await runOp(engine, "acquire", url, opts);
  });

  program
    .command("verify <artifact>")
    .description("Verify an artifact by artifactId or path")
    .action(async (ref: string) => {
      const engine = await makeEngine({ silent: true });
      const envelope = await engine.verifyArtifact(ref.startsWith("art_") ? { artifactId: ref } : { path: ref });
      printEnvelope(envelope);
      process.exit(EXIT_CODES[envelope.status] ?? 1);
    });

  program
    .command("routes [url]")
    .description("Show route registry, learned statistics, and (with a url) live discovery")
    .option("--platform <platform>", "filter by platform prefix")
    .action(async (url: string | undefined, opts: { platform?: string }) => {
      const engine = await makeEngine({ silent: true });
      const allStats = engine.stats.all();
      const stats = opts.platform ? allStats.filter((s) => s.key.startsWith(`${opts.platform}.`)) : allStats;
      const identity = url ? (await engine.resolve({ resource: url, capability: "resolve" }).catch(() => undefined))?.identity : undefined;
      let discovery: unknown;
      if (url && identity) {
        const plan = await engine.plan({ resource: url, capability: "metadata" });
        discovery = plan.discovery;
      }
      printEnvelope({
        schemaVersion: "1.0",
        adapters: engine.registry.all().map((a) => ({ platform: a.id, capabilities: a.capabilities().map((c) => c.name), limitations: a.limitations() })),
        stats,
        identity,
        discovery
      });
      process.exit(0);
    });

  program
    .command("capabilities")
    .description("List capability registry and per-platform support")
    .action(async () => {
      const engine = await makeEngine({ silent: true });
      printEnvelope(engine.capabilitiesInfo());
      process.exit(0);
    });

  program
    .command("schema")
    .description("Export JSON schemas for all response contracts")
    .action(async () => {
      const engine = await makeEngine({ silent: true });
      printEnvelope(engine.schemaInfo());
      process.exit(0);
    });

  program
    .command("health")
    .description("System health: core, adapters, routes, storage, dependencies")
    .action(async () => {
      const engine = await makeEngine({ silent: true });
      printEnvelope(await engine.health());
      process.exit(0);
    });

  program
    .command("sessions")
    .description("List recent execution sessions")
    .option("--limit <n>", "max sessions", Number, 20)
    .action(async (opts: { limit?: number }) => {
      const engine = await makeEngine({ silent: true });
      printEnvelope({ sessions: await engine.sessions.list(opts.limit ?? 20) });
      process.exit(0);
    });

  program
    .command("stats")
    .description("Show / reset the route-learning store")
    .option("--reset [routeId]", "reset learning (one route or all)")
    .action(async (opts: { reset?: string | boolean }) => {
      const engine = await makeEngine({ silent: true });
      if (opts.reset !== undefined) {
        await engine.stats.reset(typeof opts.reset === "string" ? opts.reset : undefined);
        printEnvelope({ reset: true, route: typeof opts.reset === "string" ? opts.reset : "all" });
        process.exit(0);
      }
      printEnvelope({ schemaVersion: "1.0", stats: engine.stats.all() });
      process.exit(0);
    });

  program
    .command("mcp")
    .description("Run the MCP server on stdio (spec §21); stdout is MCP protocol only")
    .action(async () => {
      const { runMcpServer } = await import("./mcp/server.js");
      await runMcpServer();
    });

  program
    .command("serve")
    .description("Run the HTTP API server (spec §23)")
    .option("--port <n>", "listen port", Number)
    .option("--host <h>", "bind host")
    .action(async (opts: { port?: number; host?: string }) => {
      const { startHttpServer } = await import("./http/server.js");
      const { url } = await startHttpServer(configFromEnv(), { port: opts.port, host: opts.host });
      process.stderr.write(`uaal-http: listening on ${url}\n`);
      // process stays alive; graceful shutdown handled in buildHttpServer
    });

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = buildCli();
  await program.parseAsync(argv);
}
