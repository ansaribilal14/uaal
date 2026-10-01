import { describe, it, expect } from "vitest";
import { validateUrl, assertPublicUrl, isPrivateAddress, UrlBlockedError, assertLoopbackUrl } from "../../src/core/security/urlguard.js";
import { sanitizeFilename, resolveWithin, PathViolationError, atomicWriteFile, atomicWriteJson, sha256 } from "../../src/core/security/paths.js";
import { findBinary } from "../../src/core/security/exec.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactSecrets, redactValue } from "../../src/core/observability.js";

describe("SSRF url guard", () => {
  it("accepts public https urls", () => {
    expect(assertPublicUrl("https://example.com/x").hostname).toBe("example.com");
  });
  it("rejects non-https schemes", () => {
    expect(() => assertPublicUrl("http://example.com")).toThrow(UrlBlockedError);
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(UrlBlockedError);
    expect(() => assertPublicUrl("ftp://example.com")).toThrow(UrlBlockedError);
    expect(() => assertPublicUrl("gopher://x")).toThrow(UrlBlockedError);
  });
  it("rejects literal private addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0"]) {
      expect(() => assertPublicUrl(`https://${ip}/x`)).toThrow(UrlBlockedError);
    }
    expect(() => assertPublicUrl("https://[::1]/x")).toThrow(UrlBlockedError);
    expect(() => assertPublicUrl("https://[fe80::1]/x")).toThrow(UrlBlockedError);
    expect(() => assertPublicUrl("https://[fd00::1]/x")).toThrow(UrlBlockedError);
  });
  it("rejects metadata hostnames and nonstandard ports", () => {
    expect(() => assertPublicUrl("https://metadata.google.internal/computeMetadata")).toThrow(UrlBlockedError);
    expect(() => assertPublicUrl("https://example.com:8080/x")).toThrow(UrlBlockedError);
    expect(() => assertPublicUrl("https://user:pass@example.com/x")).toThrow(UrlBlockedError);
  });
  it("supports host allowlists", () => {
    expect(() => assertPublicUrl("https://evil.com/x", { allowedHostSuffixes: ["example.com"] })).toThrow(UrlBlockedError);
    expect(() => assertPublicUrl("https://sub.example.com/x", { allowedHostSuffixes: ["example.com"] })).not.toThrow();
  });
  it("isPrivateAddress classification", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("100.64.0.5")).toBe(true); // CGNAT
    expect(isPrivateAddress("198.18.0.1")).toBe(true);
    expect(isPrivateAddress("224.0.0.1")).toBe(true);
    expect(isPrivateAddress("not-an-ip")).toBe(true); // fail closed
  });
  it("loopback validation allows localhost http for tests", () => {
    expect(assertLoopbackUrl("http://127.0.0.1:9999/x").port).toBe(9999);
    expect(() => assertLoopbackUrl("http://example.com")).toThrow(UrlBlockedError);
  });
  it("validateUrl rejects malformed input", () => {
    expect(() => validateUrl("not a url at all %%%")).toThrow(UrlBlockedError);
  });
});

describe("path sandbox", () => {
  it("sanitizeFilename neutralizes traversal and control chars", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\windows\\system32")).not.toMatch(/[\\/]/);
    expect(sanitizeFilename("a\0b")).not.toContain("\0");
    expect(sanitizeFilename("")).toBe("artifact");
    expect(sanitizeFilename(".")).toBe("artifact");
    expect(sanitizeFilename("..")).toBe("artifact");
    expect(sanitizeFilename("con/../../../x.html")).toBe("x.html");
  });
  it("resolveWithin blocks escapes", () => {
    const root = "/tmp/uaal-test-root";
    expect(resolveWithin(root, "a", "b.txt")).toBe(path.resolve(root, "a/b.txt"));
    expect(() => resolveWithin(root, "..", "escape.txt")).toThrow(PathViolationError);
    expect(() => resolveWithin(root, "a/../../escape")).toThrow(PathViolationError);
  });
  it("atomic writes produce complete files or nothing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uaal-atomic-"));
    const target = path.join(dir, "data.json");
    await atomicWriteJson(target, { hello: "world" });
    const parsed = JSON.parse(await fs.readFile(target, "utf8"));
    expect(parsed.hello).toBe("world");
    // no leftover temp files
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp"));
    expect(leftovers.length).toBe(0);
    await fs.rm(dir, { recursive: true });
  });
  it("sha256 is deterministic", () => {
    expect(sha256("uaal")).toBe(sha256("uaal"));
    expect(sha256("uaal")).toHaveLength(64);
  });
});

describe("subprocess safety", () => {
  it("finds real binaries and rejects missing ones", async () => {
    expect(await findBinary("sh")).toBeTruthy();
    expect(await findBinary("definitely-not-a-binary-uaal")).toBe(false);
  });
  it("uses argv arrays (no shell interpolation)", async () => {
    const { safeExec } = await import("../../src/core/security/exec.js");
    // A classic injection: if a shell were used, `echo pwned` would execute.
    const res = await safeExec({ cmd: "echo", args: ["$([ -d /proc ] && echo pwned)"], timeoutMs: 5000 });
    expect(res.stdout.trim()).toBe("$([ -d /proc ] && echo pwned)");
  });
  it("enforces hard timeouts with process-group kill", async () => {
    const { safeExec } = await import("../../src/core/security/exec.js");
    const res = await safeExec({ cmd: "sleep", args: ["30"], timeoutMs: 800 });
    expect(res.timedOut).toBe(true);
    expect(res.durationMs).toBeLessThan(5000);
  });
  it("caps stdout capture (memory exhaustion defense)", async () => {
    const { safeExec } = await import("../../src/core/security/exec.js");
    const res = await safeExec({ cmd: "head", args: ["-c", "10000000", "/dev/zero"], timeoutMs: 10_000, maxStdoutBytes: 4096 });
    expect(res.stdout.length).toBeLessThanOrEqual(4096);
  });
  it("propagates cancellation", async () => {
    const { safeExec } = await import("../../src/core/security/exec.js");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const res = await safeExec({ cmd: "sleep", args: ["30"], signal: controller.signal, timeoutMs: 30_000 });
    expect(res.killed).toBe(true);
    expect(res.durationMs).toBeLessThan(5000);
  });
  it("minimal env allowlist", async () => {
    const { safeExec } = await import("../../src/core/security/exec.js");
    const res = await safeExec({ cmd: "node", args: ["-e", "console.log(JSON.stringify(Object.keys(process.env).length))"] });
    expect(Number(res.stdout.trim())).toBeLessThan(15);
    expect(res.stdout).not.toContain("UAAL_WORKER_SECRET");
  });
});

describe("secret redaction", () => {
  it("redacts github tokens, bearers, jwt-ish strings, url creds", () => {
    const s = redactSecrets("token ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 and Bearer abc.def.ghi and eyJhbGciOiJIUzI1NiJ9.eyJxIn0.abc and https://user:pass@host/x");
    expect(s).not.toContain("ghp_");
    expect(s).toContain("[REDACTED]");
  });
  it("redacts sensitive keys in objects", () => {
    const out = redactValue({ authorization: "Bearer x", token: "t", nested: { apiKey: "k" }, safe: "ok" }) as Record<string, unknown>;
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect(out.safe).toBe("ok");
  });
});
