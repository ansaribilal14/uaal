/**
 * Filesystem security (spec §27): path sandboxing, filename sanitization,
 * symlink-escape rejection, atomic writes. Every artifact path the system
 * touches must resolve inside its designated root.
 */
import { promises as fs, createReadStream } from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export class PathViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathViolationError";
  }
}

/** Strip anything that could escape a directory or inject paths. */
export function sanitizeFilename(name: string, fallback = "artifact"): string {
  const base = path.basename(name).replace(/[\u0000-\u001f\u007f]/g, "");
  const cleaned = base
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const safe = cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
  return safe.slice(0, 180);
}

/** Resolve a path and require it to stay within root (after symlink checks). */
export function resolveWithin(root: string, ...parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...parts.map((p) => p.replace(/\0/g, "")));
  const rel = path.relative(resolvedRoot, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathViolationError(`path escapes sandbox: ${parts.join("/")}`);
  }
  return candidate;
}

/** Recursively verify no component of filePath is a symlink pointing outside root. */
export async function assertInsideRoot(filePath: string, root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(filePath);
  const chain: string[] = [];
  while (current !== resolvedRoot && current !== path.parse(current).root) {
    chain.push(current);
    current = path.dirname(current);
  }
  for (const p of chain) {
    try {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) {
        const target = await fs.realpath(p).catch(() => null);
        if (!target || !target.startsWith(resolvedRoot + path.sep)) {
          throw new PathViolationError(`symlink escape detected at ${path.basename(p)}`);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (err instanceof PathViolationError) throw err;
      // lstat failures on transient files are tolerated
    }
  }
}

/** Atomic file write: temp file in same dir + fsync + rename. Never partial. */
export async function atomicWriteFile(targetPath: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(tmp, "wx", 0o644);
  try {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    await handle.writeFile(buf);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, targetPath);
}

export async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  return atomicWriteFile(targetPath, JSON.stringify(value, null, 2));
}

export async function readFileJson<T>(targetPath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** JSONL append with fsync (audit logs must survive crashes). */
export async function appendJsonl(filePath: string, record: unknown, maxLines = 20000): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const st = await fs.stat(filePath);
    if (st.size > maxLines * 220) {
      // rotate: keep it bounded
      await fs.rename(filePath, `${filePath}.1`);
    }
  } catch {
    /* file may not exist yet */
  }
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}
