/**
 * Access policy layer (spec §28, §65). The system distinguishes public,
 * authorized, auth-required, unsupported and blocked access — and never
 * claims to defeat authentication. Authorized routes run only when the
 * caller explicitly supplies credentials via policy/credentials or env.
 */
import type { AccessPolicy, AccessRoute, ResourceRequest } from "./contracts.js";
import { FailureCode, type Failure } from "./errors.js";

export const DEFAULT_POLICY: Required<Pick<AccessPolicy, "maxAccessLevel" | "polite" | "maxRouteAttempts">> = {
  maxAccessLevel: "public",
  polite: true,
  maxRouteAttempts: 8
};

export function effectivePolicy(request: ResourceRequest): Required<AccessPolicy> {
  const p = request.policy ?? {};
  return {
    maxAccessLevel: p.maxAccessLevel ?? DEFAULT_POLICY.maxAccessLevel,
    allowedRouteTags: p.allowedRouteTags ?? [],
    deniedRouteTags: p.deniedRouteTags ?? [],
    maxRouteAttempts: p.maxRouteAttempts ?? DEFAULT_POLICY.maxRouteAttempts,
    attemptTimeoutMs: p.attemptTimeoutMs ?? 0,
    polite: p.polite ?? DEFAULT_POLICY.polite,
    credentials: p.credentials ?? credentialsFromEnv(),
    ...p
  } as Required<AccessPolicy>;
}

/** Credentials come ONLY from the environment or explicit policy — never hardcoded (spec §58). */
export function credentialsFromEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("UAAL_CREDENTIAL_") && value) {
      out[key.replace("UAAL_CREDENTIAL_", "").toLowerCase()] = value;
    }
  }
  return out;
}

export interface PolicyDecision {
  eligible: boolean;
  reason: string;
}

/** Decide whether a route may run under the effective policy. */
export function evaluateRoutePolicy(route: AccessRoute, policy: Required<AccessPolicy>): PolicyDecision {
  const level = route.accessLevel ?? "public";
  if (level === "authorized" && policy.maxAccessLevel !== "authorized") {
    return { eligible: false, reason: "policy: route requires authorized access; caller policy allows public only" };
  }
  if (level === "authorized") {
    const missing = (route.requirements.credentials ?? []).filter((c) => !policy.credentials?.[c]);
    if (missing.length > 0) {
      return { eligible: false, reason: `policy: missing credentials: ${missing.join(", ")}` };
    }
  }
  if (policy.allowedRouteTags.length > 0 && !route.tags.some((t) => policy.allowedRouteTags.includes(t))) {
    return { eligible: false, reason: "policy: route tags not in allowedRouteTags" };
  }
  if (route.tags.some((t) => policy.deniedRouteTags.includes(t))) {
    return { eligible: false, reason: "policy: route tag denied" };
  }
  return { eligible: true, reason: "policy: allowed" };
}

/** The failure a caller should see when a platform demands auth we do not have. */
export function authRequiredFailure(subject: string): Failure {
  return {
    code: FailureCode.AUTH_REQUIRED,
    message: "resource requires authentication; provide authorized credentials via policy (never hardcoded)",
    subject,
    retryable: false
  };
}
