/**
 * Artifact system (spec §17, §19): unified artifact abstraction with atomic
 * promotion. Routes write into per-route temp sandboxes; only artifacts that
 * pass verification are promoted to the store — a partially written file is
 * NEVER visible as a completed artifact.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Artifact, ArtifactType, RawArtifactRef } from "../contracts.js";
import { sanitizeFilename, sha256File, atomicWriteJson, readFileJson, resolveWithin } from "../security/paths.js";
import { extensionForMime, sniffBuffer } from "../verify/media.js";
import { verifyArtifactFile } from "../verify/file.js";

export interface ArtifactStoreConfig {
  artifactsDir: string;
  ffprobeBin?: string | false;
}

export interface PromotionResult {
  artifact: Artifact;
  verification: { verified: boolean; failures: string[] };
}

export class ArtifactStore {
  private dir: string;
  private ffprobeBin: string | false;
  private registryFile: string;
  private registry: Record<string, Artifact> = {};

  constructor(cfg: ArtifactStoreConfig) {
    this.dir = cfg.artifactsDir;
    this.ffprobeBin = cfg.ffprobeBin ?? false;
    this.registryFile = path.join(this.dir, "registry.json");
  }

  get root(): string {
    return this.dir;
  }

  /** Late-bind ffprobe availability (engine detects after construction). */
  setFfprobe(bin: string | false): void {
    this.ffprobeBin = bin;
  }

  async load(): Promise<void> {
    const loaded = await readFileJson<{ artifacts?: Record<string, Artifact> }>(this.registryFile, {});
    this.registry = loaded.artifacts ?? {};
  }

  async persist(): Promise<void> {
    await atomicWriteJson(this.registryFile, { version: 1, artifacts: this.registry });
  }

  /** Per-route temp sandbox directory (never the public store). */
  async tempDirFor(routeId: string, identityFingerprint: string): Promise<string> {
    const dir = resolveWithin(this.dir, ".tmp", sanitizeFilename(identityFingerprint), sanitizeFilename(routeId));
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async cleanupTemp(identityFingerprint: string): Promise<void> {
    const tmpRoot = path.join(this.dir, ".tmp", sanitizeFilename(identityFingerprint));
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Promote a raw artifact into the store after verification (ytagent
   * verifier gate). Failing artifacts are deleted, never registered.
   */
  async promote(
    ref: RawArtifactRef,
    meta: { resourceId: string; sourceRoute: string; expectedBytes?: number }
  ): Promise<PromotionResult> {
    // ensure the temp file still exists and is inside the temp sandbox
    const stat = await fs.stat(ref.path).catch(() => null);
    if (!stat || !stat.isFile()) {
      return { artifact: null as unknown as Artifact, verification: { verified: false, failures: ["temp file missing"] } };
    }

    const head = Buffer.alloc(512);
    const fh = await fs.open(ref.path, "r");
    try {
      await fh.read(head, 0, 512, 0);
    } finally {
      await fh.close();
    }
    const facts = sniffBuffer(head);
    const mime = ref.mimeType ?? facts.mimeType ?? "application/octet-stream";
    const ext = path.extname(ref.filename ?? "") || extensionForMime(mime);
    const type = normalizeArtifactType(ref.kind, mime);
    const artifactId = `art_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const filename = `${artifactId}${ext}`;

    const verification = await verifyArtifactFile(ref.path, {
      expectedKind: type === "json" ? "json" : type,
      expectedBytes: meta.expectedBytes,
      ffprobeBin: this.ffprobeBin,
      sandboxRoot: path.join(this.dir, ".tmp"),
      minBytes: ["json", "text", "manifest", "metadata"].includes(type) ? 2 : type === "document" ? 16 : 1024
    });

    if (!verification.verified) {
      await fs.rm(ref.path, { force: true }).catch(() => {});
      return { artifact: null as unknown as Artifact, verification: { verified: false, failures: [verification.summary ?? "verification failed"] } };
    }

    const destPath = resolveWithin(this.dir, artifactId + ext);
    await fs.rename(ref.path, destPath); // atomic within same filesystem
    const checksum = await sha256File(destPath);
    const finalStat = await fs.stat(destPath);

    const artifact: Artifact = {
      artifactId,
      resourceId: meta.resourceId,
      type,
      path: destPath,
      size: finalStat.size,
      checksum,
      mimeType: mime,
      createdAt: new Date().toISOString(),
      verificationStatus: "verified",
      sourceRoute: meta.sourceRoute,
      filename
    };

    // enrich with media facts when ffprobe available
    if (type === "video" || type === "audio") {
      const { ffprobe } = await import("../verify/media.js");
      const probe = await ffprobe(destPath, this.ffprobeBin);
      if (probe.ok) {
        artifact.media = {
          container: probe.container,
          durationSec: probe.durationSec,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          width: probe.width,
          height: probe.height
        };
      }
    }

    this.registry[artifactId] = artifact;
    await this.persist();
    return { artifact, verification: { verified: true, failures: [] } };
  }

  get(artifactId: string): Artifact | undefined {
    return this.registry[artifactId];
  }

  list(): Artifact[] {
    return Object.values(this.registry);
  }

  /** Delivery descriptor (spec §19): never assume the caller sees our fs. */
  delivery(artifact: Artifact): Record<string, unknown> {
    return {
      artifactId: artifact.artifactId,
      type: artifact.type,
      mimeType: artifact.mimeType,
      size: artifact.size,
      checksum: `sha256:${artifact.checksum}`,
      filename: artifact.filename,
      localPath: artifact.path,
      delivery: "local-path",
      verificationStatus: artifact.verificationStatus
    };
  }
}

function normalizeArtifactType(kind: string, mime: string): ArtifactType {
  if (kind && kind !== "any") return kind;
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/json") return "json";
  if (mime === "text/html") return "document";
  if (mime.startsWith("text/")) return "text";
  return "document";
}

/** Registers externally created artifacts (e.g. manifest json). */
export async function registerTextArtifact(
  store: ArtifactStore,
  meta: { resourceId: string; sourceRoute: string; kind: ArtifactType; filename: string; content: string; mimeType?: string }
): Promise<Artifact | null> {
  const tmp = await store.tempDirFor("manifest", meta.resourceId);
  const safe = sanitizeFilename(meta.filename);
  const tmpPath = path.join(tmp, safe);
  const { atomicWriteFile } = await import("../security/paths.js");
  await atomicWriteFile(tmpPath, meta.content);
  const { artifact } = await store.promote(
    { path: tmpPath, kind: meta.kind, filename: safe, mimeType: meta.mimeType },
    { resourceId: meta.resourceId, sourceRoute: meta.sourceRoute }
  );
  return artifact ?? null;
}
