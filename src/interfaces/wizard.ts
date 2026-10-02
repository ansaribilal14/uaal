/**
 * Interactive grab wizard (spec §50: human interface).
 *
 * One command → paste a link (X/Twitter, YouTube, Reddit, Threads, Instagram,
 * or any web page) → pick where to save → watch plain-language progress →
 * "All set". Machine JSON is NEVER shown here; progress goes to stderr and
 * the final summary to stdout. Failures are translated to human reasons —
 * the system stays fail-closed underneath (no fake successes, ever).
 */
import { promises as fs, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { UAAL } from "../core/engine.js";
import { Logger } from "../core/observability.js";
import { DEFAULT_CONFIG, type Artifact, type UAALEnvelope } from "../core/contracts.js";
import type { UAALStatus } from "../core/errors.js";
import type { TraceEvent } from "../core/observability.js";

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

export interface PlatformPreview {
  label: string;
  hint?: string;
}

/** Host-based platform preview — purely local, no network. */
export function platformPreview(rawUrl: string): PlatformPreview {
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { label: "Unknown link" };
  }
  if (/(^|\.)x\.com$/.test(host) || /(^|\.)twitter\.com$/.test(host) || host === "t.co") {
    return { label: "X (Twitter)" };
  }
  if (host === "youtu.be" || /(^|\.)youtube\.com$/.test(host) || host === "youtube-nocookie.com") {
    return {
      label: "YouTube",
      hint: "full video saving needs yt-dlp on PATH (pkg install youtube-dl / pip install yt-dlp); metadata works without it"
    };
  }
  if (/(^|\.)reddit\.com$/.test(host) || host === "redd.it" || host === "v.redd.it") {
    return { label: "Reddit" };
  }
  if (/(^|\.)threads\.(net|com)$/.test(host)) {
    return { label: "Threads", hint: "served via the generic web route (public page data only — often text + image)" };
  }
  if (/(^|\.)instagram\.com$/.test(host) || host === "instagr.am") {
    return {
      label: "Instagram",
      hint: "served via the generic web route — Instagram often hides public pages behind a login; UAAL never bypasses that"
    };
  }
  return { label: "Generic web page" };
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Human reasons for machine failure codes (fail-closed stays intact). */
export function friendlyFailure(status: UAALStatus, code: string | undefined, message: string | undefined): string {
  const c = code ?? "";
  if (status === "requires_auth" || c === "AUTH_REQUIRED") return "Needs an account we don't have. UAAL never bypasses logins.";
  if (status === "blocked" || c === "BLOCKED") return "The source refused access from this network (blocked). Reported honestly — nothing faked.";
  if (c === "RATE_LIMIT") return "Rate limited by the public route — usually clears in a minute or two, try again shortly.";
  if (c === "INVALID_RESOURCE") return "That doesn't look like a link we can parse.";
  if (c === "TIMEOUT") return "The source took too long to respond.";
  if (c === "NETWORK_FAILURE") return "Network problem reaching the source.";
  if (c === "EMPTY_RESULT") return "The source returned nothing usable — the post may be deleted, private, or region-locked.";
  if (c === "UNSUPPORTED_CAPABILITY" || c === "NO_ROUTES_DECLARED") return "No installed route can do this yet.";
  if (c === "ALL_ROUTES_FILTERED") return "No available route can grab this right now — every candidate was filtered out. If it's a YouTube video, install yt-dlp (pip install yt-dlp); some sources simply have no public route.";
  if (c === "ALL_ROUTES_EXHAUSTED") return "Every available route was tried and failed — nothing partial was saved.";
  if (c === "ENVIRONMENT_INCOMPATIBLE") return "The routes for this need tools this device doesn't have (e.g. yt-dlp or ffmpeg).";
  if (c === "DEPENDENCY_FAILURE") return "A helper needed for this is missing on this device (e.g. yt-dlp or ffmpeg).";
  if (c === "VERIFICATION_FAILURE" || c === "INVALID_ARTIFACT") return "Downloaded data failed verification, so it was NOT saved (fail-closed).";
  if (c === "PARSER_FAILURE") return "The source responded, but with data we couldn't understand.";
  if (c === "POLICY_VIOLATION") return "Refused by access policy (e.g. private source).";
  if (c === "CANCELLED") return "Cancelled.";
  return message ? message.slice(0, 200) : `Unavailable (${status}).`;
}

export interface StorageOption {
  key: "default" | "downloads" | "here" | "custom";
  label: string;
  target?: string;
  available: boolean;
}

/** Storage menu (pure: directory existence is injected). */
export function storageChoices(cwd: string, home: string, exists: (p: string) => boolean): StorageOption[] {
  const dlCandidates = [path.join(home, "storage", "downloads"), path.join(home, "Downloads"), "/sdcard/Download"];
  const downloads = dlCandidates.find((p) => exists(p));
  return [
    { key: "default", label: `Default storage (${path.join(cwd, "artifacts")})`, target: path.join(cwd, "artifacts"), available: true },
    { key: "downloads", label: `Device Downloads (${downloads ?? "not found on this device"})`, target: downloads, available: Boolean(downloads) },
    { key: "here", label: `This folder (${cwd})`, target: cwd, available: true },
    { key: "custom", label: "Custom path…", available: true }
  ];
}

export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/* ------------------------------------------------------------------ */
/* Terminal UI                                                         */
/* ------------------------------------------------------------------ */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useColor(stream: NodeJS.WriteStream): boolean {
  return Boolean(stream.isTTY) && !process.env.NO_COLOR;
}

/**
 * Ordered line reader: unlike rl.question(), lines that arrive before a
 * prompt is shown are queued (not dropped), so piped/scripted input works
 * and EOF is detectable. Interactive TTYs still get echo + line editing.
 */
function makeLineReader(input: NodeJS.ReadStream, out: NodeJS.WriteStream): { ask: (prompt: string) => Promise<string | undefined>; close: () => void } {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const rl = createInterface({ input, output: out, terminal: Boolean(input.isTTY) });
  rl.on("line", (line: string) => {
    queue.push(line);
    const w = wake;
    wake = undefined;
    w?.();
  });
  rl.on("close", () => {
    closed = true;
    const w = wake;
    wake = undefined;
    w?.();
  });
  return {
    async ask(prompt: string): Promise<string | undefined> {
      if (prompt) out.write(prompt);
      for (;;) {
        if (queue.length > 0) return queue.shift();
        if (closed) return undefined;
        await new Promise<void>((resolve) => {
          wake = () => resolve();
        });
      }
    },
    close(): void {
      rl.close();
    }
  };
}

class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private startedAt = 0;
  private frame = 0;
  private text = "";

  constructor(private readonly stream: NodeJS.WriteStream) {}

  start(text: string): void {
    this.text = text;
    this.startedAt = Date.now();
    if (!this.stream.isTTY) {
      this.stream.write(`${text}\n`);
      return;
    }
    this.timer = setInterval(() => {
      const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      const line = `${SPINNER_FRAMES[this.frame]} ${this.text} \x1b[2m(${secs}s)\x1b[0m`;
      this.stream.write(`\r\x1b[K${line}`);
    }, 90);
    this.stream.write(`\r\x1b[K${SPINNER_FRAMES[0]} ${this.text}`);
  }

  update(text: string): void {
    this.text = text;
    if (!this.stream.isTTY) this.stream.write(`${text}\n`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.stream.isTTY) this.stream.write("\r\x1b[K");
  }
}

/* ------------------------------------------------------------------ */
/* Progress from live trace events                                     */
/* ------------------------------------------------------------------ */

interface ProgressState {
  lastRoute?: string;
  failures: string[];
  reused: boolean;
}

function applyTraceEvent(spinner: Spinner, state: ProgressState, e: TraceEvent): void {
  switch (e.event) {
    case "identity.begin":
      spinner.update("Resolving link…");
      break;
    case "identity.ok": {
      const p = String(e.platform ?? "");
      const t = String(e.type ?? "");
      const id = String(e.id ?? "");
      spinner.update(`Found ${p ? `${p} ` : ""}${t}${id ? ` ${id}` : ""} — looking up details…`);
      break;
    }
    case "discovery.done": {
      const eligible = Number(e.eligible ?? 0);
      if (eligible > 0) spinner.update(`Choosing best of ${eligible} available route(s)…`);
      break;
    }
    case "route.execute.start":
      state.lastRoute = String(e.route ?? "");
      spinner.update(`Fetching via ${state.lastRoute}…`);
      break;
    case "route.failure": {
      const line = `${String(e.route ?? "?")} → ${String(e.code ?? "failed")}`;
      state.failures.push(line);
      spinner.update(`Route failed (${String(e.code ?? "")}) — switching to next route…`);
      break;
    }
    case "route.success":
      spinner.update(`Got ${Number(e.artifacts ?? 0)} file(s) — verifying…`);
      break;
    case "idempotency.hit":
      state.reused = true;
      spinner.update("Already saved earlier — reusing verified copies…");
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Output rendering                                                    */
/* ------------------------------------------------------------------ */

const PLATFORM_LABELS: Record<string, string> = {
  x: "X (Twitter)",
  youtube: "YouTube",
  reddit: "Reddit",
  "generic-web": "web page"
};

function resourceSummary(env: UAALEnvelope, out: NodeJS.WriteStream): void {
  const r = env.resource;
  const i = env.identity;
  const color = useColor(out);
  const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  if (!r && !i) return;
  const platLabel = PLATFORM_LABELS[String(i?.platform ?? r?.platform ?? "")] ?? String(i?.platform ?? r?.platform ?? "");
  const kind = i?.type ?? r?.resource?.type ?? "resource";
  const id = i?.id ? ` ${dim(i.id)}` : "";
  const author = r?.author?.handle ? `@${r.author.handle}` : r?.author?.name ?? "";
  const text = (r?.content?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 72);
  const media = r?.media?.length ?? 0;
  const bits = [
    green("✓"),
    `Found: ${[platLabel, kind].filter(Boolean).join(" ")}${id}`,
    author ? `by ${author}` : "",
    text ? `— ${text}${(r?.content?.text ?? "").length > 72 ? "…" : ""}` : "",
    media > 0 ? dim(`(${media} media item${media === 1 ? "" : "s"})`) : ""
  ].filter(Boolean);
  out.write(`${bits.join(" ")}\n`);
}

function artifactLines(artifacts: Artifact[], out: NodeJS.WriteStream): void {
  const color = useColor(out);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  for (const [idx, a] of artifacts.entries()) {
    const size = formatBytes(a.size ?? 0);
    const flag = a.verificationStatus === "verified" ? dim("verified") : dim(`status: ${a.verificationStatus}`);
    out.write(`  ${idx + 1}. ${a.filename ?? a.artifactId}  ${dim(size)}  ${flag}\n`);
    out.write(`     ${dim(a.path)}\n`);
  }
}

function attemptsLine(env: UAALEnvelope): string {
  const tried = (env.attempts ?? []).map((a) => `${a.route} (${a.status}${a.failureCode ? `: ${a.failureCode}` : ""})`);
  return tried.length > 0 ? tried.join(", ") : "none";
}

/* ------------------------------------------------------------------ */
/* Wizard flow                                                         */
/* ------------------------------------------------------------------ */

export interface WizardIo {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export interface WizardResult {
  status: UAALStatus | "aborted";
  exitCode: number;
}

const EXIT: Record<UAALStatus | "aborted", number> = {
  ok: 0,
  partial: 0,
  empty: 4,
  failed: 1,
  unsupported: 1,
  requires_auth: 1,
  blocked: 1,
  aborted: 130
};

function numEnv(name: string): number | undefined {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export async function runWizard(opts: WizardIo & { url?: string; engine?: UAAL } = {}): Promise<WizardResult> {
  const stdin = opts.stdin ?? process.stdin;
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const color = useColor(out);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
  const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);

  const io = makeLineReader(stdin, out);
  const ask = io.ask;
  const spinner = new Spinner(err);

  out.write(`${bold("UAAL grab")}${dim(" — paste a link, pick storage, get verified files\n")}\n`);

  try {
    /* 1. Link --------------------------------------------------------- */
    let url = opts.url?.trim() ?? "";
    while (!url) {
      const line = await ask(`? Link (${dim("X, YouTube, Reddit, Threads, Instagram, or any page")}): `);
      if (line === undefined) {
        out.write(`${red("✗")} No link provided — nothing to do. ${dim("(usage: echo <url> | uaal, or run uaal and type one)")}\n`);
        return { status: "aborted", exitCode: 2 };
      }
      const candidate = line.trim();
      if (!candidate) continue;
      try {
        const u = new URL(candidate);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
        url = candidate;
      } catch {
        out.write(`${yellow("!")} That doesn't look like a URL — try again (${dim("Ctrl+C to quit")})\n`);
      }
    }

    const preview = platformPreview(url);
    out.write(`${dim("→")} Looks like ${bold(preview.label)}\n`);
    if (preview.hint) out.write(`  ${dim(preview.hint)}\n`);

    /* 2. Storage ------------------------------------------------------ */
    const cwd = process.cwd();
    const home = os.homedir();
    const choices = storageChoices(cwd, home, (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
    out.write(`\nSave to:\n`);
    choices.forEach((c, i) => {
      out.write(`  ${i + 1}) ${c.label}${c.available ? "" : dim(" (unavailable)")}\n`);
    });
    let dir: string | undefined;
    while (dir === undefined) {
      const answer = (await ask(`Choice ${dim("[1]")}: `))?.trim() ?? "";
      const pick = answer === "" ? 0 : Number(answer) - 1;
      const choice = choices[pick];
      if (!choice || !choice.available) {
        out.write(`${yellow("!")} Pick a number from the list\n`);
        continue;
      }
      if (choice.key === "custom") {
        const raw = expandHome((await ask("? Folder path: "))?.trim() ?? "", home);
        if (!raw) {
          out.write(`${yellow("!")} Empty path — falling back to default storage\n`);
          choice.target = choices[0].target;
          choice.key = "default";
        }
      }
      try {
        await fs.mkdir(choice.target!, { recursive: true });
        const probe = path.join(choice.target!, `.uaal-probe-${Date.now()}`);
        await fs.writeFile(probe, "ok");
        await fs.unlink(probe);
        dir = choice.target!;
      } catch {
        out.write(`${yellow("!")} Can't write there (${dim(choice.target ?? "")}) — pick another\n`);
        if (choice.key !== "custom") choice.available = false;
      }
    }

    /* 3. Run ---------------------------------------------------------- */
    const state: ProgressState = { failures: [], reused: false };
    const engine =
      opts.engine ??
      (await UAAL.create({
        config: {
          artifactsDir: dir,
          stateDir: process.env.UAAL_STATE_DIR ?? (process.env.UAAL_HOME ? `${process.env.UAAL_HOME}/state` : undefined),
          logLevel: "warn",
          politenessMs: DEFAULT_CONFIG.politenessMs,
          attemptTimeoutMs: numEnv("UAAL_ATTEMPT_TIMEOUT_MS"),
          operationTimeoutMs: numEnv("UAAL_OPERATION_TIMEOUT_MS"),
          maxDownloadBytes: numEnv("UAAL_MAX_DOWNLOAD_BYTES"),
          learning: process.env.UAAL_LEARNING !== "0",
          cache: process.env.UAAL_CACHE !== "0",
          onTrace: (e) => applyTraceEvent(spinner, state, e)
        },
        logger: new Logger({ level: "warn", silent: true })
      }));

    spinner.start("Resolving…");
    const env = await engine.acquire({ resource: url, capability: "acquire" }).catch((e: unknown) => {
      spinner.stop();
      throw e;
    });
    spinner.stop();

    /* 4. Result ------------------------------------------------------- */
    out.write("\n");
    if (env.status === "ok") {
      resourceSummary(env, out);
      const artifacts = env.artifacts ?? [];
      const passed = env.verification?.checks?.filter((c) => c.passed).length ?? 0;
      const total = env.verification?.checks?.length ?? 0;
      if (total > 0) out.write(`${green("✓")} Verified ${artifacts.length}/${artifacts.length} file(s) ${dim(`(${passed} checks passed)`)}\n`);
      if (state.reused) out.write(`${dim("note: reused verified copies already in storage — no re-download\n")}`);
      out.write(`\n${green(bold("All set ✅"))}\n`);
      if (artifacts.length > 0) {
        artifactLines(artifacts, out);
        const how = env.route?.id ? `route ${env.route.id}` : state.reused ? "served from local storage" : "";
        out.write(`\n${dim(`Saved to ${dir}  ·  ${((env.timing?.durationMs ?? 0) / 1000).toFixed(1)}s${how ? `  ·  ${how}` : ""}`)}\n`);
      } else {
        out.write(`${dim("No files were produced (nothing to save).")}\n`);
      }
    } else if (env.status === "partial") {
      resourceSummary(env, out);
      out.write(`${yellow("!")} Partially saved.\n`);
      if (env.available?.length) out.write(`  ${dim("available:")} ${env.available.join(", ")}\n`);
      if (env.missing?.length) out.write(`  ${dim("missing:")} ${env.missing.join(", ")}\n`);
      artifactLines(env.artifacts ?? [], out);
      for (const w of env.warnings ?? []) out.write(`  ${dim(`- ${w}`)}\n`);
      out.write(`\n${dim(`Saved to ${dir}  ·  trace ${env.traceId}`)}\n`);
    } else {
      out.write(`${red("✗")} Couldn't grab that link.\n`);
      out.write(`  ${dim("Why:")} ${friendlyFailure(env.status, env.error?.code, env.error?.message)}\n`);
      if (state.failures.length > 0) out.write(`  ${dim("Routes tried:")} ${state.failures.join(", ")}\n`);
      else out.write(`  ${dim("Routes tried:")} ${attemptsLine(env)}\n`);
      out.write(`  ${dim(`trace ${env.traceId ?? "?"}`)}\n`);
    }
    return { status: env.status, exitCode: EXIT[env.status] };
  } catch (e: unknown) {
    spinner.stop();
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort|interrupt|cancell/i.test(msg)) {
      out.write(`\n${dim("Cancelled — nothing was saved.\n")}`);
      return { status: "aborted", exitCode: EXIT.aborted };
    }
    out.write(`${red("✗")} Unexpected problem: ${msg.slice(0, 200)}\n`);
    return { status: "failed", exitCode: 1 };
  } finally {
    io.close();
  }
}
