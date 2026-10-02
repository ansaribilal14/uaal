/**
 * YouTube PlatformAdapter — generalization of ytagent.
 *
 * Methodology preserved: multiple independent access methods, verifier-gated
 * success, machine-readable output, honest failure statuses. NOT a wrapper:
 * the routes are native AccessRoute implementations under the universal
 * contract.
 */
import type {
  CapabilityDescriptor,
  DetectionResult,
  EnvironmentProfile,
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
import { normalizeYouTubeResource } from "./normalize.js";
import { youtubeIdentity } from "./identity.js";
import { youtubeRoutes } from "./routes.js";
import { verifyNormalizedResource } from "../../core/verify/index.js";
import type { HttpLayer } from "../../core/http.js";
import { resolveCobaltUrl } from "./mirror-routes.js";
import type { UAALConfig } from "../../core/contracts.js";

export class YouTubeAdapter implements PlatformAdapter {
  readonly id = "youtube" as const;
  private http: HttpLayer;
  private config: UAALConfig;

  constructor(http: HttpLayer, config: UAALConfig = {}) {
    this.http = http;
    this.config = config;
  }

  detect(resource: string): DetectionResult {
    const id = youtubeIdentity(resource);
    if (id) {
      return { matched: true, confidence: 0.99, platform: "youtube", resourceType: "video", detail: id.id };
    }
    return { matched: false, confidence: 0 };
  }

  capabilities(): CapabilityDescriptor[] {
    return [
      { name: "metadata", description: "Title, channel, duration, views, publish date.", engineLevel: false },
      { name: "author", description: "Channel name/url.", engineLevel: false },
      { name: "media", description: "Stream/thumbnail inventory.", engineLevel: false },
      { name: "media_metadata", description: "Per-stream technical facts where exposed.", engineLevel: false },
      { name: "acquire", description: "Verified video/audio artifacts via yt-dlp.", engineLevel: false },
      { name: "artifact", description: "Artifact production with verification.", engineLevel: false },
      { name: "extract", description: "Raw platform payload in platformData.", engineLevel: false },
      { name: "inspect", description: "Reachability probe.", engineLevel: false }
    ];
  }

  limitations(): string[] {
    return [
      "Media acquisition works out of the box via public mirrors (invidious/piped); yt-dlp unlocks higher quality and audio-only when installed.",
      "YouTube aggressively throttles datacenter IPs; sign-in walls are reported as requires_auth, never bypassed.",
      "Stream URLs from public API surfaces expire quickly; acquire downloads immediately after route selection.",
      "The cobalt sidecar route only activates when an operator configures a sidecar URL (adapters.youtube.cobaltUrl or UAAL_COBALT_URL)."
    ];
  }

  async discoverRoutes(request: ResourceRequest, ctx: RouteDiscoveryContext): Promise<AccessRoute[]> {
    const cobaltUrl = resolveCobaltUrl(this.config);
    return youtubeRoutes(this.http, cobaltUrl);
  }

  async resolveIdentity(resource: string): Promise<ResourceIdentity> {
    const id = youtubeIdentity(resource);
    if (!id) {
      return makeIdentityFallback(resource);
    }
    return id;
  }

  async normalize(evidence: Evidence[], request: ResourceRequest, identity: ResourceIdentity): Promise<NormalizedResource> {
    return normalizeYouTubeResource(evidence, identity);
  }

  async verify(resource: NormalizedResource, artifacts: Artifact[]): Promise<VerificationResult> {
    const res = verifyNormalizedResource(resource, { capability: "metadata" });
    // identifier consistency: resolved id must match requested id (spec §16)
    const requested = youtubeIdentity(resource.resource.url);
    const idCheck = {
      name: "identity_consistency",
      passed: !requested || requested.id === resource.resource.id,
      detail: requested && requested.id !== resource.resource.id ? `requested ${requested.id}, got ${resource.resource.id}` : undefined
    };
    return { ...res, checks: [idCheck, ...res.checks], verified: idCheck.passed && res.verified };
  }
}

function makeIdentityFallback(resource: string): ResourceIdentity {
  return {
    platform: "youtube",
    type: "video",
    id: resource,
    canonicalUrl: resource,
    aliases: [resource],
    fingerprint: `yt-${Buffer.from(resource).toString("hex").slice(0, 24)}`
  };
}
