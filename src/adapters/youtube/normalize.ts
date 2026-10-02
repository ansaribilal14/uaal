/**
 * YouTube normalization: combine evidence from independent routes
 * (oEmbed, InnerTube, yt-dlp, Piped) into one normalized resource.
 * Conflicts resolve by reliability, uncertainty is exposed, unrelated data
 * rejected by identifier match (spec §14).
 */
import type { Evidence, NormalizedMedia, NormalizedResource, ResourceIdentity } from "../../core/contracts.js";
import { SCHEMA_VERSION } from "../../version.js";
import { canonicalWatchUrl } from "./identity.js";

interface OEmbedData {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
}

interface InnerRadius {
  videoDetails?: {
    videoId?: string;
    title?: string;
    shortDescription?: string;
    lengthSeconds?: string;
    viewCount?: string;
    author?: string;
    channelId?: string;
    thumbnail?: { thumbnails?: Array<{ url: string; width: number; height: number }> };
  };
  microformat?: { playerMicroformatRenderer?: { publishDate?: string; uploadDate?: string; viewCount?: string } };
  streamingData?: { formats?: Array<{ url?: string; mimeType?: string; bitrate?: number; width?: number; height?: number; qualityLabel?: string }> };
  client?: string;
}

interface YtdlpData {
  title?: string;
  description?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  uploader?: string;
  channel?: string;
  channel_id?: string;
  upload_date?: string;
  webpage_url?: string;
  thumbnail?: string;
  formats?: Array<{ url?: string; ext?: string; vcodec?: string; acodec?: string; height?: number; format_note?: string }>;
  _type?: string;
}

interface PipedData {
  title?: string;
  description?: string;
  uploader?: string;
  uploaderUrl?: string;
  uploadDate?: string;
  duration?: number;
  views?: number;
  likes?: number;
  videoStreams?: Array<{ url?: string; quality?: string; mimeType?: string; videoOnly?: boolean }>;
  audioStreams?: Array<{ url?: string; quality?: string; mimeType?: string }>;
  instance?: string;
}

export function normalizeYouTubeResource(evidence: Evidence[], identity: ResourceIdentity): NormalizedResource {
  const notes: NormalizedResource["uncertainty"]["notes"] = [];
  const missing: string[] = [];

  const oembed = pick<OEmbedData>(evidence, "oembed");
  const innertube = pickInner(evidence);
  const ytdlp = pick<YtdlpData>(evidence, "ytdlp.json");
  const piped = pick<PipedData>(evidence, "piped.streams");

  // identifier consistency: reject evidence that speaks about a different video
  const cleanEvidence = evidence.filter((e) => {
    const d = e.data as Record<string, unknown>;
    const evId = (d.videoId as string) ?? (d.id as string) ?? (innertube && e.type === "innertube.player" ? innertube.videoDetails?.videoId : undefined);
    return !evId || evId === identity.id;
  });
  if (cleanEvidence.length < evidence.length) {
    notes.push({ code: "evidence.filtered", message: "dropped evidence describing a different resource id", severity: "warn" });
  }

  // title: prefer richer sources; conflict → higher reliability wins, note it
  const titleCandidates: Array<[string | undefined, number, string]> = [
    [innertube?.videoDetails?.title, 0.92, "innertube"],
    [ytdlp?.title, 0.95, "ytdlp"],
    [piped?.title, 0.7, "piped"],
    [oembed?.title, 0.9, "oembed"]
  ];
  const titles = titleCandidates.filter(([t]) => !!t) as Array<[string, number, string]>;
  let title: string | undefined;
  if (titles.length > 0) {
    titles.sort((a, b) => b[1] - a[1]);
    title = titles[0][0];
    if (new Set(titles.map((t) => t[0])).size > 1) {
      notes.push({ code: "conflict.title", message: `title differs across sources; used ${titles[0][2]}`, severity: "info" });
    }
  } else {
    missing.push("title");
  }

  const description = innertube?.videoDetails?.shortDescription ?? ytdlp?.description ?? piped?.description;
  const durationSec = numberOrNull(innertube?.videoDetails?.lengthSeconds) ?? ytdlp?.duration ?? piped?.duration;
  if (durationSec === undefined) missing.push("duration");
  const views = numberOrNull(innertube?.videoDetails?.viewCount) ?? ytdlp?.view_count ?? piped?.views ?? numberOrNull(innertube?.microformat?.playerMicroformatRenderer?.viewCount);
  const likes = ytdlp?.like_count ?? piped?.likes ?? null;
  const publishedAt =
    innertube?.microformat?.playerMicroformatRenderer?.publishDate ??
    innertube?.microformat?.playerMicroformatRenderer?.uploadDate ??
    (ytdlp?.upload_date ? `${ytdlp.upload_date.slice(0, 4)}-${ytdlp.upload_date.slice(4, 6)}-${ytdlp.upload_date.slice(6, 8)}T00:00:00Z` : undefined) ??
    piped?.uploadDate;
  if (!publishedAt) missing.push("publishedAt");

  const authorName = innertube?.videoDetails?.author ?? ytdlp?.uploader ?? ytdlp?.channel ?? oembed?.author_name ?? piped?.uploader;
  const authorUrl = oembed?.author_url ?? (ytdlp?.channel_id ? `https://www.youtube.com/channel/${ytdlp.channel_id}` : piped?.uploaderUrl ? `https://www.youtube.com${piped.uploaderUrl}` : undefined);

  // media inventory: thumbnails + stream variants when exposed
  const media: NormalizedMedia[] = [];
  const thumbs = new Set<string>();
  if (oembed?.thumbnail_url) thumbs.add(oembed.thumbnail_url);
  for (const t of innertube?.videoDetails?.thumbnail?.thumbnails ?? []) {
    if (t.url) thumbs.add(t.url);
  }
  if (ytdlp?.thumbnail) thumbs.add(ytdlp.thumbnail);
  const bestThumb = [...thumbs].sort((a, b) => (b.includes("maxres") ? 1 : 0) - (a.includes("maxres") ? 1 : 0))[0];
  if (bestThumb) {
    media.push({ kind: "photo", url: bestThumb, mimeType: "image/jpeg", unavailableReason: undefined });
  }

  // stream variants (evidence only; URLs expire fast — documented limitation)
  const variants: Array<Record<string, unknown>> = [];
  for (const f of innertube?.streamingData?.formats ?? []) {
    if (f.url) variants.push({ url: f.url, mimeType: f.mimeType, bitrate: f.bitrate, width: f.width, height: f.height, quality: f.qualityLabel, source: "innertube" });
  }
  for (const f of ytdlp?.formats ?? []) {
    if (f.url && f.vcodec !== "none") variants.push({ url: f.url, mimeType: f.ext ? `video/${f.ext}` : undefined, height: f.height, source: "ytdlp", note: f.format_note });
  }
  const pipedVideo = (piped?.videoStreams ?? []).filter((s) => s.url);
  if (variants.length > 0 || pipedVideo.length > 0) {
    media.push({
      kind: "video",
      url: variants[0]?.url as string | undefined ?? pipedVideo[0]?.url,
      unavailableReason: variants.length === 0 ? "urls_from_mirror_only" : undefined,
      variants: [...variants, ...pipedVideo.map((s) => ({ url: s.url, quality: s.quality, mimeType: s.mimeType, videoOnly: s.videoOnly, source: "piped" }))].slice(0, 20)
    });
  } else if (oembed || innertube || ytdlp) {
    media.push({ kind: "video", unavailableReason: "stream_urls_not_exposed_by_evidence_source" });
  }

  const confidence = computeConfidence(cleanEvidence, missing);

  return {
    schemaVersion: SCHEMA_VERSION,
    platform: "youtube",
    resource: {
      id: identity.id,
      url: canonicalWatchUrl(identity.id),
      type: "video",
      platform: "youtube"
    },
    content: {
      title,
      description,
      language: undefined,
      publishedAt,
      metrics: { views, likes }
    },
    author: authorName || authorUrl ? { name: authorName, url: authorUrl, handle: undefined } : undefined,
    media,
    relationships: [],
    platformData: {
      sources: cleanEvidence.map((e) => ({ source: e.source, type: e.type, reliability: e.reliability, provenance: e.provenance })),
      innertube: innertube ? { client: innertube.client, channelId: innertube.videoDetails?.channelId, isLiveContent: (innertube.videoDetails as unknown as { isLiveContent?: boolean })?.isLiveContent } : undefined,
      ytdlp: ytdlp ? { channel: ytdlp.channel, channel_id: ytdlp.channel_id, extractor: (ytdlp as { extractor?: string }).extractor } : undefined,
      piped: piped ? { instance: piped.instance } : undefined
    },
    evidence: cleanEvidence.map(({ id, source, type, retrievedAt, reliability }) => ({ id, source, type, retrievedAt, reliability })),
    uncertainty: { confidence, missing, notes }
  };
}

function pick<T>(evidence: Evidence[], type: string): T | undefined {
  const e = [...evidence].reverse().find((x) => x.type === type);
  return e ? (e.data as T) : undefined;
}

function pickInner(evidence: Evidence[]): InnerRadius | undefined {
  const e = [...evidence].reverse().find((x) => x.type === "innertube.player");
  return e ? (e.data as InnerRadius) : undefined;
}

function numberOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function computeConfidence(evidence: Evidence[], missing: string[]): number {
  if (evidence.length === 0) return 0;
  const best = Math.max(...evidence.map((e) => e.reliability ?? 0.5));
  const penalty = Math.min(0.4, missing.length * 0.1);
  return Math.max(0.05, Math.min(0.98, best - penalty));
}
