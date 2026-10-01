/**
 * Remote-worker protocol (spec §30): workers authenticate to the coordinator
 * with HMAC-SHA256 signed bodies (X-UAAL-Signature: t=<unixMs>,v1=<hex hmac>)
 * — a timestamp window prevents replay. Workers are untrusted until a shared
 * secret validates; results carry checksums and are re-verified on intake.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Capability, RemoteJobPayload, RemoteJobResult, ResourceRequest } from "../core/contracts.js";
import { assertLoopbackUrl, assertPublicUrl } from "../core/security/urlguard.js";

const REPLAY_WINDOW_MS = 5 * 60_000;

export function signPayload(payload: Omit<RemoteJobPayload, "signature">, secret: string): string {
  const body = JSON.stringify(payload);
  const ts = Date.now().toString();
  const mac = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${mac}`;
}

export function verifySignature(payload: RemoteJobPayload, secret: string, maxAgeMs = REPLAY_WINDOW_MS): boolean {
  if (!payload.signature) return false;
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(payload.signature);
  if (!m) return false;
  const ts = Number(m[1]);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > maxAgeMs) return false;
  const body = JSON.stringify({ ...payload, signature: undefined });
  const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(m[2], "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Payload the coordinator sends to a worker. */
export function makeJobPayload(args: { jobId: string; request: ResourceRequest; capability: Capability }): Omit<RemoteJobPayload, "signature"> {
  return {
    jobId: args.jobId,
    operation: args.capability === "acquire" || args.capability === "artifact" ? "acquire" : args.capability === "verify" ? "verify" : args.capability === "inspect" ? "inspect" : "resolve",
    resource: args.request.resource,
    capability: args.capability,
    constraints: {
      output: args.request.output,
      environment: args.request.environment,
      policy: args.request.policy,
      platform: args.request.platform
    },
    issuedAt: new Date().toISOString()
  };
}

/** Coordinator URL validation: public https by default; loopback allowed for tests. */
export function validateCoordinatorUrl(url: string, allowLoopback = false): { href: string } {
  if (allowLoopback) {
    const v = assertLoopbackUrl(url);
    return { href: v.href };
  }
  return { href: assertPublicUrl(url).href };
}

export type { RemoteJobPayload, RemoteJobResult };
