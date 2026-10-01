/**
 * Verification engine (spec §16, §68): composable verifiers for structured
 * resources and artifacts. HTTP success is never verification (Rule 3).
 */
import type {
  Artifact,
  Capability,
  NormalizedResource,
  VerificationCheck,
  VerificationResult,
  Verifier
} from "../contracts.js";
import { verifyArtifactFile } from "./file.js";

/* ------------------------ structured verification ------------------------ */

export function verifyNormalizedResource(
  resource: NormalizedResource,
  expected: { capability: Capability; requireEvidence?: boolean } = { capability: "metadata" }
): VerificationResult {
  const checks: VerificationCheck[] = [];
  const add = (name: string, passed: boolean, detail?: string): void => {
    checks.push({ name, passed, detail });
  };

  // Schema: required common fields (spec §15: common fields must remain stable)
  add("schema.identity", !!resource.platform && !!resource.resource?.id && !!resource.resource?.url && !!resource.resource?.type, resource.resource ? `${resource.platform}/${resource.resource.type}` : "missing resource block");
  add("schema.version", resource.schemaVersion === "1.0", resource.schemaVersion);
  add("schema.content", typeof resource.content === "object" && resource.content !== null);

  // URL validity
  try {
    const u = new URL(resource.resource.url);
    add("url_valid", u.protocol === "https:" || u.protocol === "http:", u.href);
  } catch {
    add("url_valid", false, resource.resource?.url ?? "missing");
  }

  // Evidence present + provenance (Rule 13)
  if (expected.requireEvidence !== false) {
    add("evidence_present", resource.evidence.length > 0, `${resource.evidence.length} evidence items`);
    add("evidence_provenance", resource.evidence.every((e) => !!e.source && !!e.type), undefined);
  }

  // Capability-specific checks
  if (expected.capability === "thread") {
    const chainOk = verifyThreadChain(resource);
    checks.push(...chainOk.checks);
  }
  if (expected.capability === "media" || expected.capability === "acquire" || expected.capability === "artifact") {
    add("media_present", resource.media.length > 0, `${resource.media.length} media items`);
  }
  if (expected.capability === "author") {
    add("author_present", !!resource.author && Object.keys(resource.author).length > 0);
  }

  // Duplicate detection (spec §16)
  if (resource.media.length > 0) {
    const urls = resource.media.map((m) => m.url).filter(Boolean) as string[];
    add("media_dedupe", new Set(urls).size === urls.length, new Set(urls).size === urls.length ? undefined : "duplicate media urls detected");
  }

  return {
    verified: checks.every((c) => c.passed),
    checks,
    summary: checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail ?? "failed"}`).join("; ") || "all checks passed"
  };
}

/**
 * Thread chain integrity (spec §16): chain consistency, author consistency,
 * position ordering, unrelated-content exclusion. Reconstructed chains must
 * be exactly A→B→C, never A→recommendation→X (xthread-agent pattern).
 */
export function verifyThreadChain(resource: NormalizedResource): VerificationResult {
  const checks: VerificationCheck[] = [];
  const add = (name: string, passed: boolean, detail?: string): void => {
    checks.push({ name, passed, detail });
  };

  const posts = (resource.platformData.posts as Array<Record<string, unknown>> | undefined) ?? [];
  const relationships = resource.relationships.filter((r) => r.type === "reply" || r.type === "self-reply" || r.type === "chain");

  add("thread.posts_present", posts.length > 0, `${posts.length} posts`);

  if (posts.length > 1) {
    // Ordering: positions strictly increasing, unique
    const positions = posts.map((p) => Number(p.threadPosition ?? -1));
    add("thread.ordering", positions.every((p, i) => i === 0 || p === positions[i - 1] + 1), positions.join(","));

    // Author consistency: single-author self-chain
    const handles = posts.map((p) => String((p.author as Record<string, unknown> | undefined)?.handle ?? "").toLowerCase());
    const rootHandle = handles[0];
    add("thread.author_consistency", handles.every((h) => h === rootHandle), [...new Set(handles)].join(","));

    // Relationship integrity: each consecutive pair connected
    const ids = posts.map((p) => String(p.id));
    let chainConnected = true;
    for (let i = 1; i < ids.length; i++) {
      const rel = relationships.find((r) => r.from === ids[i] && r.to === ids[i - 1]);
      if (!rel) {
        chainConnected = false;
        break;
      }
    }
    add("thread.chain_integrity", chainConnected, chainConnected ? `chain of ${ids.length}` : `gap between posts`);
  }

  return {
    verified: checks.every((c) => c.passed),
    checks,
    summary: checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail ?? "failed"}`).join("; ") || "thread chain consistent"
  };
}

/* --------------------------- artifact verification --------------------------- */

/** Verifies every artifact; method-blind, provenance-annotated. */
export async function verifyArtifacts(artifacts: Artifact[], opts: { ffprobeBin?: string | false; sandboxRoot?: string } = {}): Promise<VerificationResult> {
  const started = Date.now();
  const checks: VerificationCheck[] = [];
  for (const a of artifacts) {
    const res = await verifyArtifactFile(a.path, {
      expectedKind: a.type,
      expectedBytes: a.size > 0 ? a.size : undefined,
      ffprobeBin: opts.ffprobeBin,
      sandboxRoot: opts.sandboxRoot
    });
    for (const c of res.checks) checks.push({ ...c, artifactId: a.artifactId });
  }
  return {
    verified: artifacts.length > 0 && checks.every((c) => c.passed),
    checks,
    summary: checks.filter((c) => !c.passed).map((c) => `${c.artifactId}:${c.name}`).join("; ") || `${artifacts.length} artifacts verified`,
    durationMs: Date.now() - started
  };
}

/* --------------------------- verifier registry --------------------------- */

export function defaultVerifiers(): Record<string, Verifier<unknown>> {
  return {
    resource: {
      verify: (value, context) =>
        Promise.resolve(verifyNormalizedResource(value as NormalizedResource, { capability: context.capability ?? "metadata" }))
    },
    artifact: {
      verify: async (value) => verifyArtifacts(Array.isArray(value) ? (value as Artifact[]) : [value as Artifact])
    }
  } as Record<string, Verifier<unknown>>;
}
