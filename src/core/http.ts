/**
 * Shared hardened HTTP layer (spec §27, §63): every outbound request goes
 * through here. SSRF-guarded DNS (per-connect re-validation = anti
 * rebinding), redirect re-validation, hard byte caps, deadlines, polite
 * per-host pacing, no cookies, redacted errors.
 */
import { Agent, fetch as undiciFetch, request } from "undici";
import type { Dispatcher } from "undici";
import { assertLoopbackUrl, assertPublicUrl, lookupValidator, UrlBlockedError, type UrlGuardOptions } from "./security/urlguard.js";
import { USER_AGENT } from "../version.js";
import { FailureCode, type Failure } from "./errors.js";
import { redactSecrets } from "./observability.js";

export interface HttpLayerOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  guard?: UrlGuardOptions;
  politenessMs?: number;
  /** TEST/DEV ONLY: permit loopback http for this call (integration tests). */
  allowLoopback?: boolean;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
  latencyMs: number;
  redirected: boolean;
  bytesTruncated: boolean;
}

export interface SafeStreamResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  finalUrl: string;
  /** Read the body with a hard byte cap; rejects when cap exceeded. */
  readFully(): Promise<Buffer>;
  /** Pipe the body to a sink with a hard byte cap; resolves with bytes written. */
  pipeTo(write: (chunk: Buffer) => Promise<void> | void, maxBytes: number): Promise<{ bytes: number; truncated: boolean }>;
  cancel(): void;
}

const lastRequestAt = new Map<string, number>();

export class HttpLayer {
  private defaultTimeoutMs: number;
  private defaultMaxBytes: number;
  private maxRedirects: number;
  private politenessMs: number;
  private guard: UrlGuardOptions;
  private allowLoopback: boolean;
  private agents: Map<string, Agent>;

  constructor(opts: HttpLayerOptions & { allowLoopback?: boolean } = {}) {
    this.defaultTimeoutMs = opts.timeoutMs ?? 30_000;
    this.defaultMaxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
    this.maxRedirects = opts.maxRedirects ?? 5;
    this.politenessMs = opts.politenessMs ?? 0;
    this.guard = opts.guard ?? {};
    this.allowLoopback = opts.allowLoopback === true;
    this.agents = new Map();
  }

  /** Per-call validation: public https normally; loopback http only when explicitly allowed. */
  private validate(url: string, opts: HttpLayerOptions): { href: string; hostname: string; port: number } {
    const merged = { ...this.guard, ...opts.guard };
    if (this.allowLoopback || opts.allowLoopback === true) {
      try {
        const v = assertLoopbackUrl(url);
        return v;
      } catch {
        // fall through to public validation
      }
    }
    return assertPublicUrl(url, merged);
  }

  private agentFor(hostname: string): Agent {
    // Public hosts use the SSRF-validating lookup; loopback (tests) uses default.
    const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(hostname);
    const key = isLoopback ? "loopback" : "public";
    let agent = this.agents.get(key);
    if (!agent) {
      agent = new Agent(
        isLoopback
          ? { connect: { timeout: 10_000 } }
          : { connect: { timeout: 10_000, lookup: lookupValidator() as never } }
      );
      this.agents.set(key, agent);
    }
    return agent;
  }

  private async polite(hostname: string): Promise<void> {
    if (this.politenessMs <= 0) return;
    const now = Date.now();
    const last = lastRequestAt.get(hostname) ?? 0;
    const wait = last + this.politenessMs - now;
    lastRequestAt.set(hostname, Math.max(now, last + this.politenessMs));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** GET with redirects, byte cap, deadline. Body fully buffered. */
  async get(url: string, opts: HttpLayerOptions = {}): Promise<SafeResponse> {
    const started = Date.now();
    let current = url;
    let redirected = false;
    const maxRedirects = opts.maxRedirects ?? this.maxRedirects;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const v = this.validate(current, opts);
      await this.polite(v.hostname);
      const res = await undiciFetch(v.href, {
        method: "GET",
        dispatcher: this.agentFor(v.hostname) as unknown as Dispatcher,
        headers: { "user-agent": USER_AGENT, accept: "*/*", ...(opts.headers ?? this.guardHeaders(opts)) },
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs)
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) {
          throw new HttpFailure(`HTTP ${res.status} redirect without location`, res.status, FailureCode.HTTP_ERROR);
        }
        current = new URL(loc, v.href).href;
        redirected = true;
        res.body!.cancel().catch(() => {});
        continue;
      }

      const headers: Record<string, string> = {};
      res.headers.forEach((val, key) => {
        headers[key.toLowerCase()] = val;
      });

      const maxBytes = opts.maxBytes ?? this.defaultMaxBytes;
      const declared = Number(headers["content-length"] ?? 0);
      if (declared > maxBytes) {
        res.body!.cancel().catch(() => {});
        throw new HttpFailure(`response too large: ${declared} bytes (cap ${maxBytes})`, res.status, FailureCode.INVALID_ARTIFACT);
      }

      const reader = res.body!.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      // Read with deadline
      const deadline = AbortSignal.timeout((opts.timeoutMs ?? this.defaultTimeoutMs) + 5_000);
      try {
        while (true) {
          if (deadline.aborted && total === 0) throw new Error("deadline exceeded reading body");
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          total += buf.length;
          if (total > maxBytes) {
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(buf);
        }
      } finally {
        reader.releaseLock?.();
      }

      return {
        status: res.status,
        ok: res.ok,
        headers,
        body: Buffer.concat(chunks),
        finalUrl: v.href,
        latencyMs: Date.now() - started,
        redirected,
        bytesTruncated: truncated
      };
    }
    throw new HttpFailure(`too many redirects (>${maxRedirects})`, 310, FailureCode.HTTP_ERROR);
  }

  private guardHeaders(opts: HttpLayerOptions): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      if (/cookie|authorization|proxy-/i.test(k)) continue; // never auto-forward credentials
      out[k] = v;
    }
    return out;
  }

  /** POST JSON with the same guards as GET (no redirects). */
  async postJson(url: string, body: unknown, opts: HttpLayerOptions = {}): Promise<SafeResponse> {
    const started = Date.now();
    const v = this.validate(url, opts);
    await this.polite(v.hostname);
    const res = await undiciFetch(v.href, {
      method: "POST",
      dispatcher: this.agentFor(v.hostname) as unknown as Dispatcher,
      headers: { "user-agent": USER_AGENT, "content-type": "application/json", accept: "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs)
    });
    if (res.status >= 300 && res.status < 400) {
      res.body!.cancel().catch(() => {});
      throw new HttpFailure(`unexpected redirect on POST: ${res.status}`, res.status, FailureCode.HTTP_ERROR);
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((val, key) => {
      headers[key.toLowerCase()] = val;
    });
    const maxBytes = opts.maxBytes ?? this.defaultMaxBytes;
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += Buffer.from(value).length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new HttpFailure(`response too large: >${maxBytes} bytes`, res.status, FailureCode.INVALID_ARTIFACT);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return { status: res.status, ok: res.ok, headers, body: Buffer.concat(chunks), finalUrl: v.href, latencyMs: Date.now() - started, redirected: false, bytesTruncated: false };
  }

  /** GET returning a stream handle for large downloads (artifact acquisition). */
  async stream(url: string, opts: HttpLayerOptions = {}): Promise<SafeStreamResponse> {
    const v = this.validate(url, opts);
    await this.polite(v.hostname);
    const res = await undiciFetch(v.href, {
      method: "GET",
      dispatcher: this.agentFor(v.hostname) as unknown as Dispatcher,
      headers: { "user-agent": USER_AGENT, accept: "*/*", ...(opts.headers ?? {}) },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs)
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((val, key) => {
      headers[key.toLowerCase()] = val;
    });
    const reader = res.body!.getReader();
    const self = this;
    let cancelled = false;
    return {
      status: res.status,
      ok: res.ok,
      headers,
      finalUrl: v.href,
      cancel() {
        cancelled = true;
        reader.cancel().catch(() => {});
      },
      async readFully() {
        const maxBytes = opts.maxBytes ?? self.defaultMaxBytes;
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          if (cancelled) break;
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          total += buf.length;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new HttpFailure(`download exceeded cap ${maxBytes} bytes`, res.status, FailureCode.INVALID_ARTIFACT);
          }
          chunks.push(buf);
        }
        return Buffer.concat(chunks);
      },
      async pipeTo(write, maxBytes) {
        let total = 0;
        let truncated = false;
        while (true) {
          if (cancelled) break;
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          total += buf.length;
          if (total > maxBytes) {
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
          await write(buf);
        }
        return { bytes: total, truncated };
      }
    };
  }
}

export class HttpFailure extends Error {
  readonly status?: number;
  readonly code: FailureCode;
  constructor(message: string, status: number | undefined, code: FailureCode) {
    super(redactSecrets(message));
    this.name = "HttpFailure";
    this.status = status;
    this.code = code;
  }
  toFailure(subject?: string): Failure {
    return { code: this.code, message: this.message, httpStatus: this.status, subject, retryable: this.code === FailureCode.RATE_LIMIT || this.code === FailureCode.HTTP_ERROR };
  }
}

/** Map any thrown error from the HTTP layer into a classified Failure. */
export function failureFromHttpError(err: unknown, subject?: string): Failure {
  if (err instanceof HttpFailure) return err.toFailure(subject);
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof UrlBlockedError) {
    return { code: FailureCode.POLICY_VIOLATION, message: msg, subject, retryable: false };
  }
  if (/abort|timeout/i.test(msg)) {
    return { code: FailureCode.TIMEOUT, message: msg, subject, retryable: true };
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(msg)) {
    return { code: FailureCode.NETWORK_FAILURE, message: msg, subject, retryable: true };
  }
  return { code: FailureCode.NETWORK_FAILURE, message: msg, subject, retryable: true };
}

/** Convenience: GET JSON with parse + classification. */
export async function getJson<T>(http: HttpLayer, url: string, opts: HttpLayerOptions = {}): Promise<{ data: T; res: SafeResponse }> {
  const res = await http.get(url, opts);
  if (!res.ok) {
    throw new HttpFailure(`HTTP ${res.status} from ${url}`, res.status, res.status === 429 ? FailureCode.RATE_LIMIT : res.status === 404 || res.status === 410 ? FailureCode.INVALID_RESOURCE : res.status === 401 || res.status === 403 ? FailureCode.AUTH_REQUIRED : res.status >= 500 ? FailureCode.HTTP_ERROR : FailureCode.HTTP_ERROR);
  }
  try {
    return { data: JSON.parse(res.body.toString("utf8")) as T, res };
  } catch {
    throw new HttpFailure(`invalid JSON from ${url}`, res.status, FailureCode.PARSER_FAILURE);
  }
}

export { request };
