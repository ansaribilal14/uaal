/**
 * X PlatformAdapter — generalization of xthread-agent.
 *
 * Preserved: URL normalization + t.co expansion, multiple discovery paths,
 * candidate extraction, metadata decoding, relationship reconstruction,
 * media acquisition, manifest validation, fail-closed states. The platform
 * itself is never touched — only public delivery surfaces.
 */
import type {
  CapabilityDescriptor,
  DetectionResult,
  Evidence,
  NormalizedResource,
  PlatformAdapter,
  ResourceIdentity,
  ResourceRequest,
  RouteDiscoveryContext,
  AccessRoute,
  VerificationResult,
  Artifact
} from "../../core/contracts.js";
import { HttpLayer } from "../../core/http.js";
import { xIdentity, isTcoLink, expandTcoLink, parseStatusUrl } from "./identity.js";
import { xRoutes } from "./routes.js";
import { verifyNormalizedResource, verifyThreadChain } from "../../core/verify/index.js";
import { normalizeSingleStatus } from "./normalize.js";

export class XAdapter implements PlatformAdapter {
  readonly id = "x" as const;
  private http: HttpLayer;

  constructor(http: HttpLayer) {
    this.http = http;
  }

  detect(resource: string): DetectionResult {
    const id = xIdentity(resource);
    if (id) {
      return { matched: true, confidence: 0.99, platform: "x", resourceType: "thread", detail: id.id };
    }
    if (isTcoLink(resource)) {
      return { matched: true, confidence: 0.4, platform: "x", resourceType: "thread", detail: "t.co link (expansion pending)" };
    }
    return { matched: false, confidence: 0 };
  }

  capabilities(): CapabilityDescriptor[] {
    return [
      { name: "metadata", description: "Single status metadata via public mirror decoders.", engineLevel: false },
      { name: "thread", description: "Self-reply chain reconstruction from the replying_to_status relation.", engineLevel: false },
      { name: "reconstruct", description: "Chain reconstruction with unrelated-content exclusion.", engineLevel: false },
      { name: "author", description: "Author profile fields from decoded payloads.", engineLevel: false },
      { name: "media", description: "Photo/video inventory with best-mp4 selection.", engineLevel: false },
      { name: "acquire", description: "CDN-allowlisted media acquisition (+ thread manifest).", engineLevel: false },
      { name: "extract", description: "Raw decoded payloads in platformData.", engineLevel: false }
    ];
  }

  limitations(): string[] {
    return [
      "Public mirror decoders only; the platform's authenticated API is never used and paywalls/protected accounts are fail-closed (empty).",
      "Linear self-reply chains: branching takes the first-seen branch (documented limitation).",
      "HLS-only videos are reported as not downloadable instead of being re-encoded.",
      "Walker slots are third-party services and can be down; the chain degrades honestly to root-only."
    ];
  }

  async discoverRoutes(request: ResourceRequest, ctx: RouteDiscoveryContext): Promise<AccessRoute[]> {
    return xRoutes(this.http);
  }

  async resolveIdentity(resource: string): Promise<ResourceIdentity> {
    const direct = xIdentity(resource);
    if (direct) return direct;
    if (isTcoLink(resource)) {
      const expanded = await expandTcoLink(resource, (url, opts) =>
        this.http.get(url, { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes }).then((r) => ({ status: r.status, body: r.body, finalUrl: r.finalUrl }))
      );
      if (expanded) {
        const id = xIdentity(expanded.canonicalUrl);
        if (id) {
          return { ...id, aliases: [resource, ...id.aliases] };
        }
      }
    }
    throw new Error(`not an X status resource: ${resource.slice(0, 120)}`);
  }

  async normalize(evidence: Evidence[], request: ResourceRequest, identity: ResourceIdentity): Promise<NormalizedResource> {
    // Thread reconstruction evidence arrives pre-normalized by the route.
    const threadEvidence = [...evidence].reverse().find((e) => e.type === "thread.reconstruction");
    if (threadEvidence) {
      return threadEvidence.data as NormalizedResource;
    }
    return normalizeSingleStatus(evidence, identity);
  }

  async verify(resource: NormalizedResource, artifacts: Artifact[]): Promise<VerificationResult> {
    const isThread = resource.resource.type === "thread";
    const base = verifyNormalizedResource(resource, { capability: isThread ? "thread" : "metadata" });
    const chain = isThread ? verifyThreadChain(resource) : undefined;
    const checks = [...base.checks, ...(chain?.checks ?? [])];
    const idConsistency = parseStatusUrl(resource.resource.url);
    checks.unshift({
      name: "identity_consistency",
      passed: !idConsistency || idConsistency.statusId === resource.resource.id,
      detail: idConsistency && idConsistency.statusId !== resource.resource.id ? `requested ${idConsistency.statusId}, got ${resource.resource.id}` : undefined
    });
    return {
      verified: checks.every((c) => c.passed),
      checks,
      summary: checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail ?? "failed"}`).join("; ") || "all checks passed"
    };
  }
}
