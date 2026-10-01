/**
 * Generic Web adapter — publicly accessible web resources via deterministic
 * HTML metadata extraction (OpenGraph, Twitter cards, JSON-LD). No
 * headless browser, no LLM — plain parsing, fail-honest when a page has no
 * extractable metadata.
 */
import type {
  AccessRoute,
  CapabilityDescriptor,
  DetectionResult,
  Evidence,
  ExecutionContext,
  NormalizedMedia,
  NormalizedResource,
  PlatformAdapter,
  RawArtifactRef,
  ResourceIdentity,
  ResourceRequest,
  RouteDiscoveryContext,
  RouteResult,
  VerificationResult,
  Artifact
} from "../../core/contracts.js";
import { classifyFailure, FailureCode, type Failure } from "../../core/errors.js";
import { HttpLayer } from "../../core/http.js";
import { makeIdentity } from "../../core/identity.js";
import { SCHEMA_VERSION } from "../../version.js";
import { verifyNormalizedResource } from "../../core/verify/index.js";

export function detectGenericWeb(resource: string): boolean {
  try {
    const u = new URL(resource.startsWith("http") ? resource : `https://${resource}`);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function identityFor(resource: string): ResourceIdentity {
  let canonical = resource;
  try {
    const u = new URL(resource.startsWith("http") ? resource : `https://${resource}`);
    u.hash = "";
    // strip common tracking params for a stable identity
    for (const p of [...u.searchParams.keys()]) {
      if (/^utm_|fbclid|gclid|ref_src|ref_url/i.test(p)) u.searchParams.delete(p);
    }
    canonical = u.href;
  } catch {
    /* keep raw */
  }
  return makeIdentity("generic-web", "page", canonical, canonical, [resource]);
}

/* ------------------------------ HTML extraction ------------------------------ */

export interface WebMetadata {
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  publishedTime?: string;
  author?: string;
  type?: string;
  jsonLd?: unknown[];
}

export function extractHtmlMetadata(html: string): WebMetadata {
  const meta = (prop: string): string | undefined => {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRe(prop)}["'][^>]+content=["']([^"']*)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escapeRe(prop)}["']`, "i")
    ];
    for (const re of patterns) {
      const m = re.exec(html);
      if (m?.[1]) return decodeEntities(m[1].trim());
    }
    return undefined;
  };
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const ldJson: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      ldJson.push(JSON.parse(m[1]));
    } catch {
      /* malformed JSON-LD is skipped, not fatal */
    }
  }
  const first = (a?: string, b?: string, c?: string) => a ?? b ?? c;
  return {
    title: first(meta("og:title"), meta("twitter:title"), titleTag ? decodeEntities(titleTag) : undefined),
    description: first(meta("og:description"), meta("description"), meta("twitter:description")),
    siteName: meta("og:site_name"),
    image: first(meta("og:image"), meta("twitter:image"), meta("twitter:image:src")),
    publishedTime: first(meta("article:published_time"), meta("datePublished"), meta("date")),
    author: first(meta("author"), meta("article:author")),
    type: meta("og:type"),
    jsonLd: ldJson
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/* --------------------------------- routes --------------------------------- */

export function webMetadataRoute(http: HttpLayer): AccessRoute {
  const id = "generic-web.opengraph.metadata";
  return {
    id,
    platform: "generic-web",
    capabilities: ["metadata", "author", "media", "extract"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 80,
    enabled: true,
    accessLevel: "public",
    tags: ["scrape"],
    description:
      "Public HTML fetch (10 MiB cap, SSRF-guarded, https-only) with deterministic extraction of OpenGraph / Twitter card / JSON-LD metadata. No JavaScript rendering: pages that require JS may yield sparse metadata (reported honestly).",
    estimatedCostMs: 3000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const url = ctx.identity.canonicalUrl;
      try {
        const res = await http.get(url, { timeoutMs: 25_000, maxBytes: 10 * 1024 * 1024 });
        if (res.status === 404 || res.status === 410) {
          return { ok: false, routeId: id, evidence: [], artifacts: [], unavailable: true, failure: { code: FailureCode.INVALID_RESOURCE, message: `HTTP ${res.status}`, subject: id, retryable: false }, latencyMs: Date.now() - started };
        }
        if (res.status === 401 || res.status === 403) {
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.AUTH_REQUIRED, message: `HTTP ${res.status} (paywall or bot protection)`, subject: id, retryable: false }, latencyMs: Date.now() - started };
        }
        if (res.status === 429) {
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.RATE_LIMIT, message: "HTTP 429", subject: id, retryable: true }, latencyMs: Date.now() - started };
        }
        if (res.status >= 400) {
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.HTTP_ERROR, message: `HTTP ${res.status}`, subject: id, retryable: false }, latencyMs: Date.now() - started };
        }
        const contentType = res.headers["content-type"] ?? "";
        const body = res.body.toString("utf8");
        if (!/text\/html|application\/xhtml/i.test(contentType) && !/<html/i.test(body.slice(0, 512))) {
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.PARSER_FAILURE, message: `content-type ${contentType || "unknown"} is not HTML`, subject: id, retryable: false }, latencyMs: Date.now() - started };
        }
        const metadata = extractHtmlMetadata(body);
        const evidence: Evidence = {
          id: `ev_${ctx.hash(`${ctx.identity.fingerprint}:og`)}`,
          source: id,
          type: "og.html",
          data: { ...metadata, finalUrl: res.finalUrl, httpStatus: res.status, bytes: res.body.length },
          retrievedAt: new Date().toISOString(),
          reliability: 0.75,
          provenance: { endpoint: res.finalUrl, redirected: res.redirected }
        };
        return { ok: true, routeId: id, evidence: [evidence], artifacts: [], latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, routeId: id, evidence: [], artifacts: [], failure: httpToFailure(err, id), latencyMs: Date.now() - started };
      }
    }
  };
}

export function webSnapshotRoute(http: HttpLayer): AccessRoute {
  const id = "generic-web.snapshot.acquire";
  return {
    id,
    platform: "generic-web",
    capabilities: ["acquire", "artifact"],
    requirements: { network: true },
    environmentCompatibility: { local: true, remote: true },
    priority: 75,
    enabled: true,
    accessLevel: "public",
    tags: ["scrape"],
    description:
      "Raw HTML snapshot acquisition: the exact bytes served are stored as a verified document artifact (sha256 recorded). Metadata routes are independent of this route.",
    estimatedCostMs: 6000,
    async execute(request, ctx): Promise<RouteResult> {
      const started = Date.now();
      const url = ctx.identity.canonicalUrl;
      try {
        const res = await http.get(url, { timeoutMs: 30_000, maxBytes: 20 * 1024 * 1024 });
        if (!res.ok) {
          return { ok: false, routeId: id, evidence: [], artifacts: [], failure: { code: FailureCode.HTTP_ERROR, message: `HTTP ${res.status}`, subject: id, retryable: res.status >= 500 }, latencyMs: Date.now() - started };
        }
        const name = sanitizeHostFile(url);
        const dest = ctx.sink.allocate(`${name}.html`);
        const { atomicWriteFile } = await import("../../core/security/paths.js");
        await atomicWriteFile(dest.path, res.body);
        const ref: RawArtifactRef = { path: dest.path, kind: "document", filename: `${name}.html`, mimeType: res.headers["content-type"] ?? "text/html", expectedBytes: res.body.length };
        ctx.sink.register(ref);
        const evidence: Evidence = {
          id: `ev_${ctx.hash(`${ctx.identity.fingerprint}:snapshot`)}`,
          source: id,
          type: "web.snapshot",
          data: { bytes: res.body.length, finalUrl: res.finalUrl, status: res.status },
          retrievedAt: new Date().toISOString(),
          reliability: 0.9,
          provenance: { endpoint: res.finalUrl }
        };
        return { ok: true, routeId: id, evidence: [evidence], artifacts: [ref], latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, routeId: id, evidence: [], artifacts: [], failure: httpToFailure(err, id), latencyMs: Date.now() - started };
      }
    }
  };
}

function sanitizeHostFile(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/[^a-z0-9.-]/gi, "_")}${u.pathname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "_root"}`;
  } catch {
    return "page";
  }
}

function httpToFailure(err: unknown, routeId: string): Failure {
  const c = classifyFailure(err, routeId);
  return { code: c.code, message: c.message, subject: routeId, retryable: c.retryable };
}

/* --------------------------------- adapter --------------------------------- */

export class GenericWebAdapter implements PlatformAdapter {
  readonly id = "generic-web" as const;
  private http: HttpLayer;

  constructor(http: HttpLayer) {
    this.http = http;
  }

  detect(resource: string): DetectionResult {
    if (detectGenericWeb(resource)) {
      return { matched: true, confidence: 0.5, platform: "generic-web", resourceType: "page" };
    }
    return { matched: false, confidence: 0 };
  }

  capabilities(): CapabilityDescriptor[] {
    return [
      { name: "metadata", description: "OpenGraph/Twitter-card/JSON-LD metadata.", engineLevel: false },
      { name: "author", description: "Author meta when present.", engineLevel: false },
      { name: "media", description: "og:image as media item.", engineLevel: false },
      { name: "acquire", description: "Raw HTML snapshot artifact.", engineLevel: false },
      { name: "extract", description: "Raw metadata payload in platformData.", engineLevel: false }
    ];
  }

  limitations(): string[] {
    return [
      "No JavaScript rendering: client-side pages may expose little metadata.",
      "https-only by default (SSRF policy); plain http is refused.",
      "Snapshot artifacts are exactly the served bytes; no cookie/session emulation."
    ];
  }

  async discoverRoutes(request: ResourceRequest, ctx: RouteDiscoveryContext): Promise<AccessRoute[]> {
    return [webMetadataRoute(this.http), webSnapshotRoute(this.http)];
  }

  async resolveIdentity(resource: string): Promise<ResourceIdentity> {
    return identityFor(resource);
  }

  async normalize(evidence: Evidence[], request: ResourceRequest, identity: ResourceIdentity): Promise<NormalizedResource> {
    const og = [...evidence].reverse().find((e) => e.type === "og.html")?.data as (WebMetadata & { finalUrl?: string }) | undefined;
    const missing: string[] = [];
    if (!og) missing.push("metadata");
    else {
      if (!og.title) missing.push("title");
      if (!og.description) missing.push("description");
    }
    const media: NormalizedMedia[] = [];
    if (og?.image) media.push({ kind: "photo", url: og.image, downloadable: true });
    return {
      schemaVersion: SCHEMA_VERSION,
      platform: "generic-web",
      resource: { id: identity.id, url: identity.canonicalUrl, type: "page", platform: "generic-web" },
      content: {
        title: og?.title,
        description: og?.description,
        publishedAt: og?.publishedTime,
        siteName: og?.siteName
      },
      author: og?.author ? { name: og.author } : undefined,
      media,
      relationships: [],
      platformData: {
        og: og ? { type: og.type, jsonLdCount: (og.jsonLd ?? []).length, finalUrl: og.finalUrl } : undefined
      },
      evidence: evidence.map(({ id, source, type, retrievedAt, reliability }) => ({ id, source, type, retrievedAt, reliability })),
      uncertainty: {
        confidence: missing.length === 0 ? 0.8 : missing.length === 1 ? 0.5 : 0.25,
        missing,
        notes: missing.length > 0 ? [{ code: "web.sparse", message: "page exposes limited static metadata (JS-rendered content not fetched)", severity: "info" }] : []
      }
    };
  }

  async verify(resource: NormalizedResource, artifacts: Artifact[]): Promise<VerificationResult> {
    // generic pages legitimately lack many fields; verify structure + evidence provenance only
    const checks = [
      { name: "schema.identity", passed: !!resource.resource?.url, detail: undefined as string | undefined },
      { name: "schema.version", passed: resource.schemaVersion === SCHEMA_VERSION },
      { name: "evidence_present", passed: resource.evidence.length > 0 }
    ];
    return { verified: checks.every((c) => c.passed), checks, summary: checks.filter((c) => !c.passed).map((c) => c.name).join("; ") || "ok" };
  }
}

export { verifyNormalizedResource };
