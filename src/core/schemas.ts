/**
 * Wire schemas (spec §40). Every machine-readable result carries
 * schema_version; these zod schemas are the runtime contract for envelopes
 * and are exported as JSON Schema via `uaal schema`.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CAPABILITIES } from "./contracts.js";

export const capabilitySchema = z.enum(CAPABILITIES as unknown as [string, ...string[]]);

export const statusSchema = z.enum(["ok", "partial", "empty", "failed", "unsupported", "requires_auth", "blocked"]);

export const attemptRecordSchema = z.object({
  route: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  status: z.enum(["success", "failure", "skipped", "probe"]),
  failureCode: z.string().optional(),
  message: z.string().optional(),
  bytesDownloaded: z.number().optional(),
  verified: z.boolean().optional()
});

export const verificationCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
  artifactId: z.string().optional()
});

export const verificationResultSchema = z.object({
  verified: z.boolean(),
  checks: z.array(verificationCheckSchema),
  summary: z.string().optional(),
  durationMs: z.number().optional()
});

export const artifactSchema = z.object({
  artifactId: z.string(),
  resourceId: z.string(),
  type: z.string(),
  path: z.string(),
  size: z.number(),
  checksum: z.string(),
  mimeType: z.string(),
  createdAt: z.string(),
  verificationStatus: z.enum(["verified", "unverified", "failed"]),
  sourceRoute: z.string(),
  filename: z.string(),
  media: z
    .object({
      container: z.string().optional(),
      durationSec: z.number().optional(),
      videoCodec: z.string().optional(),
      audioCodec: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional()
    })
    .optional()
});

export const resourceIdentitySchema = z.object({
  platform: z.string(),
  type: z.string(),
  id: z.string(),
  canonicalUrl: z.string(),
  aliases: z.array(z.string()),
  relatedIds: z.array(z.string()).optional(),
  fingerprint: z.string()
});

export const normalizedMediaSchema = z.object({
  kind: z.string(),
  url: z.string().optional(),
  mimeType: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationSec: z.number().optional(),
  thumbnailUrl: z.string().optional(),
  downloadable: z.boolean().optional(),
  unavailableReason: z.string().optional(),
  variants: z.array(z.record(z.unknown())).optional()
}).passthrough();

export const normalizedResourceSchema = z
  .object({
    schemaVersion: z.string(),
    platform: z.string(),
    resource: z.object({
      id: z.string(),
      url: z.string(),
      type: z.string(),
      platform: z.string()
    }),
    content: z.record(z.unknown()),
    author: z.record(z.unknown()).optional(),
    media: z.array(normalizedMediaSchema),
    relationships: z.array(z.object({ type: z.string(), from: z.string(), to: z.string(), position: z.number().optional() })),
    platformData: z.record(z.unknown()),
    evidence: z.array(
      z.object({
        id: z.string(),
        source: z.string(),
        type: z.string(),
        retrievedAt: z.string(),
        reliability: z.number().optional()
      })
    ),
    uncertainty: z.object({
      confidence: z.number(),
      missing: z.array(z.string()),
      notes: z.array(z.object({ code: z.string(), message: z.string(), severity: z.enum(["info", "warn", "error"]) }))
    })
  })
  .passthrough();

export const discoveredRouteInfoSchema = z.object({
  id: z.string(),
  platform: z.string(),
  capabilities: z.array(z.string()),
  status: z.enum(["available", "filtered", "probe-failed", "disabled"]),
  confidence: z.number(),
  priority: z.number(),
  tags: z.array(z.string()),
  accessLevel: z.enum(["public", "authorized"]),
  reasons: z.array(z.string()).optional()
});

export const envelopeSchema = z.object({
  schemaVersion: z.string(),
  status: statusSchema,
  operation: z.string(),
  request: z.object({
    resource: z.string(),
    capability: capabilitySchema,
    platform: z.string().optional()
  }),
  identity: resourceIdentitySchema.optional(),
  resource: normalizedResourceSchema.optional(),
  artifacts: z.array(artifactSchema).optional(),
  verification: verificationResultSchema.optional(),
  route: z.object({ id: z.string(), platform: z.string(), tags: z.array(z.string()) }).optional(),
  attempts: z.array(attemptRecordSchema),
  discovery: z.array(discoveredRouteInfoSchema).optional(),
  error: z.object({ code: z.string(), message: z.string(), attempts: z.array(attemptRecordSchema) }).optional(),
  available: z.array(z.string()).optional(),
  missing: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  timing: z.object({ startedAt: z.string(), durationMs: z.number() }),
  traceId: z.string(),
  requestId: z.string().optional()
});

export type WireEnvelope = z.infer<typeof envelopeSchema>;

/** JSON Schemas for all public contracts (spec §40: `uaal schema`). */
export function exportJsonSchemas(): Record<string, unknown> {
  const name = (s: z.ZodTypeAny) =>
    zodToJsonSchema(s, { $refStrategy: "none", target: "jsonSchema7" }) as Record<string, unknown>;
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "UAAL Schemas",
    schemaVersion: "1.0",
    definitions: {
      Envelope: name(envelopeSchema),
      NormalizedResource: name(normalizedResourceSchema),
      Artifact: name(artifactSchema),
      VerificationResult: name(verificationResultSchema),
      ResourceIdentity: name(resourceIdentitySchema),
      AttemptRecord: name(attemptRecordSchema),
      DiscoveredRoute: name(discoveredRouteInfoSchema)
    }
  };
}

export function validateEnvelope(value: unknown): { ok: true } | { ok: false; errors: string[] } {
  const res = envelopeSchema.safeParse(value);
  return res.success ? { ok: true } : { ok: false, errors: res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}
