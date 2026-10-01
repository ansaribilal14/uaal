/**
 * Capability registry (spec §7). Not every platform supports every
 * capability; adapters declare what they support. Engine-level capabilities
 * are satisfied by the core itself.
 */
import { CAPABILITIES, type Capability, type CapabilityDescriptor } from "./contracts.js";

const REGISTRY: Record<Capability, CapabilityDescriptor> = {
  resolve: { name: "resolve", description: "Canonical resource identity (URL canonicalization, platform detection).", engineLevel: true },
  inspect: { name: "inspect", description: "Lightweight availability report without heavy acquisition.", engineLevel: true },
  metadata: { name: "metadata", description: "Descriptive metadata for the resource.", engineLevel: false },
  extract: { name: "extract", description: "Raw platform extraction with platformData populated.", engineLevel: false },
  reconstruct: { name: "reconstruct", description: "Structural reconstruction (thread chains, relationships).", engineLevel: false },
  media: { name: "media", description: "Media inventory with URLs/variants, no downloads.", engineLevel: false },
  acquire: { name: "acquire", description: "Produce verified downloadable artifacts.", engineLevel: false },
  thread: { name: "thread", description: "Ordered post chain for threaded resources.", engineLevel: false },
  comments: { name: "comments", description: "Comment tree for the resource.", engineLevel: false },
  author: { name: "author", description: "Author profile information.", engineLevel: false },
  media_metadata: { name: "media_metadata", description: "Per-media technical details.", engineLevel: false },
  artifact: { name: "artifact", description: "Explicit artifact production with delivery metadata.", engineLevel: false },
  verify: { name: "verify", description: "Verify an existing artifact or result (engine-level).", engineLevel: true }
};

export function capabilityRegistry(): CapabilityDescriptor[] {
  return Object.values(REGISTRY);
}

export function isCapability(name: string): name is Capability {
  return (CAPABILITIES as readonly string[]).includes(name);
}

/** Capabilities that imply artifact production. */
export const ARTIFACT_CAPABILITIES: ReadonlySet<Capability> = new Set(["acquire", "artifact", "media"]);

/** Verify a platform's declared capabilities are well-formed. */
export function assertValidCapabilities(platform: string, caps: Capability[]): void {
  for (const c of caps) {
    if (!isCapability(c)) {
      throw new Error(`adapter ${platform} declared unknown capability: ${c}`);
    }
  }
}
