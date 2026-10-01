/**
 * File verification (spec §16, spec Rule 4: downloaded file ≠ verified
 * artifact). Layered, fail-fast, method-blind: the verifier sees only the
 * file, never the route that produced it (ytagent pattern).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { VerificationCheck, VerificationResult } from "../contracts.js";
import { sniffBuffer, ffprobe, checkMoovAtom } from "./media.js";

export interface FileVerifyOptions {
  /** Minimum acceptable size in bytes. Default 1024. */
  minBytes?: number;
  /** Expected size from Content-Length (truncation check). */
  expectedBytes?: number;
  /** Required artifact kind: video | audio | image | json | text | any. */
  expectedKind?: string;
  /** Environment binaries (ffprobe optional — graceful degradation ladder). */
  ffprobeBin?: string | false;
  /** Expected sha256 when the source declared one. */
  expectedChecksum?: string;
  /** Root the file must live inside (sandbox check). */
  sandboxRoot?: string;
}

export async function verifyArtifactFile(filePath: string, opts: FileVerifyOptions = {}): Promise<VerificationResult> {
  const started = Date.now();
  const checks: VerificationCheck[] = [];
  const add = (name: string, passed: boolean, detail?: string): void => {
    checks.push({ name, passed, detail });
  };

  // 1. Existence, regular file, inside sandbox
  let stat;
  try {
    stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) add("exists", false, "path is a symlink (rejected)");
  } catch {
    add("exists", false, "file does not exist");
  }
  if (!stat) {
    return finish(checks, started);
  }
  add("exists", stat.isFile(), stat.isFile() ? undefined : "not a regular file");
  if (opts.sandboxRoot) {
    const resolved = path.resolve(filePath);
    add("sandboxed", resolved.startsWith(path.resolve(opts.sandboxRoot)), resolved.startsWith(path.resolve(opts.sandboxRoot)) ? undefined : "path escapes sandbox root");
    if (!resolved.startsWith(path.resolve(opts.sandboxRoot))) return finish(checks, started);
  }

  // 2. Size bounds (small floors for text-ish kinds; media needs real bytes)
  const size = stat.size;
  const textish = ["json", "text", "document", "manifest", "metadata"].includes(opts.expectedKind ?? "");
  const min = opts.minBytes ?? (textish ? 16 : 1024);
  add("size_min", size >= min, size >= min ? `${size} bytes` : `too small: ${size} bytes (min ${min})`);
  if (opts.expectedBytes !== undefined) {
    add("size_complete", size === opts.expectedBytes, size === opts.expectedBytes ? `${size} bytes` : `truncated: got ${size}, expected ${opts.expectedBytes}`);
  }
  if (!stat.isFile() || size < Math.min(min, 64)) return finish(checks, started);

  // 3. Magic bytes / container sniffing
  const head = Buffer.alloc(512);
  const fh = await fs.open(filePath, "r");
  let headBuf: Buffer;
  try {
    await fh.read(head, 0, head.length, 0);
    headBuf = head;
  } finally {
    await fh.close();
  }
  const facts = sniffBuffer(headBuf);
  // HTML is only a failure for media kinds — for document/text snapshots it IS the payload
  const mediaExpected = ["video", "audio", "image"].includes(opts.expectedKind ?? "");
  if (mediaExpected || !opts.expectedKind) {
    add("not_html", !facts.isHtml, facts.isHtml ? "content is HTML, not media" : undefined);
  }

  if (opts.expectedKind && opts.expectedKind !== "any") {
    const kindOk = kindMatches(opts.expectedKind, facts);
    add("kind_matches", kindOk, kindOk ? `${facts.container ?? "unknown"}` : `expected ${opts.expectedKind}, got ${facts.container ?? "unrecognized"}`);
  }

  // 4. Checksum when declared
  if (opts.expectedChecksum) {
    const { sha256File } = await import("../security/paths.js");
    const actual = await sha256File(filePath);
    add("checksum", actual === opts.expectedChecksum, actual === opts.expectedChecksum ? actual : `expected ${opts.expectedChecksum}, got ${actual}`);
  }

  // 5. ffprobe + graceful degradation ladder (media kinds only)
  const isMediaKind = ["video", "audio"].includes(opts.expectedKind ?? "") || (facts.mimeType?.startsWith("video/") ?? false) || (facts.mimeType?.startsWith("audio/") ?? false);
  if (isMediaKind) {
    const probe = await ffprobe(filePath, opts.ffprobeBin ?? false);
    if (probe.ok) {
      add("container_valid", true, probe.container);
      add("duration_valid", (probe.durationSec ?? 0) > 0, `${probe.durationSec ?? 0}s`);
      add("streams_present", !!(probe.hasVideo || probe.hasAudio), `video=${probe.videoCodec ?? "none"} audio=${probe.audioCodec ?? "none"}`);
      if (facts.container === "mp4") {
        const moov = await checkMoovAtom(filePath, size);
        add("moov_integrity", moov.ok, moov.reason ?? "moov readable");
      }
    } else {
      // Degradation ladder: accept strong-but-weaker evidence only where safe
      const tolerant = ["matroska", "mp3", "ogg", "wav", "flv", "jpeg", "png", "gif", "webp"].includes(facts.container ?? "");
      add("container_valid", tolerant, tolerant ? `accepted on magic bytes (ffprobe unavailable)` : `ffprobe required for ${facts.container ?? "unknown"} container: ${probe.error}`);
      add("duration_valid", tolerant, tolerant ? "skipped (ffprobe unavailable)" : "skipped");
      add("streams_present", tolerant, tolerant ? "skipped (ffprobe unavailable)" : "skipped");
    }
  } else if (facts.container === "json") {
    try {
      JSON.parse((await fs.readFile(filePath, "utf8")).slice(0, 5 * 1024 * 1024));
      add("json_valid", true);
    } catch (e) {
      add("json_valid", false, (e as Error).message.slice(0, 120));
    }
  } else if (opts.expectedKind === "text" || facts.mimeType?.startsWith("text/")) {
    add("text_readable", true);
  }

  return finish(checks, started);
}

function kindMatches(kind: string, facts: ReturnType<typeof sniffBuffer>): boolean {
  const mime = facts.mimeType ?? "";
  switch (kind) {
    case "video":
      return mime.startsWith("video/") || (mime === "application/ogg" && true) || facts.container === "mp4" || facts.container === "matroska";
    case "audio":
      return mime.startsWith("audio/") || facts.container === "mp3" || facts.container === "ogg";
    case "image":
      return mime.startsWith("image/");
    case "json":
      return mime === "application/json";
    case "text":
    case "document":
      return mime.startsWith("text/") || mime === "application/xhtml+xml";
    case "archive":
      return mime === "application/zip";
    default:
      return facts.mimeType !== null;
  }
}

function finish(checks: VerificationCheck[], started: number): VerificationResult {
  return {
    verified: checks.length > 0 && checks.every((c) => c.passed),
    checks,
    summary: checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail ?? "failed"}`).join("; ") || "all checks passed",
    durationMs: Date.now() - started
  };
}
