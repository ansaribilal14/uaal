/**
 * Media signature detection — magic bytes, MIME sniffing, container facts.
 * Deterministic; no external dependency beyond optional ffprobe.
 */

export interface MediaFacts {
  container: string | null;
  mimeType: string | null;
  isHtml: boolean;
  magic: string | null;
}

const MAGIC_RULES: Array<{ magic: string | ((b: Buffer) => boolean); container: string; mime: string }> = [
  { magic: (b) => b.length >= 12 && b.subarray(4, 8).toString("ascii") === "ftyp" && b.subarray(8, 12).toString("ascii").startsWith("M4A"), container: "m4a", mime: "audio/mp4" },
  { magic: (b) => b.length >= 12 && b.subarray(4, 8).toString("ascii") === "ftyp", container: "mp4", mime: "video/mp4" },
  { magic: (b) => b.subarray(0, 4).toString("hex") === "1a45dfa3", container: "matroska", mime: "video/webm" },
  { magic: (b) => b.subarray(0, 3).toString("ascii") === "ID3" || (b[0] === 0xff && b[1] !== undefined && (b[1] & 0xe0) === 0xe0), container: "mp3", mime: "audio/mpeg" },
  { magic: (b) => b.subarray(0, 4).toString("ascii") === "OggS", container: "ogg", mime: "application/ogg" },
  { magic: (b) => b.subarray(0, 4).toString("ascii") === "RIFF", container: "riff", mime: "video/x-msvideo" },
  { magic: (b) => b.subarray(0, 4).toString("ascii") === "FLV\x01", container: "flv", mime: "video/x-flv" },
  { magic: (b) => b.subarray(0, 2).toString("hex") === "ffd8", container: "jpeg", mime: "image/jpeg" },
  { magic: (b) => b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", container: "png", mime: "image/png" },
  { magic: (b) => b.subarray(0, 6).toString("ascii").startsWith("GIF8"), container: "gif", mime: "image/gif" },
  { magic: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP", container: "webp", mime: "image/webp" },
  { magic: (b) => b.subarray(0, 2).toString("hex") === "425a", container: "bzip2", mime: "application/x-bzip2" },
  { magic: (b) => b.subarray(0, 2).toString("hex") === "504b", container: "zip", mime: "application/zip" }
];

const HTML_PREFIXES = ["<!doctype html", "<html", "<!html", "<?xml", "<rss", "<feed"];

export function sniffBuffer(head: Buffer): MediaFacts {
  const lower = head.subarray(0, 256).toString("utf8").toLowerCase();
  const isHtml = HTML_PREFIXES.some((p) => lower.startsWith(p));
  for (const rule of MAGIC_RULES) {
    const hit = typeof rule.magic === "function" ? rule.magic(head) : head.subarray(0, rule.magic.length).toString("hex") === Buffer.from(rule.magic).toString("hex");
    if (hit) {
      // RIFF could be AVI or WAV or WEBP
      if (rule.container === "riff") {
        const four = head.subarray(8, 12).toString("ascii");
        if (four === "AVI ") return { container: "avi", mimeType: "video/x-msvideo", isHtml, magic: "riff" };
        if (four === "WAVE") return { container: "wav", mimeType: "audio/wav", isHtml, magic: "riff" };
        if (four === "WEBP") return { container: "webp", mimeType: "image/webp", isHtml, magic: "riff" };
      }
      return { container: rule.container, mimeType: rule.mime, isHtml, magic: rule.container };
    }
  }
  if (isHtml) return { container: "html", mimeType: "text/html", isHtml: true, magic: null };
  // JSON / text detection
  const trimmed = head.toString("utf8").trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return { container: "json", mimeType: "application/json", isHtml: false, magic: null };
  }
  return { container: null, mimeType: null, isHtml, magic: null };
}

export function extensionForMime(mime: string | null): string {
  const map: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/x-msvideo": ".avi",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "application/ogg": ".ogg",
    "video/x-flv": ".flv",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/json": ".json",
    "text/html": ".html",
    "text/plain": ".txt"
  };
  return (mime && map[mime]) || ".bin";
}

/* ------------------------------ ffprobe ------------------------------ */

export interface ProbeResult {
  ok: boolean;
  durationSec?: number;
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  hasVideo?: boolean;
  hasAudio?: boolean;
  error?: string;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string };
  streams?: Array<{ codec_type?: string; codec_name?: string; duration?: string; width?: number; height?: number }>;
}

/** Runs ffprobe; returns structured facts or ok=false. Never raises. */
export async function ffprobe(filePath: string, ffprobeBin: string | false, timeoutMs = 15_000): Promise<ProbeResult> {
  if (!ffprobeBin) return { ok: false, error: "ffprobe unavailable" };
  const { safeExec } = await import("../security/exec.js");
  const res = await safeExec({
    cmd: ffprobeBin,
    args: ["-v", "error", "-show_format", "-show_streams", "-print_format", "json", filePath],
    timeoutMs
  });
  if (res.code !== 0 || !res.stdout.trim()) {
    return { ok: false, error: `ffprobe failed: ${(res.stderr || "no output").slice(0, 200)}` };
  }
  try {
    const parsed = JSON.parse(res.stdout) as FfprobeOutput;
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === "video");
    const audio = streams.find((s) => s.codec_type === "audio");
    const durations = streams.map((s) => Number(s.duration)).filter((n) => Number.isFinite(n) && n > 0);
    const fmtDur = Number(parsed.format?.duration);
    const durationSec = Number.isFinite(fmtDur) && fmtDur > 0 ? fmtDur : durations.length > 0 ? Math.max(...durations) : undefined;
    return {
      ok: true,
      durationSec,
      container: parsed.format?.format_name,
      videoCodec: video?.codec_name,
      audioCodec: audio?.codec_name,
      width: video?.width,
      height: video?.height,
      hasVideo: !!video,
      hasAudio: !!audio
    };
  } catch {
    return { ok: false, error: "ffprobe returned invalid JSON" };
  }
}

/**
 * MP4 moov atom sanity walk (ytagent pattern): detect truncation that leaves
 * the moov atom unreadable. Reads top-level boxes only.
 */
export async function checkMoovAtom(filePath: string, fileSize: number): Promise<{ ok: boolean; reason?: string }> {
  const { open } = await import("node:fs/promises");
  const handle = await open(filePath, "r").catch(() => null);
  if (!handle) return { ok: false, reason: "cannot open file" };
  try {
    let offset = 0;
    const header = Buffer.alloc(8);
    while (offset < fileSize) {
      const { bytesRead } = await handle.read(header, 0, 8, offset);
      if (bytesRead < 8) return { ok: true }; // tail smaller than a box header; ffprobe verdict governs
      const size = header.readUInt32BE(0);
      const type = header.subarray(4, 8).toString("ascii");
      if (size === 1) {
        const ext = Buffer.alloc(8);
        await handle.read(ext, 0, 8, offset + 8);
        const big = ext.readBigUInt64BE(0);
        if (big < 8n) return { ok: false, reason: "invalid extended box size" };
        if (type === "moov") return { ok: true };
        offset += Number(big);
      } else if (size === 0) {
        return { ok: true }; // box extends to EOF
      } else if (size < 8) {
        return { ok: false, reason: `corrupt box size ${size} at offset ${offset}` };
      } else {
        if (type === "moov") return { ok: size >= 16 };
        offset += size;
      }
      if (offset > fileSize + 1024) return { ok: false, reason: "box chain exceeds file size" };
    }
    return { ok: true }; // moov not encountered (legal tail layout) — ffprobe governs
  } catch {
    return { ok: true };
  } finally {
    await handle.close();
  }
}
