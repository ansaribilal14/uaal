/**
 * X single-status normalization: combine decoder evidence (fxtwitter primary,
 * vxtwitter fallback) into one normalized resource with explicit nulls and
 * per-post provenance (spec §14, §15).
 */
import type { Evidence, NormalizedMedia, NormalizedResource, ResourceIdentity } from "../../core/contracts.js";
import { SCHEMA_VERSION } from "../../version.js";
import { canonicalStatusUrl } from "./identity.js";
import { mapAuthor, mapMedia } from "./reconstruct.js";
import type { FxTweet } from "./decoders.js";

export function normalizeSingleStatus(evidence: Evidence[], identity: ResourceIdentity): NormalizedResource {
  const missing: string[] = [];
  const notes: NormalizedResource["uncertainty"]["notes"] = [];

  // pick the most reliable decode; record conflicts honestly
  const decodes = evidence
    .filter((e) => e.type === "fxtweet" || e.type === "vxtweet")
    .sort((a, b) => (b.reliability ?? 0) - (a.reliability ?? 0));
  const tweet = decodes[0]?.data as FxTweet | undefined;
  const textOf = (t?: FxTweet): string =>
    typeof t?.raw_text === "string" ? t.raw_text : (t?.text ?? "");
  if (!tweet) {
    missing.push("status");
    return emptyResource(identity, evidence, missing, notes);
  }
  if (decodes.length > 1) {
    notes.push({ code: "conflict.decoder", message: `multiple decoders served this status; used ${String(decodes[0].type)}`, severity: "info" });
  }
  // identifier consistency: decoded id must match the requested id
  if (tweet.id != null && String(tweet.id) !== identity.id) {
    notes.push({ code: "evidence.filtered", message: `decoder returned id ${tweet.id}, expected ${identity.id}; kept requested identity`, severity: "warn" });
  }

  const media: NormalizedMedia[] = mapMedia(tweet) as NormalizedMedia[];
  if (media.length === 0 && (tweet.media?.photos?.length ?? 0) + (tweet.media?.videos?.length ?? 0) === 0) {
    // no media is legitimate; not a missing field
  }

  const confidence = decodes.length > 0 ? Math.min(0.95, (decodes[0].reliability ?? 0.7) + (decodes.length > 1 ? 0.05 : 0)) : 0.3;

  return {
    schemaVersion: SCHEMA_VERSION,
    platform: "x",
    resource: { id: identity.id, url: canonicalStatusUrl(identity.id), type: "status", platform: "x" },
    content: {
      text: textOf(tweet),
      language: tweet.lang ?? undefined,
      publishedAt: tweet.created_timestamp ?? tweet.created_at ?? undefined,
      metrics: {
        likes: tweet.likes ?? null,
        retweets: tweet.retweets ?? null,
        replies: tweet.replies ?? null,
        quotes: tweet.quotes ?? null,
        bookmarks: tweet.bookmarks ?? null,
        views: tweet.views ?? null
      }
    },
    author: mapAuthor(tweet.author),
    media,
    relationships: [],
    platformData: {
      sources: decodes.map((d) => ({ source: d.source, type: d.type, reliability: d.reliability })),
      extractionSource: decodes[0] ? String((decodes[0].data as Record<string, unknown>)._extraction_source ?? decodes[0].type) : null,
      replyingTo: tweet.replying_to ?? null,
      replyingToStatus: tweet.replying_to_status != null ? String(tweet.replying_to_status) : null,
      quote: tweet.quote ? { id: String(tweet.quote.id ?? ""), text: tweet.quote.text ?? "" } : null
    },
    evidence: evidence.map(({ id, source, type, retrievedAt, reliability }) => ({ id, source, type, retrievedAt, reliability })),
    uncertainty: { confidence, missing, notes }
  };
}

function emptyResource(identity: ResourceIdentity, evidence: Evidence[], missing: string[], notes: NormalizedResource["uncertainty"]["notes"]): NormalizedResource {
  return {
    schemaVersion: SCHEMA_VERSION,
    platform: "x",
    resource: { id: identity.id, url: canonicalStatusUrl(identity.id), type: "status", platform: "x" },
    content: {},
    media: [],
    relationships: [],
    platformData: {},
    evidence: evidence.map(({ id, source, type, retrievedAt, reliability }) => ({ id, source, type, retrievedAt, reliability })),
    uncertainty: { confidence: 0.1, missing, notes }
  };
}
