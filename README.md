# UAAL — Universal Agent Access Layer

**One universal, machine-readable interface for AI agents to access public and authorized web resources.**

UAAL is a platform-independent access, extraction, reconstruction, verification and acquisition layer. A calling agent says *"I need this resource"* — UAAL handles platform detection, access-route discovery, fallback across independent routes, evidence combination, structural reconstruction, normalization, verification, artifact production and delivery. The agent never needs to know which adapter, route, parser or verifier ran internally.

```
ANY COMPATIBLE AGENT
        ↓
UNIVERSAL INTERFACE          CLI · HTTP API · MCP · in-process
        ↓
RESOURCE + CAPABILITY
        ↓
DISCOVERY → ROUTE SELECTION → MULTI-ROUTE EXECUTION
        ↓
EVIDENCE → RECONSTRUCTION → NORMALIZATION → VERIFICATION
        ↓
ARTIFACT → AGENT
```

---

## Design rules (enforced in code)

| # | Rule |
|---|------|
| 1 | One platform ≠ one access method — every platform gets several independent routes |
| 2 | One failed method ≠ failed resource — the fallback engine tries the next route |
| 3 | HTTP success ≠ resource success — responses are only *claims* |
| 4 | Downloaded file ≠ verified artifact — a method-blind verifier gates promotion |
| 5 | Parsed response ≠ reconstructed truth — chain membership comes from data relations, not page order |
| 6 | LLM reasoning ≠ deterministic infrastructure — the core requires **no LLM** |
| 7 | Learning ≠ permanent truth — learning reorders routes, never removes them |
| 8 | Partial result ≠ total failure — `partial` is a first-class status |
| 9 | Unknown ≠ success — fail closed |
| 10 | If all viable routes fail, **fail honestly** (`requires_auth`, `blocked`, `empty`, `failed`) |

Every operation returns exactly one strict status: `ok | partial | empty | failed | unsupported | requires_auth | blocked`.

## Install & quickstart

### One command for humans: `uaal` (grab wizard)

```bash
uaal            # or: npm start, or: uaal grab
```

Guided flow — paste a link (X/Twitter, YouTube, Reddit, Threads, Instagram, or
any web page), pick where to save (default storage / Downloads / this folder /
custom), press Enter, and watch plain-language progress until **"All set ✅"**
with the verified file list. Failures are translated to human reasons; the
fail-closed engine underneath never fakes success. Scripted use works too:

```bash
echo "https://x.com/user/status/123" | uaal   # non-interactive, default storage
```

### Machine interface (JSON on stdout, logs on stderr)

```bash
npm install -g uaal          # or: npm install uaal (library)
uaal health                  # environment, adapters, dependencies

uaal resolve "https://youtu.be/dQw4w9WgXcQ"
uaal inspect "https://x.com/jack/status/20"
uaal acquire "https://example.com"          # verified snapshot artifact
uaal acquire "https://www.youtube.com/watch?v=..."   # requires yt-dlp on PATH
```

Machine output is always JSON on **stdout**; logs go to **stderr**.

### Platform notes — Termux (Android)

UAAL runs on Termux with Node >= 20.10 (`pkg install nodejs-lts git`). Optional but recommended:

```bash
pkg install ffmpeg     # enables ffprobe container/stream checks for video artifacts
```

Notes:
- `ffmpeg` is optional. Images verify via magic bytes/dimensions without it; video verification degrades honestly (`ffprobe_unavailable`) instead of failing.
- If npm warns about `allow-scripts` for esbuild (a vitest dev-dependency) and `npm test` later fails with an esbuild binary error, approve and rebuild once: `npm install-scripts approve esbuild && npm rebuild esbuild`. Building the CLI (`npm run build`) and running it never need esbuild.
- npm audit findings in the dev chain (test runner only) never affect the shipped CLI.

### As an MCP server (Claude, and any MCP client)

```bash
uaal mcp
```

Exposes `uaal_resolve`, `uaal_inspect`, `uaal_acquire`, `uaal_verify`, `uaal_routes`, `uaal_capabilities`, `uaal_schema`, `uaal_health` with strict input schemas. See `docs/MCP.md` and `examples/mcp-config.json`.

### As an HTTP API

```bash
uaal serve --port 7800
# or: docker compose up
```

`POST /api/resolve | /api/inspect | /api/acquire | /api/verify`, `GET /api/routes | /api/capabilities | /api/schema | /api/health`, jobs + cancellation, artifact streaming. See `docs/API.md`.

### As a library (in-process)

```ts
import { UAAL } from "uaal";

const uaal = await UAAL.create({ config: { logLevel: "info" } });

const meta = await uaal.inspect({ resource: "https://x.com/jack/status/20" });
const media = await uaal.acquire({ resource: "https://example.com", capability: "acquire" });
```

See `examples/in-process.ts`.

## Capabilities

`resolve · inspect · metadata · extract · reconstruct · media · acquire · thread · comments · author · media_metadata · artifact · verify`

Not every platform supports every capability; adapters declare what they support and their known limitations. `uaal capabilities` prints the live matrix.

## Included adapters (v1)

| Platform | Routes (independent access methods) | Notes |
|----------|-------------------------------------|-------|
| **YouTube** | `probe.watch`, `oembed.metadata`, `innertube.metadata` (ANDROID_VR→IOS), `ytdlp.metadata`, `ytdlp.acquire`, `ytdlp.acquire.audio`, `ytdlp.acquire.ios`, `piped.metadata` | media acquisition needs `yt-dlp`; datacenter-IP bot walls surface as `requires_auth` |
| **X / Twitter** | `status.metadata` (FixTweet→vxtwitter decoders), `thread.reconstruct` (walker slots + `replying_to_status` chain membership), `media.acquire`, `thread.acquire` | public mirrors only; protected/deleted = fail-closed `empty` |
| **Reddit** | `public.json.metadata` | official public JSON surface; metadata/comments/media inventory |
| **Generic Web** | `generic-web.opengraph.metadata`, `generic-web.snapshot.acquire` | deterministic OG/Twitter-card/JSON-LD extraction; no JS rendering |

Instagram, TikTok, Facebook, Telegram are **not** implemented and not faked — the adapter registry, contract tests and `docs/ADAPTER_GUIDE.md` make adding them a plugin exercise, not a core rewrite.

## Why fail-closed matters

UAAL never manufactures success. A 200 response is treated as a claim; only the verification layer (schema checks, identifier consistency, magic bytes, ffprobe, moov walks, checksums, transfer integrity) turns claims into results. When platforms refuse access (login walls, bot checks, region blocks), UAAL reports `requires_auth` / `blocked` with per-route diagnostics instead of pretending.

```
$ uaal acquire https://youtu.be/aqz-KE-bpKQ   # from a datacenter IP
{
  "status": "requires_auth",
  "error": { "code": "ALL_ROUTES_EXHAUSTED", "message": "..." },
  "attempts": [
    { "route": "youtube.ytdlp.acquire",       "failureCode": "AUTH_REQUIRED", ... },
    { "route": "youtube.ytdlp.acquire.audio", "failureCode": "AUTH_REQUIRED", ... },
    { "route": "youtube.ytdlp.acquire.ios",   "failureCode": "AUTH_REQUIRED", ... }
  ]
}
```

## Security model (summary)

SSRF-guarded DNS resolution on every connect, https + port allowlists, redirect re-validation, path sandboxing with symlink-escape rejection, argv-only subprocess execution with process-group kill, bounded downloads and captures, secret redaction in all logs, optional bearer auth + rate limiting on the HTTP API, HMAC-signed worker protocol. Full details: `docs/SECURITY.md`.

## Documentation

| Doc | Contents |
|-----|----------|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | modules, contracts, data flow, design rationale |
| [`docs/ROUTE_GUIDE.md`](docs/ROUTE_GUIDE.md) | discovery, ranking, fallback, failure classification, learning |
| [`docs/ADAPTER_GUIDE.md`](docs/ADAPTER_GUIDE.md) | how to add a platform adapter (zero core changes) |
| [`docs/API.md`](docs/API.md) | HTTP endpoints, envelopes, jobs, artifact delivery |
| [`docs/MCP.md`](docs/MCP.md) | MCP tools and schemas |
| [`docs/CLI.md`](docs/CLI.md) | commands, flags, exit codes |
| [`docs/SECURITY.md`](docs/SECURITY.md) | threat model and controls |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | local, Docker, servers, CI |
| [`docs/REMOTE_WORKERS.md`](docs/REMOTE_WORKERS.md) | worker protocol, signing, coordinator API |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | workflow and standards |
| [`agent.md`](agent.md) | the operating manual for AI agents |

## Testing

```bash
npm test        # 149 tests: unit, security, adapter contracts, integration, interfaces
npm run smoke   # offline end-to-end smoke
npm run typecheck && npm run build
```

Live-network spot checks are documented in `docs/CONTRIBUTING.md` and are intentionally not part of CI.

## Attribution

UAAL is a new architecture, generalized from the strongest engineering patterns of three reference systems (methodology, not code):

- [`Bilal140202/ytagent`](https://github.com/Bilal140202/ytagent) — multi-method fallback chain, method-blind verification, learning ranker, atomic state
- [`Bilal140202/xthread-agent`](https://github.com/Bilal140202/xthread-agent) — tiered slot pipeline, data-relation chain membership, 404-as-filter, fail-closed gates, versioned envelopes
- [`agentuse/agentuse`](https://github.com/agentuse/agentuse) — single dispatch pipeline, durable sessions, bounded outputs, contract-first config

## License

MIT — see [LICENSE](LICENSE).
