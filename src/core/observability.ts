/**
 * Observability (spec §34, §71): structured JSONL logs to stderr, request
 * traces, redaction of secrets. stdout is ALWAYS reserved for machine output.
 */
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Patterns whose matches are replaced before any output leaves the process. */
const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // github tokens
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(api[_-]?key|token|secret|password|authorization)\s*[=:]\s*["']?[A-Za-z0-9\-._~+/]{8,}/gi,
  /eyJ[A-Za-z0-9\-_.]+/g, // JWT-like
  /https?:\/\/[^/\s:]+:[^@\s/]+@/g // URL credentials
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = /authorization|cookie|password|secret|token|apikey|api_key/i.test(k) ? "[REDACTED]" : redactValue(v, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  stream?: Writable;
  silent?: boolean;
}

export class Logger {
  private level: number;
  private stream: Writable;
  private silent: boolean;
  private traceId: string;

  constructor(opts: LoggerOptions = {}) {
    this.level = LEVELS[opts.level ?? "info"];
    this.stream = opts.stream ?? process.stderr;
    this.silent = opts.silent ?? false;
    this.traceId = newTraceId();
  }

  child(fields: Record<string, unknown>): Logger {
    const c = Object.create(this) as Logger;
    c.traceId = this.traceId;
    return c;
  }

  setLevel(level: LogLevel): void {
    this.level = LEVELS[level];
  }

  withTrace(traceId: string): Logger {
    const c = Object.create(this) as Logger;
    c.traceId = traceId;
    return c;
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (this.silent || LEVELS[level] < this.level) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      trace_id: this.traceId,
      msg: redactSecrets(msg),
      ...(fields ? (redactValue(fields) as Record<string, unknown>) : {})
    };
    try {
      this.stream.write(`${JSON.stringify(record)}\n`);
    } catch {
      /* logging must never crash the engine */
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit("error", msg, fields);
  }
}

export function newTraceId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

/** Run-scoped trace: collects the timeline of an operation for sessions. */
export interface TraceEvent {
  at: string;
  event: string;
  [key: string]: unknown;
}

export class Trace {
  readonly traceId: string;
  readonly events: TraceEvent[] = [];
  private startedAt = Date.now();
  private onEvent?: (e: TraceEvent) => void;

  constructor(traceId: string = newTraceId(), onEvent?: (e: TraceEvent) => void) {
    this.traceId = traceId;
    this.onEvent = onEvent;
  }

  add(event: string, fields?: Record<string, unknown>): void {
    const e: TraceEvent = { at: new Date().toISOString(), event, ...redactValue(fields ?? {}) as Record<string, unknown> };
    this.events.push(e);
    try {
      this.onEvent?.(e);
    } catch {
      /* observer errors must never break an operation */
    }
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  toRecords(): TraceEvent[] {
    return this.events.map((e) => ({ ...e, trace_id: this.traceId }));
  }
}
