# agent.md — UAAL operating manual for AI agents

This document is written for **you**, an AI agent that wants to use UAAL. You do not need to read the implementation. Everything below describes actual, implemented behavior.

## 1. What UAAL is

UAAL is a tool layer that gives you access to public/authorized web resources (YouTube videos, X/Twitter statuses and threads, Reddit posts, generic web pages) through one universal contract. You provide a **resource URL** and a **capability**. UAAL handles platform detection, access routes, fallback, reconstruction, normalization, verification, and artifact production.

You never need to know which adapter, route, worker, parser, or verifier was used. If a result fails, the envelope tells you exactly what was attempted and why.

**There is no LLM inside UAAL.** Everything is deterministic infrastructure. You sit above it.

## 2. The three ways to call it

| Interface | When to use |
|-----------|-------------|
| **MCP tools** (`uaal_resolve`, `uaal_inspect`, `uaal_acquire`, `uaal_verify`, ...) | You are an MCP client. Recommended default. |
| **CLI** (`uaal inspect <url> ...`) | You can run subprocesses. JSON on stdout, logs on stderr. |
| **HTTP API** (`POST /api/inspect` ...) | You are remote from the UAAL host. |

In-process TypeScript (`import { UAAL } from "uaal"`) exists for agent runtimes embedding UAAL.

## 3. Capabilities

| Capability | Meaning |
|------------|---------|
| `resolve` | Canonical identity only (platform, type, id, canonical URL). Cheapest. |
| `inspect` | What is available without heavy acquisition (metadata). |
| `metadata` | Descriptive metadata (title, author, dates, metrics). |
| `media` | Media inventory (URLs, variants) without downloading. |
| `thread` | Ordered post chain (X self-reply threads). |
| `comments` | Comment tree (Reddit). |
| `author` | Author information. |
| `acquire` | Produce **verified downloadable artifacts**. |
| `verify` | Verify an artifact you already have (`artifactId` or `path`). |

`uaal capabilities` returns the live per-platform support matrix plus documented limitations.

## 4. Status semantics — read this before parsing anything

Every response carries exactly one `status`:

| Status | Meaning | What you should do |
|--------|---------|--------------------|
| `ok` | Requested capability fully satisfied and verified | Use `resource` / `artifacts` |
| `partial` | Some verified content exists; something is missing | Read `available` and `missing` |
| `empty` | The resource genuinely does not exist or exposes nothing (deleted/protected/404-class) | Stop; do not retry |
| `failed` | Routes were tried and none produced a verified result | Read `error.attempts`; retrying later may help if failures are TIMEOUT/RATE_LIMIT |
| `unsupported` | No adapter/route can serve this platform+capability (or required binaries are missing) | Do not retry; use a different capability or install dependencies |
| `requires_auth` | The platform demands authentication | Supply authorized credentials via policy, or stop. **Do not ask UAAL to bypass.** |
| `blocked` | Platform/rate limit refuses this environment | Back off; respect `attempts[].failureCode: RATE_LIMIT` |

A response with `status: "empty"` or `status: "failed"` is still a **valid, well-formed result** — it is honest information, not a tool error.

## 5. Envelope anatomy

```json
{
  "schemaVersion": "1.0",
  "status": "ok",
  "operation": "acquire",
  "request": { "resource": "...", "capability": "acquire", "platform": "x" },
  "identity": { "platform": "x", "type": "thread", "id": "20", "canonicalUrl": "https://x.com/i/web/status/20", "fingerprint": "..." },
  "resource":   { "resource": {...}, "content": {...}, "author": {...}, "media": [...], "relationships": [...], "platformData": {...}, "evidence": [...], "uncertainty": {...} },
  "artifacts":  [ { "artifactId": "art_...", "type": "video", "mimeType": "video/mp4", "size": 21193311, "checksum": "sha256:...", "path": "...", "filename": "...", "verificationStatus": "verified", "media": { "durationSec": ..., "videoCodec": ... } } ],
  "verification": { "verified": true, "checks": [ { "name": "magic_bytes", "passed": true }, { "name": "ffprobe", "passed": true } ] },
  "route":      { "id": "x.media.acquire", "platform": "x", "tags": ["public-mirror"] },
  "attempts":   [ { "route": "...", "status": "failure", "failureCode": "RATE_LIMIT", "message": "..." } ],
  "discovery":  [ { "id": "...", "status": "available|filtered|disabled", "confidence": 0.9 } ],
  "warnings":   ["..."],
  "timing":     { "startedAt": "...", "durationMs": 2961 },
  "traceId":    "..."
}
```

Notes:
- `route` is informational (Rule 11) — do not depend on it for correctness.
- `resource.uncertainty.missing` and `uncertainty.notes` tell you what the reconstruction could not establish. Absent information is `null`/`missing` — never fabricated.
- `attempts` exists for **diagnostics when something fails**. Ignore it on success.

## 6. Artifacts

- Artifacts are produced only after passing file verification (existence, size, magic bytes, container, ffprobe where applicable, checksums). `verificationStatus: "verified"` is authoritative.
- Reference artifacts by `artifactId`. `uaal verify <artifactId|path>` re-verifies on demand.
- Delivery: local `path` (when you run on the same host), HTTP stream via `GET /api/artifacts/:id?download=1`, or metadata + checksum (when you cannot access the filesystem).
- Acquire is **idempotent**: requesting the same resource+capability+output again reuses the same verified artifact (you will see an `idempotent reuse` warning) instead of re-downloading.

## 7. Recipes

**Q: What is this YouTube video?**
```
uaal inspect "https://youtu.be/dQw4w9WgXcQ"
```

**Q: Get this X thread as structured data.**
```
uaal inspect --capability thread "https://x.com/<user>/status/<id>"
```
Read `resource.platformData.thread` (walker stats, degradation flags) and `resource.platformData.posts` (ordered chain). Unrelated posts (recommendations, other-author replies) are already excluded and counted.

**Q: Download the media.**
```
uaal acquire "https://x.com/<user>/status/<id>"
uaal acquire "https://www.youtube.com/watch?v=<id>"        # requires yt-dlp on PATH
```
HLS-only videos are reported honestly (`unavailableReason: "hls_only"`), not half-downloaded.

**Q: Snapshot a web page.**
```
uaal acquire "https://example.com"
```

**Q: Something failed.**
1. Look at `status` → follow the table in §4.
2. Look at `attempts[].failureCode` per route: `TIMEOUT`/`NETWORK_FAILURE`/`RATE_LIMIT` → transient, retry later. `AUTH_REQUIRED` → credentials. `INVALID_RESOURCE` → probably doesn't exist. `ENVIRONMENT_INCOMPATIBLE`/`DEPENDENCY_FAILURE` → install the missing binary (e.g. yt-dlp).
3. `uaal routes <url>` shows live discovery and per-route learned statistics.

**Q: How do I know the file I got is intact?**
`verification.checks` lists every check that ran (names: `size_min`, `size_complete`, `not_html`, `kind_matches`, `container_valid`, `duration_valid`, `streams_present`, `moov_integrity`, `checksum`). Re-verify anytime with `uaal verify <artifactId>`.

## 8. Configuration quick reference

Environment variables: `UAAL_STATE_DIR`, `UAAL_ARTIFACTS_DIR`, `UAAL_LOG_LEVEL`, `UAAL_ATTEMPT_TIMEOUT_MS`, `UAAL_OPERATION_TIMEOUT_MS`, `UAAL_MAX_DOWNLOAD_BYTES`, `UAAL_LEARNING=0` (disable learning), `UAAL_CACHE=0`, `UAAL_API_KEY` (HTTP auth), `UAAL_CREDENTIAL_*` (authorized access). See `.env.example`.

## 9. Hard boundaries (do not ask for these)

- UAAL does not bypass authentication, paywalls, or platform access controls.
- UAAL does not scrape private/protected content; such resources yield `empty`/`requires_auth`.
- UAAL does not accept credentials over the default HTTP API body.
- Machine output goes to stdout, logs to stderr; exit codes: `0` ok/partial, `4` empty, `1` failed/unsupported/requires_auth/blocked, `2` usage error.
