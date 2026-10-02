/**
 * Cache + idempotency (spec §32, §33). Deterministic cache keys from
 * resource fingerprint + capability + output requirements + version.
 * Never caches credentials; TTLs respect resource freshness classes.
 */
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { readFileJson, atomicWriteJson, sha256 } from "./security/paths.js";
import type { OutputRequirements, ResourceIdentity } from "./contracts.js";

export type FreshnessClass = "stable" | "normal" | "volatile";

const TTL_MS: Record<FreshnessClass, number> = {
  stable: 24 * 3600 * 1000, // e.g. canonical identity
  normal: 10 * 60 * 1000, // e.g. metadata
  volatile: 60 * 1000 // e.g. route health
};

export function cacheKey(identity: ResourceIdentity, capability: string, output?: OutputRequirements): string {
  const out = output ? JSON.stringify(sortDeep(output)) : "";
  return sha256(`${identity.fingerprint}|${capability}|${out}|v1`).slice(0, 40);
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, sortDeep(val)]));
  }
  return v;
}

interface CacheEntry<T> {
  key: string;
  createdAt: string;
  value: T;
}

export class Cache {
  private dir: string;
  private memory = new Map<string, CacheEntry<unknown>>();
  private enabled: boolean;

  constructor(stateDir: string, enabled = true) {
    this.dir = path.join(stateDir, "cache");
    this.enabled = enabled;
  }

  async get<T>(namespace: string, key: string, freshness: FreshnessClass = "normal"): Promise<T | undefined> {
    if (!this.enabled) return undefined;
    const memKey = `${namespace}:${key}`;
    const mem = this.memory.get(memKey);
    if (mem && !expired(mem, freshness)) return mem.value as T;
    const entry = await readFileJson<CacheEntry<T> | null>(this.filePath(namespace, key), null);
    if (!entry || expired(entry, freshness)) return undefined;
    this.memory.set(memKey, entry as CacheEntry<unknown>);
    return entry.value;
  }

  async put<T>(namespace: string, key: string, value: T): Promise<void> {
    if (!this.enabled) return;
    const entry: CacheEntry<T> = { key, createdAt: new Date().toISOString(), value };
    this.memory.set(`${namespace}:${key}`, entry as CacheEntry<unknown>);
    try {
      await atomicWriteJson(this.filePath(namespace, key), entry);
    } catch {
      /* cache writes are best-effort */
    }
  }

  private filePath(namespace: string, key: string): string {
    return path.join(this.dir, namespace.replace(/[^a-z0-9_-]/gi, "_"), `${key}.json`);
  }
}

function expired(entry: CacheEntry<unknown>, freshness: FreshnessClass): boolean {
  const age = Date.now() - new Date(entry.createdAt).getTime();
  return age > TTL_MS[freshness];
}

/** Idempotency registry: verified artifacts by deterministic key (spec §32). */
export interface ArtifactIndexEntry {
  artifactId: string;
  path: string;
  createdAt: string;
}

type IndexShape = Record<string, ArtifactIndexEntry[]>;

function normalizeIndex(raw: Record<string, unknown>): IndexShape {
  const out: IndexShape = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      const list = (v as ArtifactIndexEntry[]).filter(
        (e) => e && typeof e.artifactId === "string" && typeof e.path === "string"
      );
      if (list.length > 0) out[k] = list;
    } else if (v && typeof v === "object" && typeof (v as ArtifactIndexEntry).artifactId === "string") {
      // legacy single-entry shape written by UAAL <= 1.0.0
      out[k] = [v as ArtifactIndexEntry];
    }
  }
  return out;
}

export class ArtifactIndex {
  private file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "artifact-index.json");
  }

  /** All artifact entries recorded under `key` (a resource may yield many artifacts). */
  async find(key: string): Promise<ArtifactIndexEntry[]> {
    const idx = normalizeIndex(await readFileJson<Record<string, unknown>>(this.file, {}));
    return idx[key] ?? [];
  }

  async put(key: string, artifactId: string, artifactPath: string): Promise<void> {
    return this.putMany(key, [{ artifactId, path: artifactPath }]);
  }

  async putMany(key: string, entries: Array<{ artifactId: string; path: string }>): Promise<void> {
    const idx = normalizeIndex(await readFileJson<Record<string, unknown>>(this.file, {}));
    const existing = idx[key] ?? [];
    const known = new Set(existing.map((e) => e.artifactId));
    const merged = [...existing];
    for (const e of entries) {
      if (!known.has(e.artifactId)) merged.push({ ...e, createdAt: new Date().toISOString() });
    }
    idx[key] = merged;
    // bound the index (by most-recent entry per key)
    const keys = Object.keys(idx);
    if (keys.length > 5000) {
      keys.sort((a, b) => {
        const la = idx[a][idx[a].length - 1]?.createdAt ?? "";
        const lb = idx[b][idx[b].length - 1]?.createdAt ?? "";
        return la.localeCompare(lb);
      });
      for (const k of keys.slice(0, keys.length - 5000)) delete idx[k];
    }
    await atomicWriteJson(this.file, idx);
  }
}

export async function cacheDirExists(stateDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(stateDir, "cache"));
    return true;
  } catch {
    return false;
  }
}
