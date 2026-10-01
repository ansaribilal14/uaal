# ADAPTER_GUIDE

How to add a platform adapter without touching the core (spec §37, Rule 12).

## 1. What you implement

One object satisfying `PlatformAdapter`:

```ts
import type { PlatformAdapter } from "../core/contracts.js";

export class TikTokAdapter implements PlatformAdapter {
  readonly id = "tiktok";
  detect(resource: string): DetectionResult { /* shape match, confidence 0..1 */ }
  capabilities(): CapabilityDescriptor[] { /* declare only what you serve */ }
  limitations(): string[] { /* honest constraints, shown by uaal capabilities */ }
  discoverRoutes(request, ctx): Promise<AccessRoute[]> { /* candidates for this request */ }
  resolveIdentity(resource): Promise<ResourceIdentity> { /* canonical URL + id + fingerprint */ }
  normalize(evidence, request, identity): Promise<NormalizedResource> { /* combine evidence */ }
  verify(resource, artifacts): Promise<VerificationResult> { /* platform-specific checks */ }
}
```

Register it in `src/adapters/index.ts` (`getBuiltinAdapters`) — the single line the core knows about concrete platforms.

## 2. The route contract

Every route:

```ts
{
  id: "tiktok.oembed.metadata",        // MUST start with the platform id
  platform: "tiktok",
  capabilities: ["metadata"],
  requirements: { network: true },      // binaries: ["yt-dlp"] when subprocess-based
  environmentCompatibility: { local: true, remote: true },
  priority: 85,                          // higher runs first
  enabled: true,
  accessLevel: "public",                 // "authorized" requires policy credentials
  tags: ["official"],
  description: "...",                    // state the endpoint class + failure semantics
  async execute(request, ctx): Promise<RouteResult> { ... }
}
```

**Route rules:**

1. **Never raise.** Wrap everything; return `RouteResult` with a classified failure. Let `classifyFailure`/`HttpFailure` do the mapping.
2. **Distinguish unavailable from failed.** A clean 404 is `unavailable: true` with `INVALID_RESOURCE` — an informative negative (no retry, filter signal). Network junk is `failed`.
3. **Write only through `ctx.sink`.** Allocate inside `ctx.workingDir`, register refs. The router rejects anything outside the sandbox.
4. **Honor `ctx.signal` and `ctx.deadlineAt`.** The router races your execution against the deadline, but cooperative cancellation still kills subprocesses and streams early.
5. **Respect politeness.** One request per external surface per run where feasible; the shared HttpLayer adds per-host pacing.
6. **Record provenance.** Evidence carries `source` (route id), `type`, `reliability` (0..1), `provenance`. Per-item provenance (e.g. which decoder served a post) goes into `platformData`.

## 3. Normalization rules (spec §14, §15)

- Common fields are stable: `resource{id,url,type,platform}`, `content`, `author`, `media`, `relationships`, `platformData`, `evidence`, `uncertainty`.
- **Conflicts**: prefer higher-reliability evidence; record the conflict (`conflict.title`) instead of hiding it.
- **Reject unrelated evidence**: match platform ids before using a payload (`evidence.filtered` note otherwise).
- **Explicit nulls**: absent information is `null`/listed in `uncertainty.missing` — never fabricated, never defaulted to something plausible.
- `uncertainty.confidence` = f(best evidence reliability, missing fields).

## 4. Verification hooks

`adapter.verify(resource, artifacts)` runs platform-specific checks on top of the generic engine verification. At minimum check **identifier consistency** (the resolved id matches the requested id — see the YouTube/X adapters). The artifact file checks (magic bytes, ffprobe, moov, checksums) are engine-level and automatic.

## 5. Worked example (Reddit, real code)

`src/adapters/reddit/adapter.ts` is a complete, minimal adapter: URL parsing → canonical identity (`reddit.com/comments/{id}`) → one public route (`comments/{id}.json`) → normalization (post + comments + gallery/video inventory) → verification. Read it first; it exercises the whole contract in ~250 lines.

## 6. Testing your adapter

The contract suite (`tests/contracts/adapters.test.ts`) runs every registered adapter through the same checks automatically — add your URL to `ADAPTER_URLS` and the detection/contract assertions apply. Then add fixtures:

- URL variants accepted/rejected
- normalization from canned evidence (including conflicts and foreign ids)
- route failure mapping (mock HTTP or scripted failures like `tests/fixtures/scripted.ts`)

Contract tests are part of CI; live-network probes are not.

## 7. Future platforms (deliberately not implemented)

Instagram, TikTok, Facebook, Telegram are roadmap items, not fake registrations. If a platform has no public/authorized access surface, the honest outcome is `unsupported`/`requires_auth` — an adapter whose sole purpose is bypassing access controls will not be accepted (spec §28, §65).
