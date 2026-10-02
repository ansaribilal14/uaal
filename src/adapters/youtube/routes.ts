/**
 * YouTube routes — generalization of ytagent's 13-method chain into
 * independent AccessRoute implementations.
 *
 * Probe: watch-page reachability preflight (rate limit / login wall / dead).
 * Metadata: oEmbed (public, stable), InnerTube player API (rich), yt-dlp
 *           (--dump-single-json), Piped public instances (mirror).
 * Media: yt-dlp subprocess with independent client profiles (android_vr,
 *        ios, audio-only) — structurally different failure modes.
 *
 * Every route returns a RouteResult and never raises (ytagent boundary).
 */
import type {
  AccessRoute,
  Evidence,
  ExecutionContext,
  ProbeResult,
  RawArtifactRef,
  ResourceRequest,
  RouteResult
} from "../../core/contracts.js";
import { classifyFailure, FailureCode, type Failure } from "../../core/errors.js";
import { getJson, HttpFailure, type HttpLayer } from "../../core/http.js";
import { canonicalWatchUrl } from "./identity.js";
import { youtubeInvidiousAcquireRoute, youtubePipedAcquireRoute, youtubeCobaltAcquireRoute } from "./mirror-routes.js";

const ROUTE_TIMEOUT = 30_000;

/* ------------------------------ shared helpers ------------------------------ */

function fail(routeId: string, failure: Failure, started: number, unavailable = false): RouteResult {
  return { ok: false, routeId, evidence: [], artifacts: [], failure, unavailable, latencyMs: Date.now() - started };
}

function toFailure(err: unknown, routeId: string): Failure {
  if (err instanceof HttpFailure) return err.toFailure(routeId);
  const c = classifyFailure(err, routeId);
  return { code: c.code, message: c.message, httpStatus: c.httpStatus, subject: routeId, retryable: c.retryable };
}

/* ------------------------------ probe route ------------------------------ */

export function youtubeProbeRoute(http: HttpLayer): AccessRoute {
  const id = "youtube.probe.watch";
  return {
    id,
    platform: "youtube",
    capabilities: ["inspect"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 100,
    enabled: true,
    accessLevel: "public",
    tags: ["scrape"],
    description:
      "Preflight reachability probe against the public watch page (zero media bytes). Detects rate limits, sign-in walls and dead videos early so heavier routes can be skipped or warned.",
    estimatedCostMs: 3000,
    async probe(): Promise<ProbeResult> {
      return { viable: true, confidence: 0.5, reason: "probe route" };
    },
    async execute(request: ResourceRequest, ctx: ExecutionContext): Promise<RouteResult> {
      const started = Date.now();
      const videoId = ctx.identity.id;
      try {
        const res = await http.get(canonicalWatchUrl(videoId), { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
        const body = res.body.toString("utf8");
        if (res.status === 429) {
          return fail(id, { code: FailureCode.RATE_LIMIT, message: "watch page rate limited; IP is throttled", subject: id, retryable: true }, started);
        }
        if (/sign in to confirm you|LOGIN_REQUIRED/i.test(body)) {
          return fail(id, { code: FailureCode.AUTH_REQUIRED, message: "watch page demands sign-in from this environment", subject: id, retryable: false }, started);
        }
        if (/Video unavailable|"status":"ERROR"/.test(body)) {
          return fail(id, { code: FailureCode.INVALID_RESOURCE, message: "video unavailable per watch page", subject: id, retryable: false }, started, true);
        }
        const reachable = body.includes("playerResponse") || body.includes("videoDetails") || body.includes("ytplayer");
        const evidence: Evidence = {
          id: `ev_${ctx.hash(`${videoId}:probe`)}`,
          source: id,
          type: "watch.page.probe",
          data: { reachable, httpStatus: res.status },
          retrievedAt: new Date().toISOString(),
          reliability: 0.3,
          provenance: { endpoint: "watch" }
        };
        return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
      } catch (err) {
        return fail(id, toFailure(err, id), started);
      }
    }
  };
}

/* ------------------------------ oEmbed route ------------------------------ */

interface OEmbedResponse {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
}

export function youtubeOembedRoute(http: HttpLayer): AccessRoute {
  const id = "youtube.oembed.metadata";
  return {
    id,
    platform: "youtube",
    capabilities: ["metadata", "author", "inspect"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 90,
    enabled: true,
    accessLevel: "public",
    tags: ["official"],
    description:
      "YouTube public oEmbed endpoint. Stable official metadata (title, channel, thumbnail). 401/404 means the video is genuinely unavailable — an informative filter signal, not a retry case.",
    estimatedCostMs: 1500,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const videoId = ctx.identity.id;
      const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalWatchUrl(videoId))}&format=json`;
      try {
        const { data, res } = await getJson<OEmbedResponse>(http, url, { timeoutMs: ROUTE_TIMEOUT, maxBytes: 256 * 1024 });
        const evidence: Evidence = {
          id: `ev_${ctx.hash(`${videoId}:oembed`)}`,
          source: id,
          type: "oembed",
          data: { ...data, videoId },
          retrievedAt: new Date().toISOString(),
          reliability: 0.9,
          provenance: { endpoint: "youtube.oembed", status: res.status }
        };
        return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
      } catch (err) {
        if (err instanceof HttpFailure && (err.status === 401 || err.status === 404)) {
          return fail(id, { code: FailureCode.INVALID_RESOURCE, message: "video unavailable per oEmbed (401/404)", subject: id, retryable: false }, started, true);
        }
        return fail(id, toFailure(err, id), started);
      }
    }
  };
}

/* ---------------------------- InnerTube route ---------------------------- */

interface InnerTubePlayer {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: {
    videoId?: string;
    title?: string;
    lengthSeconds?: string;
    viewCount?: string;
    author?: string;
    channelId?: string;
    shortDescription?: string;
    thumbnail?: { thumbnails?: Array<{ url: string; width: number; height: number }> };
    isLiveContent?: boolean;
  };
  microformat?: { playerMicroformatRenderer?: { publishDate?: string; uploadDate?: string; viewCount?: string; description?: { simpleText?: string }; familySafe?: boolean; category?: string } };
  streamingData?: { formats?: Array<Record<string, unknown>> };
}

const INNERTUBE_CLIENTS = [
  { name: "ANDROID_VR", clientName: "ANDROID_VR", clientVersion: "1.60.19", key: "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_JYM39w", ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; eureka-user Build/SQ3A.220605.009.A1) gzip", clientHeader: "3" },
  { name: "IOS", clientName: "IOS", clientVersion: "20.10.4", key: "AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc", ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)", clientHeader: "5" }
] as const;

export function youtubeInnertubeRoute(http: HttpLayer): AccessRoute {
  const id = "youtube.innertube.metadata";
  return {
    id,
    platform: "youtube",
    capabilities: ["metadata", "author", "media", "media_metadata", "extract"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 85,
    enabled: true,
    accessLevel: "public",
    tags: ["official"],
    description:
      "YouTube InnerTube player API with unauthenticated mobile clients (ANDROID_VR → IOS). Rich metadata: description, duration, views, publish date, stream inventory. Playability statuses map honestly (LOGIN_REQUIRED → requires_auth).",
    estimatedCostMs: 2500,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const videoId = ctx.identity.id;
      const failures: string[] = [];
      for (const client of INNERTUBE_CLIENTS) {
        try {
          const res = await http.postJson(
            `https://www.youtube.com/youtubei/v1/player?key=${client.key}`,
            {
              context: { client: { clientName: client.clientName, clientVersion: client.clientVersion, hl: "en", gl: "US" } },
              videoId,
              contentCheckOk: true,
              racyCheckOk: true
            },
            {
              timeoutMs: ROUTE_TIMEOUT,
              maxBytes: 4 * 1024 * 1024,
              headers: { "user-agent": client.ua, "x-youtube-client-name": client.clientHeader, "x-youtube-client-version": client.clientVersion }
            }
          );
          if (res.status === 429) throw new HttpFailure("HTTP 429 from innertube", 429, FailureCode.RATE_LIMIT);
          if (res.status >= 400) throw new HttpFailure(`HTTP ${res.status} from innertube`, res.status, FailureCode.HTTP_ERROR);
          const player = JSON.parse(res.body.toString("utf8")) as InnerTubePlayer;
          const status = player.playabilityStatus?.status;
          if (status && !["OK", "LIVE_STREAM_OFFLINE"].includes(status)) {
            if (status === "LOGIN_REQUIRED") {
              return fail(id, { code: FailureCode.AUTH_REQUIRED, message: `playability=${status} (${player.playabilityStatus?.reason ?? ""})`, subject: id, retryable: false }, started);
            }
            if (status === "UNPLAYABLE" || status === "ERROR") {
              return fail(id, { code: FailureCode.INVALID_RESOURCE, message: `playability=${status} (${player.playabilityStatus?.reason ?? "unavailable"})`, subject: id, retryable: false }, started, true);
            }
            failures.push(`client ${client.name}: playability=${status}`);
            continue;
          }
          if (!player.videoDetails?.videoId) {
            failures.push(`client ${client.name}: empty videoDetails`);
            continue;
          }
          const evidence: Evidence = {
            id: `ev_${ctx.hash(`${videoId}:innertube:${client.name}`)}`,
            source: id,
            type: "innertube.player",
            data: { ...player, client: client.name },
            retrievedAt: new Date().toISOString(),
            reliability: 0.92,
            provenance: { endpoint: "youtubei/v1/player", client: client.name }
          };
          return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started, notes: failures.length > 0 ? failures : undefined };
        } catch (err) {
          failures.push(`client ${client.name}: ${(err as Error).message.slice(0, 140)}`);
        }
      }
      const code = /429/.test(failures.join(" ")) ? FailureCode.RATE_LIMIT : /login/i.test(failures.join(" ")) ? FailureCode.AUTH_REQUIRED : FailureCode.HTTP_ERROR;
      return fail(id, { code, message: failures.join(" | ") || "all innertube clients failed", subject: id, retryable: true }, started);
    }
  };
}

/* ------------------------------ yt-dlp routes ------------------------------ */

interface YtdlpOpts {
  mode: "metadata" | "download";
  client: "android_vr" | "ios";
  format?: "video" | "audio";
}

async function runYtdlp(ctx: ExecutionContext, opts: YtdlpOpts, routeId: string): Promise<RouteResult> {
  const started = Date.now();
  const { safeExec } = await import("../../core/security/exec.js");
  const ytdlp = ctx.environment.binaries["yt-dlp"];
  if (!ytdlp) {
    return fail(routeId, { code: FailureCode.ENVIRONMENT_INCOMPATIBLE, message: "yt-dlp binary not found on PATH", subject: routeId, retryable: false }, started);
  }
  const url = canonicalWatchUrl(ctx.identity.id);
  const args: string[] = ["--no-playlist", "--no-warnings", "--no-progress", "--no-cache-dir", "--socket-timeout", "20", "--retries", "2", "--extractor-args", `youtube:player_client=${opts.client}`];

  if (opts.mode === "metadata") {
    args.push("--dump-single-json", url);
  } else {
    const outTemplate = ctx.sink.allocate(`ytdlp.${opts.format === "audio" ? "m4a" : "mp4"}`).path.replace(/\.(m4a|mp4)$/, ".%(ext)s");
    if (opts.format === "audio") {
      args.push("--format", "bestaudio[ext=m4a]/bestaudio/best");
    } else {
      args.push("--format", "best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best[ext=webm]/best");
    }
    args.push("--output", outTemplate, "--no-part", url);
  }

  const res = await safeExec({
    cmd: ytdlp,
    args,
    timeoutMs: Math.max(5_000, ctx.deadlineAt - Date.now()),
    maxStdoutBytes: opts.mode === "metadata" ? 24 * 1024 * 1024 : 1024 * 1024,
    signal: ctx.signal
  });

  if (res.timedOut) {
    return fail(routeId, { code: FailureCode.TIMEOUT, message: `yt-dlp timed out after ${res.durationMs}ms`, subject: routeId, retryable: true }, started);
  }
  const errText = res.stderr ?? "";
  if (/Sign in to confirm|This video is private|members-only/i.test(errText)) {
    return fail(routeId, { code: FailureCode.AUTH_REQUIRED, message: errText.split("\n").find((l) => /confirm|private|members/i.test(l))?.slice(0, 200) ?? "yt-dlp reports login required", subject: routeId, retryable: false }, started);
  }
  if (res.code !== 0) {
    const unavailable = /Video unavailable|video is unavailable|Private video|removed by the uploader/i.test(errText);
    const rateLimited = /HTTP Error 429|not a bot/i.test(errText);
    return fail(
      routeId,
      {
        code: unavailable ? FailureCode.INVALID_RESOURCE : rateLimited ? FailureCode.RATE_LIMIT : FailureCode.DEPENDENCY_FAILURE,
        message: (errText.split("\n").filter(Boolean).pop() ?? "yt-dlp failed").slice(0, 240),
        subject: routeId,
        retryable: rateLimited
      },
      started,
      unavailable
    );
  }

  if (opts.mode === "metadata") {
    try {
      const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
      const evidence: Evidence = {
        id: `ev_${ctx.hash(`${routeId}:meta`)}`,
        source: routeId,
        type: "ytdlp.json",
        data: parsed,
        retrievedAt: new Date().toISOString(),
        reliability: 0.95,
        provenance: { tool: "yt-dlp", client: opts.client }
      };
      return { ok: true, routeId, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
    } catch {
      return fail(routeId, { code: FailureCode.PARSER_FAILURE, message: "yt-dlp produced invalid JSON", subject: routeId, retryable: true }, started);
    }
  }

  // download mode: locate produced files in the sandbox
  const { promises: fs } = await import("node:fs");
  const files = (await fs.readdir(ctx.workingDir)).filter((f) => !f.endsWith(".part") && !f.startsWith("."));
  if (files.length === 0) {
    return fail(routeId, { code: FailureCode.EMPTY_RESULT, message: "yt-dlp produced no output file", subject: routeId, retryable: true }, started);
  }
  const artifacts: RawArtifactRef[] = [];
  for (const f of files) {
    const full = `${ctx.workingDir}/${f}`;
    const stat = await fs.stat(full);
    if (stat.size === 0) continue;
    const ext = (f.split(".").pop() ?? "").toLowerCase();
    const kind = ["m4a", "mp3", "opus", "ogg", "weba", "wav"].includes(ext) ? "audio" : "video";
    const ref: RawArtifactRef = { path: full, kind, filename: f, expectedBytes: stat.size, meta: { producer: "yt-dlp", client: opts.client } };
    ctx.sink.register(ref);
    artifacts.push(ref);
  }
  if (artifacts.length === 0) {
    return fail(routeId, { code: FailureCode.EMPTY_RESULT, message: "yt-dlp produced only empty files", subject: routeId, retryable: true }, started);
  }
  return {
    ok: true,
    routeId,
    evidence: [
      {
        id: `ev_${ctx.hash(`${routeId}:download`)}`,
        source: routeId,
        type: "ytdlp.download",
        data: { files: artifacts.length, client: opts.client, bytes: artifacts.reduce((a, r) => a + (r.expectedBytes ?? 0), 0) },
        retrievedAt: new Date().toISOString(),
        reliability: 0.95,
        provenance: { tool: "yt-dlp", client: opts.client }
      }
    ],
    artifacts,
    latencyMs: Date.now() - started
  };
}

export function youtubeYtdlpMetadataRoute(): AccessRoute {
  const id = "youtube.ytdlp.metadata";
  return {
    id,
    platform: "youtube",
    capabilities: ["metadata", "author", "media", "media_metadata", "extract"],
    requirements: { binaries: ["yt-dlp"], network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 80,
    enabled: true,
    accessLevel: "public",
    tags: ["subprocess"],
    description: "yt-dlp --dump-single-json metadata extraction (android_vr profile). Requires the yt-dlp binary; no files are written.",
    estimatedCostMs: 6000,
    async execute(request, ctx) {
      return runYtdlp(ctx, { mode: "metadata", client: "android_vr" }, id);
    }
  };
}

export function youtubeYtdlpAcquireRoute(format: "video" | "audio" = "video"): AccessRoute {
  const id = format === "audio" ? "youtube.ytdlp.acquire.audio" : "youtube.ytdlp.acquire";
  return {
    id,
    platform: "youtube",
    capabilities: ["acquire", "artifact", "media"],
    requirements: { binaries: ["yt-dlp"], network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: format === "audio" ? 74 : 82,
    enabled: true,
    accessLevel: "public",
    tags: ["subprocess"],
    description:
      format === "audio"
        ? "yt-dlp audio-only acquisition (bestaudio m4a). Independent audio-salvage path when video extraction fails; the verifier accepts audio-only artifacts."
        : "yt-dlp video acquisition (android_vr profile, progressive mp4 preference). Files are written into the route sandbox and verified before promotion (magic bytes + ffprobe + moov walk).",
    estimatedCostMs: format === "audio" ? 30_000 : 60_000,
    async execute(request, ctx) {
      return runYtdlp(ctx, { mode: "download", client: "android_vr", format }, id);
    }
  };
}

export function youtubeYtdlpIosRoute(): AccessRoute {
  const id = "youtube.ytdlp.acquire.ios";
  return {
    id,
    platform: "youtube",
    capabilities: ["acquire", "artifact"],
    requirements: { binaries: ["yt-dlp"], network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 68,
    enabled: true,
    accessLevel: "public",
    tags: ["subprocess"],
    description: "yt-dlp acquisition via the iOS client profile (HLS). Structurally independent from android_vr: different signature path, different throttling.",
    estimatedCostMs: 90_000,
    async execute(request, ctx) {
      return runYtdlp(ctx, { mode: "download", client: "ios", format: "video" }, id);
    }
  };
}

/* ------------------------------- Piped route ------------------------------- */

interface PipedStreams {
  title?: string;
  description?: string;
  uploader?: string;
  uploaderUrl?: string;
  uploadDate?: string;
  duration?: number;
  views?: number;
  likes?: number;
  error?: string;
  videoStreams?: Array<{ url?: string; quality?: string; mimeType?: string; videoOnly?: boolean; contentLength?: number }>;
  audioStreams?: Array<{ url?: string; quality?: string; mimeType?: string; contentLength?: number }>;
}

export const PIPED_INSTANCES = ["https://pipedapi.kavin.rocks", "https://pipedapi.adminforge.de", "https://api.piped.private.coffee"];

export function youtubePipedRoute(http: HttpLayer): AccessRoute {
  const id = "youtube.piped.metadata";
  return {
    id,
    platform: "youtube",
    capabilities: ["metadata", "author", "media"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 55,
    enabled: true,
    accessLevel: "public",
    tags: ["public-mirror"],
    description:
      "Piped public API instances (/streams/{id}). Independent third-party mirror with instance rotation and per-instance failure reasons. Media URLs are exposed in evidence when present.",
    estimatedCostMs: 5000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const videoId = ctx.identity.id;
      const failures: string[] = [];
      for (const base of PIPED_INSTANCES) {
        try {
          const { data, res } = await getJson<PipedStreams>(http, `${base}/streams/${videoId}`, { timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 });
          if (data.error) {
            if (/not found|not exist|does not exist/i.test(data.error)) {
              return fail(id, { code: FailureCode.INVALID_RESOURCE, message: `piped: ${data.error}`, subject: id, retryable: false }, started, true);
            }
            failures.push(`${base}: ${data.error}`);
            continue;
          }
          const evidence: Evidence = {
            id: `ev_${ctx.hash(`${videoId}:piped:${base}`)}`,
            source: id,
            type: "piped.streams",
            data: { ...data, instance: base },
            retrievedAt: new Date().toISOString(),
            reliability: 0.7,
            provenance: { instance: base, status: res.status }
          };
          return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
        } catch (err) {
          failures.push(`${base}: ${(err as Error).message.slice(0, 140)}`);
        }
      }
      const code = /429/.test(failures.join(" ")) ? FailureCode.RATE_LIMIT : FailureCode.NETWORK_FAILURE;
      return fail(id, { code, message: failures.join(" | ") || "all piped instances failed", subject: id, retryable: true }, started);
    }
  };
}

export function youtubeRoutes(http: HttpLayer, cobaltUrl?: string): AccessRoute[] {
  const routes: AccessRoute[] = [
    youtubeProbeRoute(http),
    youtubeOembedRoute(http),
    youtubeInnertubeRoute(http),
    youtubeYtdlpMetadataRoute(),
    youtubeYtdlpAcquireRoute(),
    youtubeYtdlpAcquireRoute("audio"),
    youtubeYtdlpIosRoute(),
    youtubePipedRoute(http)
  ];
  // Mirror acquisition routes (ytagent method chain, self-contained):
  routes.push(youtubeInvidiousAcquireRoute(http));
  routes.push(youtubePipedAcquireRoute(http));
  if (cobaltUrl) {
    routes.push(youtubeCobaltAcquireRoute(http, cobaltUrl));
  }
  return routes;
}

/* Re-exports: mirror routes live in their own module. */
export { youtubeInvidiousAcquireRoute, youtubePipedAcquireRoute, youtubeCobaltAcquireRoute, resolveCobaltUrl } from "./mirror-routes.js";
