/**
 * UAAL failure taxonomy (spec §10) and error model.
 *
 * Every failure carries a stable machine-readable code so callers can make
 * decisions without parsing messages. Failure codes influence route selection.
 */

export enum FailureCode {
  NETWORK_FAILURE = "NETWORK_FAILURE",
  TIMEOUT = "TIMEOUT",
  HTTP_ERROR = "HTTP_ERROR",
  AUTH_REQUIRED = "AUTH_REQUIRED",
  RATE_LIMIT = "RATE_LIMIT",
  BLOCKED = "BLOCKED",
  INVALID_RESOURCE = "INVALID_RESOURCE",
  PARSER_FAILURE = "PARSER_FAILURE",
  EMPTY_RESULT = "EMPTY_RESULT",
  PARTIAL_RESULT = "PARTIAL_RESULT",
  INVALID_ARTIFACT = "INVALID_ARTIFACT",
  VERIFICATION_FAILURE = "VERIFICATION_FAILURE",
  UNSUPPORTED_CAPABILITY = "UNSUPPORTED_CAPABILITY",
  ENVIRONMENT_INCOMPATIBLE = "ENVIRONMENT_INCOMPATIBLE",
  DEPENDENCY_FAILURE = "DEPENDENCY_FAILURE",
  POLICY_VIOLATION = "POLICY_VIOLATION",
  CANCELLED = "CANCELLED",
  INTERNAL_ERROR = "INTERNAL_ERROR"
}

/** Failure classes that mean "this route is probably fine, the environment is not". */
export const ENVIRONMENTAL_FAILURES: ReadonlySet<FailureCode> = new Set([
  FailureCode.ENVIRONMENT_INCOMPATIBLE,
  FailureCode.DEPENDENCY_FAILURE
]);

/** Failure classes that indicate the platform refuses access (honest wall). */
export const ACCESS_WALL_FAILURES: ReadonlySet<FailureCode> = new Set([
  FailureCode.AUTH_REQUIRED,
  FailureCode.BLOCKED
]);

export function failureCodeFromString(s: string): FailureCode | undefined {
  const v = Object.values(FailureCode) as string[];
  return v.includes(s) ? (s as FailureCode) : undefined;
}

export interface Failure {
  code: FailureCode;
  message: string;
  /** HTTP status when the failure came from an HTTP response. */
  httpStatus?: number;
  /** Route/operator subject the failure applies to (route id, url, candidate id). */
  subject?: string;
  /** Whether retrying this same route soon could plausibly succeed. */
  retryable: boolean;
  /** Underlying error detail (redacted). */
  cause?: string;
}

export class UAALError extends Error {
  readonly failure: Failure;
  constructor(failure: Failure) {
    super(failure.message);
    this.name = "UAALError";
    this.failure = failure;
  }
}

export interface ClassifiedError {
  code: FailureCode;
  message: string;
  httpStatus?: number;
  retryable: boolean;
}

/**
 * Deterministic failure classification. This is the single place where raw
 * errors and HTTP statuses become semantic failure codes (spec §10).
 */
export function classifyFailure(err: unknown, subject?: string): ClassifiedError {
  if (err instanceof UAALError) {
    return { code: err.failure.code, message: err.failure.message, httpStatus: err.failure.httpStatus, retryable: err.failure.retryable };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";

  if (/cancel{1,2}led by caller/i.test(msg)) {
    return { code: FailureCode.CANCELLED, message: msg, retryable: false };
  }
  if (isAbortLike(err, name, msg)) {
    return { code: FailureCode.TIMEOUT, message: msg, retryable: true };
  }
  if (/fetch failed|network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE/i.test(msg)) {
    return { code: FailureCode.NETWORK_FAILURE, message: msg, retryable: true };
  }
  const status = extractHttpStatus(err, msg);
  if (status !== undefined) {
    return classifyHttpStatus(status, msg, subject);
  }
  if (/JSON|parse|unexpected token|unexpected end of/i.test(msg)) {
    return { code: FailureCode.PARSER_FAILURE, message: msg, retryable: true };
  }
  if (/certificate|TLS|SSL|self-signed/i.test(msg)) {
    return { code: FailureCode.NETWORK_FAILURE, message: msg, retryable: false };
  }
  if (/SSRF|blocked (host|ip|port)|private address|link-local|loopback/i.test(msg)) {
    return { code: FailureCode.POLICY_VIOLATION, message: msg, retryable: false };
  }
  return { code: FailureCode.INTERNAL_ERROR, message: msg, retryable: true };
}

export function classifyHttpStatus(status: number, msg: string, subject?: string): ClassifiedError {
  const base = { httpStatus: status, message: msg || `HTTP ${status}` };
  if (status === 429) return { ...base, code: FailureCode.RATE_LIMIT, retryable: true };
  if (status === 401 || status === 403 || status === 407) return { ...base, code: FailureCode.AUTH_REQUIRED, retryable: false };
  if (status === 451) return { ...base, code: FailureCode.BLOCKED, retryable: false };
  if (status === 404 || status === 410) return { ...base, code: FailureCode.INVALID_RESOURCE, retryable: false };
  if (status >= 500) return { ...base, code: FailureCode.HTTP_ERROR, retryable: true };
  if (status >= 400) return { ...base, code: FailureCode.HTTP_ERROR, retryable: false };
  return { ...base, code: FailureCode.HTTP_ERROR, retryable: true };
}

function isAbortLike(err: unknown, name: string, msg: string): boolean {
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    (err instanceof Error && err.constructor?.name === "DOMException" && /abort|timeout/i.test(msg)) ||
    /timed? ?out|deadline exceeded|ETIMEDOUT/i.test(msg)
  );
}

function extractHttpStatus(err: unknown, msg: string): number | undefined {
  if (err && typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.status === "number" && anyErr.status >= 400 && anyErr.status <= 599) return anyErr.status;
    if (typeof anyErr.statusCode === "number") return anyErr.statusCode;
    const resp = anyErr.response as Record<string, unknown> | undefined;
    if (resp && typeof resp.status === "number") return resp.status;
  }
  const m = /(?:HTTP|status)[ =:](\d{3})/i.exec(msg) ?? /(?<![\d:.])(4\d\d|5\d\d)(?![\d:])/.exec(msg);
  if (m) {
    const n = Number(m[1]);
    if (n >= 400 && n <= 599) return n;
  }
  return undefined;
}

/** Aggregate per-route failure codes into the strict top-level status (spec §39). */
export type UAALStatus = "ok" | "partial" | "empty" | "failed" | "unsupported" | "requires_auth" | "blocked";

export function aggregateStatus(
  hadViableRoute: boolean,
  results: Array<{ code: FailureCode }>,
  verifiedSomething: boolean
): UAALStatus {
  if (results.length === 0) return hadViableRoute ? "failed" : "unsupported";
  const codes = results.map((r) => r.code);
  const all = (pred: (c: FailureCode) => boolean) => codes.every(pred);
  if (all((c) => c === FailureCode.AUTH_REQUIRED)) return "requires_auth";
  if (all((c) => c === FailureCode.BLOCKED || c === FailureCode.RATE_LIMIT)) return "blocked";
  if (all((c) => c === FailureCode.UNSUPPORTED_CAPABILITY || c === FailureCode.ENVIRONMENT_INCOMPATIBLE || c === FailureCode.DEPENDENCY_FAILURE)) {
    return "unsupported";
  }
  if (all((c) => c === FailureCode.INVALID_RESOURCE || c === FailureCode.EMPTY_RESULT)) return "empty";
  if (verifiedSomething) return "partial";
  return "failed";
}
