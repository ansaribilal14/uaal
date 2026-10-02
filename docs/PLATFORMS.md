# Platforms — the complete v2 matrix

UAAL v2 ships **eight platform adapters**. Every adapter follows the same contract: detect → resolve identity → discover routes → execute with fallback → normalize → verify → deliver artifacts. Every route is a *structurally independent* access path: different endpoints, different parsers, different failure modes. When a route fails, the engine tries the next; when all fail, the failure is honest (`requires_auth` / `blocked` / `empty` / `failed`) — never fabricated success.

Quick reference from the CLI: `uaal platforms` (link shapes + limitations) and `uaal routes <url>` (live discovery for a specific link).

---

## YouTube

**Link shapes**

- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://www.youtube.com/shorts/VIDEO_ID`
- `https://music.youtube.com/watch?v=VIDEO_ID`

**Routes (priority order)**

| Route | Priority | What it does | Failure modes it carries |
|-------|----------|--------------|--------------------------|
| `youtube.probe.watch` | 100 | zero-media reachability preflight (rate limit / login wall / dead) | `RATE_LIMIT`, `AUTH_REQUIRED`, `INVALID_RESOURCE` |
| `youtube.oembed.metadata` | 90 | official oEmbed: title, channel, thumbnail; 401/404 is a filter signal, not a retry | `INVALID_RESOURCE` (unavailable) |
| `youtube.innertube.metadata` | 85 | InnerTube player API with unauthenticated mobile clients (ANDROID_VR → IOS): description, duration, views, stream inventory | `AUTH_REQUIRED` (playability), `RATE_LIMIT` |
| `youtube.ytdlp.metadata` | 80 | `yt-dlp --dump-single-json` (android_vr profile) — requires `yt-dlp` | `ENVIRONMENT_INCOMPATIBLE` when absent |
| `youtube.ytdlp.acquire` | 82 | `yt-dlp` download (progressive mp4 preference) — requires `yt-dlp` | same as above |
| `youtube.ytdlp.acquire.audio` | 74 | audio-only salvage (bestaudio m4a) — requires `yt-dlp` | same |
| `youtube.ytdlp.acquire.ios` | 68 | iOS client profile (HLS) — structurally independent signature path | same |
| `youtube.piped.metadata` | 55 | Piped public API instances (`/streams/{id}`), instance rotation | `RATE_LIMIT`, `NETWORK_FAILURE` |
| `youtube.invidious.acquire` | 64 | **Invidious `local=true` proxy** (itag 18, 360p muxed mp4): the instance fetches from googlevideo with its own IP and re-serves the stream — the known bypass when the local IP is blocked | instance rotation with per-instance reasons |
| `youtube.piped.acquire` | 62 | Piped acquisition: highest-quality muxed stream, or video+audio muxed via `ffmpeg` when installed | `ENVIRONMENT_INCOMPATIBLE` (ffmpeg needed for mux) |
| `youtube.cobalt.acquire` | 70 | optional self-hosted [Cobalt](https://github.com/imputnet/cobalt) sidecar: `redirect`, `tunnel`, `local-processing` responses; ffmpeg mux when needed | only active when configured (below) |

**Self-containment**: without any external binary, acquisition falls back to `invidious.acquire` / `piped.acquire` — verified MP4 from public mirrors. With `yt-dlp` installed, higher qualities and audio-only unlock automatically. With `ffmpeg` installed, Piped separate-stream muxing activates.

**Optional Cobalt sidecar** — enable by either:

```bash
export UAAL_COBALT_URL="http://127.0.0.1:9000"   # or:
# config.json: { "adapters": { "youtube": { "cobaltUrl": "http://127.0.0.1:9000" } } }
```

The route fast-fails with `ENVIRONMENT_INCOMPATIBLE` if the sidecar is unreachable — it never hangs the chain.

**Honest walls**: datacenter IPs frequently hit YouTube's bot wall (`requires_auth`). The mirror routes exist precisely for that case.

---

## X / Twitter

**Link shapes**: `https://x.com/{user}/status/{id}`, `https://twitter.com/{user}/status/{id}`, `t.co` redirects.

**Routes**

| Route | Priority | What it does |
|-------|----------|--------------|
| `x.status.metadata` | 90 | public decoder mirrors (FixTweet → vxtwitter fallback): text, author, media inventory, engagement |
| `x.thread.reconstruct` | 85 | thread chain reconstruction: walker slots + `replying_to_status` data-relation membership (never page order) |
| `x.media.acquire` | 82 | downloads pbs.twimg.com media (progressive JPEG/PNG, mp4 variants) into verified artifacts |
| `x.thread.acquire` | 80 | whole-thread acquisition: per-status media + a `thread_manifest.json` |

**Honest walls**: protected accounts, deleted posts and age-gated media fail closed with `empty` / `requires_auth`.

---

## TikTok

**Link shapes**

- `https://www.tiktok.com/@user/video/{id}`
- `https://www.tiktok.com/@user/photo/{id}` (photo-mode post)
- `https://vm.tiktok.com/{code}/`, `https://vt.tiktok.com/{code}/`, `https://www.tiktok.com/t/{code}` (short links — resolved via one redirect-following GET)
- `https://m.tiktok.com/v/{id}.html` (legacy mobile share)

**Routes**

| Route | Priority | What it does |
|-------|----------|--------------|
| `tiktok.probe.short` | 95 | short-link resolver + reachability probe (zero media bytes) |
| `tiktok.oembed.metadata` | 90 | official oEmbed: caption, author, thumbnail; 404 = honest filter |
| `tiktok.tikwm.metadata` | 85 | tikwm.com public mirror: caption, author, duration, engagement, full media inventory |
| `tiktok.tikwm.acquire` | 80 | acquisition: watermark-free MP4 (hd → sd → watermark fallback chain) or the **complete slideshow photo set** + cover |

**Evidence & verification**: every download streams through the SSRF-guarded HTTP layer with byte caps; MP4s verify via magic bytes (+ ffprobe when available), JPEGs via magic bytes and dimension parse. Slideshows produce one artifact per image — partial sets return `partial`, never fake full success.

**Honest walls**: age-gated / region-locked / private posts fail with `INVALID_RESOURCE` or `requires_auth`. The mirror occasionally rate-limits (`RATE_LIMIT`, retryable).

---

## Douyin (抖音)

**Link shapes**

- `https://www.douyin.com/video/{id}`, `https://www.douyin.com/note/{id}`
- `https://v.douyin.com/{code}/` (short links — resolved automatically)

**Routes**

| Route | Priority | What it does |
|-------|----------|--------------|
| `douyin.share.metadata` | 85 | iesdouyin.com mobile share page; parses the embedded `window._ROUTER_DATA` JSON (description, author, play_addr, cover, statistics) |
| `douyin.iesdouyin.acquire` | 82 | direct acquisition: share-page play_addr → `iesdouyin.com/aweme/v1/play` mobile endpoint → verified MP4 + cover |
| `douyin.tikwm.acquire` | 80 | mirror-mediated acquisition (works when the mirror's douyin support is up) |

**Environment sensitivity (documented honestly)**: Douyin renders the item record client-side for some networks (especially datacenter IPs). On those networks the routes fail with `blocked` and a clear explanation — they never guess. On residential/mobile networks (e.g. Termux on a phone) the share page server-renders the data and the full pipeline works.

---

## Instagram

**Link shapes**

- `https://www.instagram.com/p/{shortcode}/`
- `https://www.instagram.com/reel/{shortcode}/`, `/tv/{shortcode}/`
- `https://www.instagram.com/{username}/p/{shortcode}/` (username-prefixed)
- `…/stories/…` links are rejected at the identity layer — stories are auth-walled and never pretended.

**Routes**

| Route | Priority | What it does |
|-------|----------|--------------|
| `instagram.embed.metadata` | 85 | the official `/embed/captioned/` page: caption, username, display_url images, video_url when exposed |
| `instagram.embed.acquire` | 78 | downloads the video MP4 (reels) or the exposed image set into verified artifacts |

**Honest walls**: Instagram aggressively login-walls everything beyond the embed surface. Login redirects and JS shells surface as `requires_auth` — UAAL never bypasses them. Datacenter IPs are usually walled; residential/mobile IPs frequently succeed.

---

## Threads

**Link shapes**: `https://www.threads.net/@{user}/post/{id}` (also `threads.com`).

**Routes**

| Route | Priority | What it does |
|-------|----------|--------------|
| `threads.embed.metadata` | 85 | official `/embed` page: post text, author, CDN media URLs |
| `threads.embed.acquire` | 78 | downloads the video MP4 or image set into verified artifacts |

**Parser honesty**: JS shell pages (bare `<title>Threads</title>` with no post data) parse to *nothing* and surface as `requires_auth` — a shell is never dressed up as metadata. Media URLs come from Meta's CDN and expire quickly; acquire soon after discovery.

---

## Reddit

**Link shapes**: `https://www.reddit.com/r/{sub}/comments/{id}/…`, `https://v.redd.it/{id}`, `redd.it/{id}`.

**Routes**: `reddit.public.json.metadata` — official public JSON (`/comments/{id}.json`): post metadata, selftext, comment tree (top-level, limit 100), media inventory (preview images, galleries, reddit_video with an honest `hls_dash_only` unavailability note).

**Honest walls**: Reddit aggressively 403s some datacenter IPs; that surfaces as `blocked`/`RATE_LIMIT` with per-route diagnostics.

---

## Generic Web

**Link shapes**: any http(s) URL not claimed by a platform adapter (registry fallback, zero core coupling).

**Routes**: `generic-web.opengraph.metadata` (OG / Twitter-card / JSON-LD deterministic extraction), `generic-web.snapshot.acquire` (verified HTML snapshot artifact).

---

## Status semantics across all platforms

| Status | Meaning |
|--------|---------|
| `ok` | every requested capability satisfied; artifacts verified |
| `partial` | some work done (e.g. 5 of 7 slideshow images verified) — always with explicit `warnings` |
| `empty` | resource does not exist / is gone (the 404-as-filter trichotomy: *not-found ≠ error*) |
| `requires_auth` | an access wall was hit; UAAL does not bypass it |
| `blocked` | the network/environment was refused (bot checks, client-side-only rendering) |
| `failed` | infrastructure/parser/verification failures after all routes |
| `unsupported` | no registered route serves the capability |

Each response carries `attempts[]` — the per-route audit trail (route, duration, failure code, message) — plus a `traceId` for support and post-mortems.
