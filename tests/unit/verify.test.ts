import { describe, it, expect, beforeAll } from "vitest";
import { verifyArtifactFile } from "../../src/core/verify/file.js";
import { sniffBuffer, checkMoovAtom, ffprobe } from "../../src/core/verify/media.js";
import { verifyNormalizedResource, verifyThreadChain } from "../../src/core/verify/index.js";
import type { NormalizedResource } from "../../src/core/contracts.js";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function makeFfmpegFixtures(dir: string): Promise<{ valid: string; truncated: string; audio: string }> {
  const ffmpeg = (await import("../../src/core/security/exec.js")).findBinary;
  const bin = (await ffmpeg("ffmpeg")) as string;
  if (!bin) throw new Error("ffmpeg not available");
  const valid = path.join(dir, "valid.mp4");
  const truncated = path.join(dir, "truncated.mp4");
  const audio = path.join(dir, "audio.m4a");
  execFileSync(bin, ["-f", "lavfi", "-i", "testsrc=duration=1:size=128x72:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-y", valid], { stdio: "ignore" });
  // tail-moov mp4 (no faststart): cutting the head off loses the moov atom (ytagent fixture pattern)
  const tailMoov = path.join(dir, "tail-moov.mp4");
  execFileSync(bin, ["-f", "lavfi", "-i", "testsrc=duration=2:size=128x72:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", tailMoov], { stdio: "ignore" });
  const buf = await fs.readFile(tailMoov);
  await fs.writeFile(truncated, buf.subarray(0, Math.floor(buf.length * 0.55)));
  execFileSync(bin, ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", "-y", audio], { stdio: "ignore" });
  return { valid, truncated, audio };
}

describe("file verification (spec §16)", () => {
  let dir: string;
  let fixtures: { valid: string; truncated: string; audio: string };
  let ffprobeBin: string | false;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "uaal-verify-"));
    try {
      fixtures = await makeFfmpegFixtures(dir);
    } catch {
      fixtures = { valid: "", truncated: "", audio: "" };
    }
    ffprobeBin = (await (await import("../../src/core/security/exec.js")).findBinary("ffprobe")) as string | false;
  });

  it("verifies a real mp4 (magic bytes, ffprobe, duration, streams, moov)", async () => {
    if (!fixtures.valid) return; // ffmpeg unavailable in env
    const res = await verifyArtifactFile(fixtures.valid, { expectedKind: "video", ffprobeBin, minBytes: 1024 });
    expect(res.verified).toBe(true);
    const names = res.checks.map((c) => c.name);
    expect(names).toContain("duration_valid");
    expect(names).toContain("streams_present");
    expect(names).toContain("moov_integrity");
  });

  it("rejects a truncated mp4 (moov integrity / probe failure)", async () => {
    if (!fixtures.truncated) return;
    const res = await verifyArtifactFile(fixtures.truncated, { expectedKind: "video", ffprobeBin, minBytes: 1024 });
    expect(res.verified).toBe(false);
  });

  it("accepts audio-only artifacts (audio salvage)", async () => {
    if (!fixtures.audio) return;
    const res = await verifyArtifactFile(fixtures.audio, { expectedKind: "audio", ffprobeBin, minBytes: 1024 });
    expect(res.verified).toBe(true);
  });

  it("rejects HTML masquerading as video", async () => {
    const htmlFile = path.join(dir, "fake.mp4");
    await fs.writeFile(htmlFile, "<!doctype html><html><body>not a video</body></html>");
    const res = await verifyArtifactFile(htmlFile, { expectedKind: "video", ffprobeBin: false, minBytes: 10 });
    expect(res.verified).toBe(false);
    expect(res.checks.find((c) => c.name === "not_html")?.passed).toBe(false);
  });

  it("rejects missing files and empty files", async () => {
    expect((await verifyArtifactFile(path.join(dir, "nope.mp4"))).verified).toBe(false);
    const empty = path.join(dir, "empty.mp4");
    await fs.writeFile(empty, Buffer.alloc(0));
    expect((await verifyArtifactFile(empty, { expectedKind: "video" })).verified).toBe(false);
  });

  it("detects size truncation against expected bytes", async () => {
    const f = path.join(dir, "sized.bin");
    await fs.writeFile(f, Buffer.alloc(1000));
    const res = await verifyArtifactFile(f, { expectedBytes: 2000, minBytes: 10 });
    expect(res.checks.find((c) => c.name === "size_complete")?.passed).toBe(false);
  });

  it("sniffs magic bytes", () => {
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(16)]);
    expect(sniffBuffer(mp4).container).toBe("mp4");
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
    expect(sniffBuffer(webm).container).toBe("matroska");
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffBuffer(jpg).mimeType).toBe("image/jpeg");
    expect(sniffBuffer(Buffer.from("<!DOCTYPE html>")).isHtml).toBe(true);
    expect(sniffBuffer(Buffer.from('{"a":1}')).container).toBe("json");
  });

  it("graceful degradation ladder: matroska accepted on magic bytes when ffprobe missing", async () => {
    const webm = path.join(dir, "fake.webm");
    await fs.writeFile(webm, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 7)]));
    const res = await verifyArtifactFile(webm, { expectedKind: "video", ffprobeBin: false });
    // magic says matroska; ffprobe unavailable → tolerance ladder applies
    expect(res.checks.find((c) => c.name === "container_valid")?.passed).toBe(true);
  });
});

describe("moov atom walk", () => {
  it("flags corrupt box chains", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uaal-moov-"));
    const f = path.join(dir, "bad.mp4");
    // box header declares size 0xFFFFFFFF but file is tiny
    const buf = Buffer.alloc(64);
    buf.writeUInt32BE(0xffffffff, 0);
    buf.write("free", 4);
    await fs.writeFile(f, buf);
    const res = await checkMoovAtom(f, 64);
    expect(res.ok).toBe(false);
    await fs.rm(dir, { recursive: true });
  });
});

function makeThreadResource(posts: Array<Record<string, unknown>>, relationships: Array<Record<string, unknown>>): NormalizedResource {
  return {
    schemaVersion: "1.0",
    platform: "x",
    resource: { id: "20", url: "https://x.com/i/web/status/20", type: "thread", platform: "x" },
    content: {},
    media: [],
    relationships: relationships as NormalizedResource["relationships"],
    platformData: { posts },
    evidence: [{ id: "e1", source: "r", type: "fxtweet", retrievedAt: new Date().toISOString() }],
    uncertainty: { confidence: 0.9, missing: [], notes: [] }
  };
}

describe("thread chain verification (spec §16)", () => {
  it("accepts a consistent chain", () => {
    const posts = [
      { id: "1", author: { handle: "jack" }, threadPosition: 0 },
      { id: "2", author: { handle: "jack" }, threadPosition: 1 },
      { id: "3", author: { handle: "jack" }, threadPosition: 2 }
    ];
    const rels = [
      { type: "self-reply", from: "2", to: "1" },
      { type: "self-reply", from: "3", to: "2" }
    ];
    expect(verifyThreadChain(makeThreadResource(posts, rels)).verified).toBe(true);
  });
  it("rejects broken chains (A → unrelated → X)", () => {
    const posts = [
      { id: "1", author: { handle: "jack" }, threadPosition: 0 },
      { id: "99", author: { handle: "recommendation" }, threadPosition: 1 }
    ];
    const rels = [{ type: "self-reply", from: "99", to: "1" }];
    const res = verifyThreadChain(makeThreadResource(posts, rels));
    expect(res.verified).toBe(false);
    expect(res.checks.find((c) => c.name === "thread.author_consistency")?.passed).toBe(false);
  });
  it("rejects non-consecutive ordering", () => {
    const posts = [
      { id: "1", author: { handle: "jack" }, threadPosition: 0 },
      { id: "2", author: { handle: "jack" }, threadPosition: 2 }
    ];
    const rels = [{ type: "self-reply", from: "2", to: "1" }];
    expect(verifyThreadChain(makeThreadResource(posts, rels)).verified).toBe(false);
  });
});

describe("normalized resource verification", () => {
  it("requires evidence provenance (Rule 13)", () => {
    const base: NormalizedResource = {
      schemaVersion: "1.0",
      platform: "youtube",
      resource: { id: "x", url: "https://www.youtube.com/watch?v=x", type: "video", platform: "youtube" },
      content: {},
      media: [],
      relationships: [],
      platformData: {},
      evidence: [],
      uncertainty: { confidence: 0.5, missing: [], notes: [] }
    };
    expect(verifyNormalizedResource(base).verified).toBe(false);
    base.evidence.push({ id: "e", source: "route", type: "t", retrievedAt: new Date().toISOString() });
    expect(verifyNormalizedResource(base).verified).toBe(true);
  });
  it("flags duplicate media urls", () => {
    const r: NormalizedResource = {
      schemaVersion: "1.0",
      platform: "x",
      resource: { id: "20", url: "https://x.com/i/web/status/20", type: "status", platform: "x" },
      content: {},
      media: [
        { kind: "photo", url: "https://pbs.twimg.com/x.jpg" },
        { kind: "photo", url: "https://pbs.twimg.com/x.jpg" }
      ],
      relationships: [],
      platformData: {},
      evidence: [{ id: "e", source: "r", type: "t", retrievedAt: new Date().toISOString() }],
      uncertainty: { confidence: 0.9, missing: [], notes: [] }
    };
    expect(verifyNormalizedResource(r).checks.find((c) => c.name === "media_dedupe")?.passed).toBe(false);
  });
});

void ffprobe;
