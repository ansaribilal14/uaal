/**
 * Platform detection + resource identity (spec §6, §56). Different URLs
 * representing the same resource must resolve to the same canonical identity
 * — used for dedup, cache keys, artifact association and history.
 */
import { createHash } from "node:crypto";
import type { PlatformAdapter, PlatformId, ResourceIdentity, ResourceRequest } from "./contracts.js";
import { FailureCode, UAALError } from "./errors.js";

export class PlatformRegistry {
  private adapters: PlatformAdapter[] = [];

  register(adapter: PlatformAdapter): void {
    if (this.adapters.some((a) => a.id === adapter.id)) {
      throw new Error(`adapter already registered: ${adapter.id}`);
    }
    this.adapters.push(adapter);
  }

  get(id: PlatformId): PlatformAdapter | undefined {
    return this.adapters.find((a) => a.id === id);
  }

  all(): PlatformAdapter[] {
    return [...this.adapters];
  }

  /** Detect the platform for a raw resource string. Returns best match. */
  detect(resource: string): { adapter?: PlatformAdapter; matched: PlatformAdapter[] } {
    const matched: PlatformAdapter[] = [];
    for (const adapter of this.adapters) {
      const d = adapter.detect(resource);
      if (d.matched) matched.push(adapter);
    }
    // Detection order: specific adapters win by registration order; generic-web last.
    const specific = matched.filter((a) => a.id !== "generic-web");
    const best = specific[0] ?? matched[0];
    return { adapter: best, matched };
  }
}

export function fingerprintIdentity(platform: PlatformId, type: string, id: string, extra?: string): string {
  return createHash("sha256").update(`${platform}|${type}|${id}${extra ? `|${extra}` : ""}`).digest("hex").slice(0, 32);
}

export function makeIdentity(platform: PlatformId, type: string, id: string, canonicalUrl: string, aliases: string[], relatedIds?: string[]): ResourceIdentity {
  return {
    platform,
    type,
    id,
    canonicalUrl,
    aliases,
    relatedIds,
    fingerprint: fingerprintIdentity(platform, type, id)
  };
}

/** Resolve the identity for a request: adapter-local resolution, else detection. */
export async function resolveIdentity(
  registry: PlatformRegistry,
  request: ResourceRequest
): Promise<{ identity: ResourceIdentity; adapter: PlatformAdapter | undefined }> {
  let adapter = request.platform ? registry.get(request.platform) : undefined;
  if (!adapter) {
    const det = registry.detect(request.resource);
    adapter = det.adapter;
  }
  if (!adapter) {
    throw new UAALError({
      code: FailureCode.UNSUPPORTED_CAPABILITY,
      message: `no adapter can handle resource: ${request.resource.slice(0, 200)}`,
      retryable: false
    });
  }
  let identity: ResourceIdentity;
  if (adapter.resolveIdentity) {
    identity = await adapter.resolveIdentity(request.resource);
  } else {
    const d = adapter.detect(request.resource);
    if (!d.matched || !d.platform || !d.resourceType) {
      throw new UAALError({
        code: FailureCode.INVALID_RESOURCE,
        message: `adapter ${adapter.id} cannot parse resource: ${request.resource.slice(0, 200)}`,
        retryable: false
      });
    }
    identity = makeIdentity(d.platform, d.resourceType, d.detail ?? request.resource, request.resource, [request.resource]);
  }
  return { identity, adapter };
}
