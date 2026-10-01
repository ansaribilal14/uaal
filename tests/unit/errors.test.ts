import { describe, it, expect } from "vitest";
import { classifyFailure, classifyHttpStatus, aggregateStatus, FailureCode, UAALError } from "../../src/core/errors.js";
import { HttpFailure } from "../../src/core/http.js";

describe("failure classification", () => {
  it("maps abort/timeout errors", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(classifyFailure(err).code).toBe(FailureCode.TIMEOUT);
    expect(classifyFailure(new Error("deadline exceeded")).code).toBe(FailureCode.TIMEOUT);
    expect(classifyFailure(new Error("operation was cancelled by caller")).code).toBe(FailureCode.CANCELLED);
  });
  it("maps network errors", () => {
    expect(classifyFailure(new TypeError("fetch failed")).code).toBe(FailureCode.NETWORK_FAILURE);
    expect(classifyFailure(new Error("connect ECONNREFUSED 1.2.3.4:443")).code).toBe(FailureCode.NETWORK_FAILURE);
  });
  it("maps http statuses", () => {
    expect(classifyHttpStatus(429, "").code).toBe(FailureCode.RATE_LIMIT);
    expect(classifyHttpStatus(401, "").code).toBe(FailureCode.AUTH_REQUIRED);
    expect(classifyHttpStatus(403, "").code).toBe(FailureCode.AUTH_REQUIRED);
    expect(classifyHttpStatus(451, "").code).toBe(FailureCode.BLOCKED);
    expect(classifyHttpStatus(404, "").code).toBe(FailureCode.INVALID_RESOURCE);
    expect(classifyHttpStatus(503, "").code).toBe(FailureCode.HTTP_ERROR);
    expect(classifyHttpStatus(503, "").retryable).toBe(true);
    expect(classifyHttpStatus(400, "").retryable).toBe(false);
  });
  it("extracts status from HttpFailure and error objects", () => {
    expect(classifyFailure(new HttpFailure("HTTP 429", 429, FailureCode.RATE_LIMIT)).code).toBe(FailureCode.RATE_LIMIT);
    expect(classifyFailure(Object.assign(new Error("boom"), { status: 403 })).code).toBe(FailureCode.AUTH_REQUIRED);
    expect(classifyFailure(new Error("request failed with HTTP 502")).httpStatus).toBe(502);
  });
  it("maps parse errors", () => {
    expect(classifyFailure(new SyntaxError("Unexpected token < in JSON")).code).toBe(FailureCode.PARSER_FAILURE);
  });
  it("UAALError round-trips its failure", () => {
    const err = new UAALError({ code: FailureCode.ENVIRONMENT_INCOMPATIBLE, message: "missing binary", subject: "r", retryable: false });
    expect(classifyFailure(err).code).toBe(FailureCode.ENVIRONMENT_INCOMPATIBLE);
  });
});

describe("status aggregation (spec §39)", () => {
  it("all auth failures → requires_auth", () => {
    expect(aggregateStatus(true, [{ code: FailureCode.AUTH_REQUIRED }], false)).toBe("requires_auth");
  });
  it("rate limit + blocked → blocked", () => {
    expect(aggregateStatus(true, [{ code: FailureCode.RATE_LIMIT }, { code: FailureCode.BLOCKED }], false)).toBe("blocked");
  });
  it("environment failures → unsupported", () => {
    expect(aggregateStatus(true, [{ code: FailureCode.ENVIRONMENT_INCOMPATIBLE }, { code: FailureCode.DEPENDENCY_FAILURE }], false)).toBe("unsupported");
  });
  it("resource unavailable everywhere → empty", () => {
    expect(aggregateStatus(true, [{ code: FailureCode.INVALID_RESOURCE }, { code: FailureCode.EMPTY_RESULT }], false)).toBe("empty");
  });
  it("mixed with partial evidence → partial", () => {
    expect(aggregateStatus(true, [{ code: FailureCode.TIMEOUT }, { code: FailureCode.VERIFICATION_FAILURE }], true)).toBe("partial");
  });
  it("mixed hard failures → failed", () => {
    expect(aggregateStatus(true, [{ code: FailureCode.TIMEOUT }, { code: FailureCode.PARSER_FAILURE }], false)).toBe("failed");
  });
  it("no routes → unsupported", () => {
    expect(aggregateStatus(false, [], false)).toBe("unsupported");
  });
});
