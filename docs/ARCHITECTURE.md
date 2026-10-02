# ARCHITECTURE

## 1. What UAAL is

UAAL (Universal Agent Access Layer) is a deterministic, LLM-free infrastructure layer that gives AI agents access to public/authorized web resources through one machine-readable contract. It separates *what an agent wants* (resource + capability) from *how access happens* (platform-specific routes, fallback, verification).

```
CALLING AGENT
        ↓
UNIVERSAL API            src/interfaces/{cli,http,mcp}
        ↓
ENGINE FACADE            src/core/engine.ts
        ↓
CAPABILITY ROUTER        src/core/router.ts
        ↓
PLATFORM ADAPTERS        src/adapters/{youtube,x,reddit,generic-web}
        ↓
ACCESS ROUTES            independent methods per platform+capability
        ↓
EXECUTION CONTEXT        sandboxed temp dirs, deadlines, cancellation
        ↓
EVIDENCE                 src/core/contracts.ts (Evidence)
        ↓
RECONSTRUCTION           adapter normalize() — data relations, conflicts, uncertainty
        ↓
NORMALIZATION            schema-validated NormalizedResource
        ↓
VERIFICATION             src/core/verify/ — method-blind gates
        ↓
ARTIFACT STORE           src/core/artifacts/store.ts — atomic promotion
        ↓
ENVELOPE                 strict status model, attempts, timings
```

## 2. Module map

| Module | Responsibility |
|--------|----------------|
| `src/core/contracts.ts` | Every core interface: `ResourceRequest`, `AccessRoute`, `PlatformAdapter`, `Evidence`, `NormalizedResource`, `Artifact`, `UAALEnvelope`, `ExecutionProvider`, config |
| `src/core/errors.ts` | `FailureCode` taxonomy, deterministic `classifyFailure`, strict status aggregation |
| `src/core/schemas.ts` | zod wire schemas + JSON Schema export (`uaal schema`) |
| `src/core/identity.ts` | Platform registry, detection dispatch, canonical resource identity + fingerprints |
| `src/core/router.ts` | Discovery, filtering, ranking (priority + learning + confidence), single-attempt execution with sandbox/deadline/never-raise |
| `src/core/engine.ts` | Facade: resolve/inspect/acquire/verify/plan, the fallback loop, verification gates, idempotency, envelopes |
| `src/core/learning.ts` | Bounded route statistics: ratios, streaks, cooldowns, rank penalties, reset |
| `src/core/cache.ts` | TTL caches + deterministic idempotency keys + artifact index |
| `src/core/artifacts/store.ts` | Temp sandboxes → verify → atomic rename promotion; registry; delivery descriptors |
| `src/core/verify/{file,media,index}.ts` | Layered file verification, magic-byte sniffing, ffprobe, moov walk, thread-chain checks |
| `src/core/jobs.ts` | Job state machine (queued→…→completed/partial/failed/cancelled), cancellation, retries, crash recovery |
| `src/core/sessions.ts` | Per-operation execution history (request, attempts, timings, redacted) |
| `src/core/policy.ts` | Access levels, credentials from env/policy, route tag filters |
| `src/core/security/{urlguard,paths,exec}.ts` | SSRF guard, path sandbox + atomic writes, safe subprocess |
| `src/core/http.ts` | Shared hardened HTTP layer (redirect re-validation, byte caps, politeness) |
| `src/core/environment.ts` | Non-sensitive environment profile for route compatibility |
| `src/core/observability.ts` | Structured stderr JSONL logging, secret redaction, traces |
| `src/interfaces/cli.ts` | `uaal` command set |
| `src/interfaces/http/` | Fastify server (`server.ts`) + entrypoint (`serve.ts`) |
| `src/interfaces/mcp/server.ts` | MCP stdio server, 8 tools |
| `src/workers/{protocol,worker}.ts` | HMAC-signed remote-worker protocol + worker client |
| `src/adapters/index.ts` | Adapter registry bootstrap (the only place that knows concrete adapters) |

## 3. The engine pipeline (one operation)

```
run(request, operation)
 1. validate capability                          — unknown → failed INVALID_CAPABILITY
 2. resolveIdentity                              — detection or adapter-local canonicalization
 3. idempotency check (artifact capabilities)    — verified artifact cached? return early
 4. engine-level capabilities (resolve)          — no routes needed
 5. discovery: adapter.discoverRoutes → filter   — capability, enabled, binaries, network,
                                                   local/remote, policy (access level, tags)
 6. ranking                                      — priority + learning score + cooldown penalty,
                                                   deterministic tie-break by id
 7. fallback loop (maxRouteAttempts):
      attempt(route):
        - per-route temp sandbox
        - deadline + AbortSignal (raced against execution)
        - never-raise: exceptions → classified failure
        - artifact promotion through the store   — failing files are deleted, never registered
        - observation recorded (bounded learning)
      if attempt.ok:
        - normalize evidence → NormalizedResource
        - verifyNormalizedResource (schema, identifier consistency, provenance,
          thread-chain integrity, duplicates)
        - verification failure ⇒ record VERIFICATION_FAILURE, continue to next route
        - artifact capabilities require ≥1 verified artifact ⇒ else continue
      success ⇒ envelope(ok) and stop
 8. exhaustion: aggregate failures into the strict status
    (requires_auth / blocked / unsupported / empty / partial / failed)
    with full attempts diagnostics
 9. session record, stats persist, trace
```

### The verification gate is inside the loop

Route success is a claim. Verification failure **demotes the attempt** and the loop continues — so `route A extraction succeeds but fails verification → route B attempted` is the *normal* recovery path, not an edge case.

## 4. Contracts (spec §§66–71)

- **PlatformAdapter**: `detect`, `capabilities`, `limitations`, `discoverRoutes`, `resolveIdentity`, `normalize`, `verify`. Adding a platform = implementing this interface and registering it. Zero core edits.
- **AccessRoute**: `id`, `platform`, `capabilities`, `requirements`, `environmentCompatibility`, `priority`, `enabled`, `accessLevel`, `tags`, `description`, optional `probe`, `execute(request, ctx) → RouteResult`. Routes never raise.
- **Verifier**: composable, method-blind. The file verifier sees only bytes.
- **Evidence**: provenance-preserving (`source`, `type`, `retrievedAt`, `reliability`).
- **Artifact**: identity, checksum, mime, verification status, source route.
- **ExecutionProvider**: `supports(route, env)` + `executeRoute`; `local` implemented, remote-worker protocol ready (`docs/REMOTE_WORKERS.md`).

## 5. Normalization and reconstruction

Adapters combine evidence from independent routes:

- **Conflicts** resolve by declared reliability; conflicts are recorded in `uncertainty.notes` (e.g. `conflict.title`).
- **Unrelated evidence** is rejected by identifier match (`evidence.filtered`).
- **Thread membership** (X) is decided exclusively by the `replying_to_status` data relation — never by walker page order. Walkers are candidate producers only. Unrelated candidates are counted (`relatedFiltered`); unverifiable ancestry stops the walk honestly; degradation is explicit (`degradedToRootOnly`).
- **Absent information is null** and listed in `uncertainty.missing` — never fabricated.

## 6. State layout (spec §60)

```
state/                       UAAL_STATE_DIR
├── route-stats.json         aggregated learning (atomic writes)
├── route-observations.jsonl append-only audit (rotated, bounded)
├── artifact-index.json      idempotency index
├── cache/<ns>/<key>.json    TTL caches
├── jobs/<jobId>.json        per-job state machine records
└── sessions/<sessId>.json   execution history

artifacts/                   UAAL_ARTIFACTS_DIR
├── registry.json            artifact registry (atomic)
└── <artifactId>.<ext>       verified artifacts only
    .tmp/<fp>/<route>/       per-route sandboxes (cleaned up)
```

Everything cross-process is written via temp file + fsync + rename. Learning data is per-environment and gitignored.

## 7. Design rationale

**Why sequential fallback, not parallel fan-out?** Politeness and honest load. Parallel probing exists where the references proved it safe (proxy testing) but route execution stays sequential; routes are independent, so ordering by learned score gives most of the benefit without hammering platforms.

**Why method-blind verification?** A verifier that knows the producing route develops bias (ytagent lesson). Route identity lives in provenance fields, never in the verdict.

**Why data-relational thread reconstruction?** Page order is a heuristic with poisoned candidates (recommendations, media ids). The `replying_to_status` relation is the only truth; page order is a candidate spine only (xthread-agent lesson).

**Why no LLM in the core?** Extraction, routing, validation and verification are deterministic problems (spec §48). An LLM caller can sit above; the engine never requires one.

**Why a single language?** TypeScript everywhere avoids polyglot complexity (spec §47) while yt-dlp/ffmpeg remain subprocess tools with argv-only invocation.

## 8. Reference lineage

| Pattern | Origin |
|---------|--------|
| Never-raise route boundary; per-route sandboxes; verifier-gated promotion; learning ranker with promote/demote; stdout/stderr discipline | ytagent |
| Tiered slots with provenance; candidates vs. membership; 404-as-filter trichotomy; fail-closed gates; explicit-null envelope; politeness budgets | xthread-agent |
| Single dispatch pipeline; durable job/session records; bounded outputs; zod contract-first; structured error codes | agentuse |
