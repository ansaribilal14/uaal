# ROUTE_GUIDE

How UAAL finds, ranks, executes and learns about access routes.

## 1. What a route is

A route is **one independent way** of serving one capability for one platform. Independence is the point: different transport (public API vs subprocess), different endpoint (primary vs mirror), different failure modes. ytagent's 13-method chain and xthread-agent's slot tiers are the methodology; `AccessRoute` is the generalization.

```ts
interface AccessRoute {
  id: string;                     // e.g. "youtube.oembed.metadata"
  platform: PlatformId;
  capabilities: Capability[];     // what this route can serve
  requirements: { binaries?, network?, credentials? };
  environmentCompatibility: { local, remote };
  priority: number;               // base ranking (deterministic)
  enabled: boolean;
  accessLevel: "public" | "authorized";
  tags: RouteTag[];               // "official" | "public-mirror" | "subprocess" | ...
  description: string;            // human+machine explanation
  probe?(request, ctx): Promise<ProbeResult>;
  execute(request, ctx): Promise<RouteResult>;  // never raises
}
```

## 2. Discovery (deterministic, explainable)

For every operation the adapter's `discoverRoutes()` produces candidates; the router filters and ranks them, and **every decision is recorded** in `envelope.discovery`:

```json
{
  "id": "youtube.ytdlp.acquire",
  "status": "filtered",
  "confidence": 0.8,
  "priority": 82,
  "reasons": ["missing binaries: yt-dlp"]
}
```

Filter order: capability match → enabled → binaries present → network capability → local/remote compatibility → policy (access level, credentials, tags).

`status`: `available` (eligible) · `filtered` (excluded by a reason) · `disabled` · `probe-failed`.

## 3. Ranking

```
score = priority + learningScore + (inCooldown ? −2.5 : 0)
```

`learningScore` (bounded, see §6): −`rankPenalty` (0..4, grows with failures) + recency bonus when ≥5 recent observations. Ties break by route id — same state, same order, every time.

## 4. Execution

Each attempt runs in isolation:

- **Sandbox**: a per-route temp dir under the artifact store; route outputs are rejected if they escape it (`POLICY_VIOLATION`).
- **Deadline + cancellation**: the attempt timeout and the caller's signal are raced against execution, so routes that ignore aborts still can't hang the loop; timeouts classify as `TIMEOUT`, caller aborts as `CANCELLED`.
- **Never-raise**: a thrown route becomes a classified `RouteResult` failure. The loop cannot crash on a bad plugin.
- **Artifact promotion**: outputs go through the artifact store's verification gate; invalid files are deleted and demote the attempt (`INVALID_ARTIFACT`).

## 5. Failure classification

`src/core/errors.ts` maps raw errors → stable codes that drive fallback behavior:

| Code | Typical source | Retryable | Cooldown-prone |
|------|----------------|-----------|----------------|
| `NETWORK_FAILURE` | DNS/connect/reset | yes | no |
| `TIMEOUT` | deadline exceeded | yes | no |
| `HTTP_ERROR` | 5xx / unexpected | 5xx yes | no |
| `RATE_LIMIT` | 429 | yes (later) | **yes** |
| `AUTH_REQUIRED` | 401/403/login walls | no | no |
| `BLOCKED` | 451-class refusals | no | **yes** |
| `INVALID_RESOURCE` | 404/410, dead resource | no | no |
| `EMPTY_RESULT` | parsed but nothing usable | yes | no |
| `PARSER_FAILURE` | malformed payloads | yes | no |
| `INVALID_ARTIFACT` | verification of a file failed | yes | no |
| `VERIFICATION_FAILURE` | resource verification failed | yes | no |
| `UNSUPPORTED_CAPABILITY` | no adapter/route serves it | no | no |
| `ENVIRONMENT_INCOMPATIBLE` | missing binaries etc. | no | no |
| `DEPENDENCY_FAILURE` | subprocess tool failed | no | no |
| `POLICY_VIOLATION` | sandbox/policy breach | no | no |
| `CANCELLED` | caller abort | no | no |

## 6. Learning (bounded, reversible, non-destructive)

Every attempt appends an observation (JSONL, rotated) and updates per `(route, capability, envClass)` stats:

- `successRatio`, `recentSuccessRatio` (window 20), `avgLatencyMs`, `failureStreak`, failure-type histogram
- `rankPenalty` grows on failure (max 4), shrinks on success — routes **reorder but never disappear**
- **Cooldowns** only for `RATE_LIMIT`/`BLOCKED` after 3 consecutive failures: exponential 30 s → 15 min cap
- Environmental failures never trigger cooldowns (the route isn't at fault)

Learning is optimization, not truth (spec Rule 7): inspect everything with `uaal routes`, wipe with `uaal stats --reset [routeId]`. Policy and safety constraints are never overridden by learned rules.

## 7. Adding routes

See `docs/ADAPTER_GUIDE.md`. Checklist: unique id prefixed by platform, declared capabilities, honest `description`, priority consistent with the platform's chain, tags that reflect transport class, `requirements.binaries` when subprocess-based, and a result produced through `ctx.sink` for anything that touches the filesystem.
