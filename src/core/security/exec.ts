/**
 * Safe subprocess execution (spec §27): argv-only (never a shell), hard
 * timeouts with process-group kill (no orphan processes, spec §62), bounded
 * stdout/stderr capture, cancellation propagation, env allowlisting.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";

export interface SafeExecOptions {
  cmd: string;
  args: string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Rows of output are capped by default to prevent memory exhaustion. */
  onStdout?: (chunk: Buffer) => void;
}

export interface SafeExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  stdoutBytes: number;
  durationMs: number;
}

export class ExecDependencyError extends Error {
  constructor(binary: string) {
    super(`required binary not found: ${binary}`);
    this.name = "ExecDependencyError";
  }
}

const DEFAULT_MAX_CAPTURE = 2 * 1024 * 1024; // 2 MiB per stream

export function safeExec(opts: SafeExecOptions): Promise<SafeExecResult> {
  const {
    cmd,
    args,
    timeoutMs = 120_000,
    maxStdoutBytes = DEFAULT_MAX_CAPTURE,
    maxStderrBytes = DEFAULT_MAX_CAPTURE,
    cwd,
    env,
    signal,
    onStdout
  } = opts;

  return new Promise<SafeExecResult>((resolve) => {
    const startedAt = Date.now();
    let timedOut = false;
    let killed = false;
    let stdoutBytes = 0;
    let settled = false;

    let child;
    try {
      // detached => own process group, enables group kill (no orphans)
      child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd,
        detached: true,
        env: env ? { ...minimalEnv(), ...env } : minimalEnv()
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        resolve({ code: null, signal: null, stdout: "", stderr: `binary not found: ${cmd}`, timedOut: false, killed: false, stdoutBytes: 0, durationMs: 0 });
        return;
      }
      resolve({ code: null, signal: null, stdout: "", stderr: `spawn failed: ${e.message}`, timedOut: false, killed: false, stdoutBytes: 0, durationMs: 0 });
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);

    const collect = (buf: Buffer, target: "stdout" | "stderr"): void => {
      const cap = target === "stdout" ? maxStdoutBytes : maxStderrBytes;
      const arr = target === "stdout" ? stdout : stderr;
      const room = Math.max(0, cap - arr.length);
      const slice = buf.subarray(0, room);
      if (target === "stdout") {
        stdoutBytes += buf.length;
        if (onStdout) onStdout(buf);
      }
      if (slice.length > 0) {
        if (target === "stdout") stdout = Buffer.concat([stdout, slice]);
        else stderr = Buffer.concat([stderr, slice]);
      }
    };

    child.stdout.on("data", (c: Buffer) => collect(c, "stdout"));
    child.stderr.on("data", (c: Buffer) => collect(c, "stderr"));

    const killGroup = (sig: NodeJS.Signals = "SIGTERM"): void => {
      killed = true;
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already dead */
        }
      }
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killGroup("SIGTERM");
            // hard deadline: SIGKILL after grace period
            setTimeout(() => {
              if (!settled) killGroup("SIGKILL");
            }, 3_000).unref();
          }, timeoutMs)
        : null;

    const onAbort = (): void => {
      killGroup("SIGTERM");
      setTimeout(() => {
        if (!settled) killGroup("SIGKILL");
      }, 2_000).unref();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        signal: sig,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        killed,
        stdoutBytes,
        durationMs: Date.now() - startedAt
      });
    };

    child.on("error", () => finish(null, null));
    child.on("close", (code, sig) => finish(code, sig));
  });
}

function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SystemRoot", "SYSTEMROOT", "USERPROFILE"]) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

/** Locate a binary on PATH; returns absolute path or false. */
export async function findBinary(name: string): Promise<string | false> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const dir of dirs) {
    const candidate = `${dir}/${name}${ext}`;
    try {
      const { access, constants } = await import("node:fs/promises");
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return false;
}
