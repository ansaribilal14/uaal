# UAAL — Universal Agent Access Layer

**One universal, machine-readable interface for AI agents (and humans) to access, extract and save public web content — from every major platform — with cryptographic verification and honest failure reporting.**

UAAL is a platform-independent access, extraction, reconstruction, verification and acquisition layer. A calling agent says *"I need this resource"* — UAAL handles platform detection, access-route discovery, fallback across independent routes, evidence combination, structural reconstruction, normalization, verification, artifact production and delivery. The agent never needs to know which adapter, route, parser or verifier ran internally.

**v2 is fully self-contained**: YouTube, TikTok, Douyin, X, Instagram, Threads and Reddit work out of the box through built-in public routes — no external downloaders required. `yt-dlp` remains an optional quality upgrade, never a requirement.

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

### One command for humans: the grab wizard

```bash
npm install -g uaal
uaal            # or: npm start, or: uaal grab
```

Guided flow — paste a link (**X / Twitter, YouTube, TikTok, Douyin, Instagram, Threads, Reddit**, or any web page), pick where to save (default storage / Downloads / this folder / custom), press Enter, and watch plain-language progress until **"All set ✅"** with the verified file list. Failures are translated to human reasons; the fail-closed engine underneath never fakes success. Scripted use works too:

```bash
echo "https://www.tiktok.com/@user/video/123" | uaal   # non-interactive, default storage
```

### Machine interface (JSON on stdout, logs on stderr)

```bash
uaal health                  # environment, adapters, dependencies
uaal platforms               # every platform, its link shapes, honest limitations

uaal resolve "https://youtu.be/dQw4w9WgXcQ"
uaal inspect "https://x.com/jack/status/20"
uaal acquire "https://www.tiktok.com/@user/video/123"   # verified mp4, no extra tools
uaal acquire "https://example.com"                      # verified snapshot artifact
```

Machine output is always JSON on **stdout**; logs go to **stderr**.

### Platform notes — Termux (Android)

UAAL runs on Termux with Node >= 20.10 (`pkg install nodejs-lts git`). Optional but recommended:

```bash
pkg install ffmpeg     # enables ffprobe container/stream checks for video artifacts
```

Notes:
- `ffmpeg` is optional. Images verify via magic bytes/dimensions without it; video verification degrades honestly (`ffprobe_unavailable`) instead of failing.
- `yt-dlp` is optional. It unlocks highest-quality YouTube downloads and audio-only extraction; the built-in public mirror routes download video without it.
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

`POST /api/resolve | /api/inspect | /api/acquire | /api/verify`, `GET /api/routes | /api/platforms | /api/capabilities | /api/schema | /api/health`, jobs + cancellation, artifact streaming. See `docs/API.md`.

### As a library (in-process)

```ts
import { UAAL } from "uaal";

const uaal = await UAAL.create({ config: { logLevel: "info" } });

const meta = await uaal.inspect({ resource: "https://x.com/jack/status/20" });
const media = await uaal.acquire({ resource: "https://www.tiktok.com/@user/video/123", capability: "acquire" });
```

See `examples/in-process.ts`.

## Capabilities

`resolve · inspect · metadata · extract · reconstruct · media · acquire · thread · comments · author · media_metadata · artifact · verify`

Not every platform supports every capability; adapters declare what they support and their known limitations. `uaal capabilities` prints the live matrix, `uaal platforms` the per-platform summary.

## Included adapters (v2 — 8 platforms)

| Platform | Independent routes | Notes |
|----------|--------------------|-------|
| **YouTube** | `probe.watch`, `oembed.metadata`, `innertube.metadata` (ANDROID_VR→IOS), `ytdlp.metadata`, `ytdlp.acquire`, `ytdlp.acquire.audio`, `ytdlp.acquire.ios`, `piped.metadata`, `invidious.acquire` (local=true proxy), `piped.acquire` (muxed / ffmpeg mux), `cobalt.acquire` (optional sidecar) | **works with zero extra installs** via mirror routes; yt-dlp upgrades quality; the ytagent method chain is fully integrated |
| **X / Twitter** | `status.metadata` (FixTweet→vxtwitter decoders), `thread.reconstruct` (walker slots + `replying_to_status` chain membership), `media.acquire`, `thread.acquire` | public mirrors only; protected/deleted = fail-closed `empty` |
| **TikTok** | `probe.short` (vm/vt link resolver), `oembed.metadata` (official), `tikwm.metadata`, `tikwm.acquire` (no-watermark mp4 / full slideshow photo set) | videos, photo-mode posts and slideshows; short links resolve automatically |
| **Douyin** | `share.metadata` (`_ROUTER_DATA` parse), `iesdouyin.acquire` (play endpoint, mobile profile), `tikwm.acquire` (mirror) | honest `blocked` on networks where Douyin renders client-side; strong on residential/mobile IPs |
| **Instagram** | `embed.metadata`, `embed.acquire` (official /embed/captioned surface) | the one honest no-auth public surface; login walls = `requires_auth`, never bypassed; stories rejected at identity level |
| **Threads** | `embed.metadata`, `embed.acquire` (official /embed surface) | root posts; JS-shell pages to datacenter IPs surface honestly as `requires_auth` |
| **Reddit** | `public.json.metadata` | official public JSON surface; metadata/comments/media inventory |
| **Generic Web** | `generic-web.opengraph.metadata`, `generic-web.snapshot.acquire` | deterministic OG/Twitter-card/JSON-LD extraction; no JS rendering |

Every route is a structurally independent access path — different endpoints, different failure modes. The failure of one never implies the failure of another. Deep-dive per platform: [`docs/PLATFORMS.md`](docs/PLATFORMS.md).

## Why fail-closed matters

UAAL never manufactures success. A 200 response is treated as a claim; only the verification layer (schema checks, identifier consistency, magic bytes, ffprobe, moov walks, checksums, transfer integrity) turns claims into results. When platforms refuse access (login walls, bot checks, region blocks), UAAL reports `requires_auth` / `blocked` with per-route diagnostics instead of pretending. A JS shell page with no post data is never dressed up as metadata; an unverified download is never promoted.

```
$ uaal acquire https://youtu.be/aqz-KE-bpKQ   # from a blocked environment
{
  "status": "requires_auth",
  "error": { "code": "ALL_ROUTES_EXHAUSTED", "message": "..." },
  "attempts": [
    { "route": "youtube.ytdlp.acquire",       "failureCode": "AUTH_REQUIRED", ... },
    { "route": "youtube.invidious.acquire",   "failureCode": "NETWORK_FAILURE", ... },
    { "route": "youtube.piped.acquire",       "failureCode": "NETWORK_FAILURE", ... }
  ]
}
```

## Security model (summary)

SSRF-guarded DNS resolution on every connect, https + port allowlists, redirect re-validation, path sandboxing with symlink-escape rejection, argv-only subprocess execution with process-group kill, bounded downloads and captures, secret redaction in all logs, optional bearer auth + rate limiting on the HTTP API, HMAC-signed worker protocol. All mirror downloads flow through the same guarded HTTP layer with byte caps and transfer-integrity checks. Full details: `docs/SECURITY.md`.

## Documentation

| Doc | Contents |
|-----|----------|
| [`docs/PLATFORMS.md`](docs/PLATFORMS.md) | per-platform deep dive: routes, link shapes, evidence, limitations, failure modes |
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
npm test        # 217 tests: unit, security, adapter contracts, integration, interfaces
npm run smoke   # offline end-to-end smoke
npm run typecheck && npm run build
```

Live-network spot checks are documented in `docs/CONTRIBUTING.md` and are intentionally not part of CI.

## Attribution

UAAL is a new architecture, generalized from the strongest engineering patterns of three reference systems (methodology, not code):

- [`Bilal140202/ytagent`](https://github.com/Bilal140202/ytagent) — multi-method fallback chain, method-blind verification, learning ranker, atomic state; the YouTube method chain (InnerTube, yt-dlp client profiles, Piped, Invidious local=true proxy, Cobalt sidecar) is UAAL's youtube adapter family
- [`Bilal140202/xthread-agent`](https://github.com/Bilal140202/xthread-agent) — tiered slot pipeline, data-relation chain membership, 404-as-filter, fail-closed gates, versioned envelopes
- [`agentuse/agentuse`](https://github.com/agentuse/agentuse) — single dispatch pipeline, durable sessions, bounded outputs, contract-first config

## License

MIT — see [LICENSE](LICENSE).
