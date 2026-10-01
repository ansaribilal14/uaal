# API (HTTP)

Base: `http://127.0.0.1:7800` (configurable via `UAAL_HTTP_PORT`, `--host`).
Auth: when `UAAL_API_KEY` is set, every endpoint except `GET /api/health` requires `Authorization: Bearer <key>`. Rate limiting: token bucket per IP (default 60 req/min); 429 on excess.

All request/response bodies are JSON. Every response envelope carries `schemaVersion: "1.0"` and the strict status model (`ok | partial | empty | failed | unsupported | requires_auth | blocked`). Errors: `{ "status": "failed", "error": { "code", "message" } }`.

## Operations

### POST /api/resolve
`{ "resource": "<url>", "platform"?: "youtube", "requestId"?: "..." }` → identity envelope (canonical platform/type/id/URL + fingerprint). Cheapest operation.

### POST /api/inspect
`{ "resource": "<url>", "capability"?: "metadata" }` → normalized metadata without heavy acquisition.

### POST /api/plan (dry-run, spec §51)
→ identity + live route discovery + policy/environment notes. **Executes nothing.**

### POST /api/acquire
```json
{
  "resource": "<url>",
  "capability": "acquire",
  "output": { "format": ["video"], "maxBytes": 500000000 },
  "async": false,
  "timeoutMs": 300000,
  "maxRetries": 0
}
```

- Synchronous (default) → result envelope with verified `artifacts[]`.
- `"async": true` → `202 { "jobId", "state": "queued", "poll": "/api/jobs/<id>" }` (spec §31).

Credentials are never accepted from HTTP bodies; supply authorized access server-side via `UAAL_CREDENTIAL_*`.

### POST /api/verify
`{ "artifactId": "art_..." }` or `{ "path": "/data/artifacts/..." }` → verification result with named checks.

## Introspection

| Endpoint | Returns |
|----------|---------|
| `GET /api/routes` | route stats (ratios, streaks, cooldowns) + adapter registry + limitations |
| `GET /api/capabilities` | capability registry + per-platform support matrix |
| `GET /api/schema` | JSON Schemas for all contracts (spec §40) |
| `GET /api/health` | core, environment, adapters, route health, storage, dependencies (ffmpeg/ffprobe/yt-dlp) — non-destructive |
| `GET /api/sessions?limit=20` | recent execution history (redacted) |

## Jobs (async acquisition)

| Endpoint | Description |
|----------|-------------|
| `GET /api/jobs/:id` | job record: state (`queued→probing→executing→verifying→completed/partial/failed/cancelled`), attempts, result envelope |
| `POST /api/jobs/:id/cancel` | cancellation propagates through the engine into routes/subprocesses/downloads |

Interrupted jobs (process crash) are recovered as `failed` on startup — never falsely completed (spec §61).

## Artifacts

| Endpoint | Description |
|----------|-------------|
| `GET /api/artifacts/:id` | delivery metadata: type, mime, size, `sha256:...` checksum, filename, `streamUrl`; local paths are **not** exposed unless local |
| `GET /api/artifacts/:id?download=1` | streams the verified bytes (`Content-Type`, `Content-Length`, `Content-Disposition`) |

## Streaming notes

Responses are JSON. Artifact bytes are streamed on demand via the download endpoint; the engine never assumes the caller can read its filesystem (spec §19).

## Timeouts & limits

- Request timeout: 300 s (server-level), operation timeout from config (`UAAL_OPERATION_TIMEOUT_MS`), per-attempt timeout from `policy.attemptTimeoutMs`.
- Body limit: 2 MiB. Download cap: `UAAL_MAX_DOWNLOAD_BYTES` (default 2 GiB).

## Example session

```bash
export UAAL_API_KEY=secret
curl -s -X POST localhost:7800/api/inspect -H "authorization: Bearer $UAAL_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"resource":"https://x.com/jack/status/20"}' | jq .status          # ok

curl -s -X POST localhost:7800/api/acquire -H "authorization: Bearer $UAAL_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"resource":"https://example.com","async":true}' | jq              # 202 + jobId
```
