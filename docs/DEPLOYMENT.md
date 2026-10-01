# DEPLOYMENT

## 1. Local (agent workstation)

```bash
git clone https://github.com/ansaribilal14/uaal && cd uaal
npm install && npm run build
node bin/uaal.js health
# optional for YouTube acquisition:
pip install yt-dlp        # ffmpeg recommended too
```

State lives in `./state`, artifacts in `./artifacts` (override with `UAAL_STATE_DIR`, `UAAL_ARTIFACTS_DIR`).

## 2. Library (embed into an agent runtime)

```bash
npm install uaal
```

```ts
import { UAAL } from "uaal";
const uaal = await UAAL.create({ config: { artifactsDir: "/srv/uaal/artifacts" } });
```

## 3. Docker (production, spec §59)

The image bundles Node 22, ffmpeg/ffprobe, yt-dlp, the built CLI/API/MCP and a health check.

```bash
docker build -t uaal .
docker run -d --name uaal \
  -p 7800:7800 \
  -e UAAL_API_KEY=change-me \
  -e UAAL_LOG_LEVEL=info \
  -v uaal-data:/data \
  uaal                       # HTTP API (CMD)
```

Other modes:

```bash
docker run --rm -it -v uaal-data:/data uaal node bin/uaal.js acquire "<url>"
docker run --rm -i uaal node bin/uaal-mcp.js            # MCP stdio (pair with your client)
```

`docker compose up` gives the same with a persistent volume (`docker-compose.yml`).

Health: `GET /api/health` (also wired as the container HEALTHCHECK). Graceful shutdown on SIGTERM/SIGINT; interrupted jobs are recovered as `failed` on restart — never falsely completed.

## 4. Linux server (systemd)

```ini
# /etc/systemd/system/uaal.service
[Unit]
Description=UAAL HTTP API
After=network-online.target

[Service]
WorkingDirectory=/opt/uaal
ExecStart=/usr/bin/node bin/uaal-serve.js
Environment=UAAL_HTTP_PORT=7800
Environment=UAAL_API_KEY=set-a-real-secret
Environment=UAAL_STATE_DIR=/var/lib/uaal/state
Environment=UAAL_ARTIFACTS_DIR=/var/lib/uaal/artifacts
Restart=on-failure
User=uaal

[Install]
WantedBy=multi-user.target
```

## 5. CI runners

UAAL is designed to run inside CI (environment detection marks `ci: true`, learning stays scoped to that environment):

```yaml
- run: npm install && npm run build
- run: node bin/uaal.js acquire "<url>" > artifact-envelope.json
```

Offline safety: `npm test` and `npm run smoke` require no external network; live checks are opt-in.

## 6. Remote workers

For environments where certain routes must run elsewhere (different IP class, missing binaries, restricted egress), deploy workers per `docs/REMOTE_WORKERS.md`:

```bash
UAAL_COORDINATOR_URL=https://uaal.example.com UAAL_WORKER_SECRET=<secret> uaal-worker
```

## 7. Persistent storage & sizing

| Path | Contents | Sizing hint |
|------|----------|-------------|
| `$UAAL_STATE_DIR` | stats, observations (JSONL, rotated), cache, jobs, sessions | tens of MB |
| `$UAAL_ARTIFACTS_DIR` | verified artifacts + registry | media-sized (GBs) — mount a volume |

Both are written atomically (temp + fsync + rename); no lock files are required for single-process operation. Run one engine process per state dir.

## 8. Configuration checklist

- `UAAL_API_KEY` set (HTTP exposed anywhere) 
- `UAAL_MAX_DOWNLOAD_BYTES` tuned to disk
- `UAAL_ATTEMPT_TIMEOUT_MS` / `UAAL_OPERATION_TIMEOUT_MS` tuned to workload
- yt-dlp updated regularly (`pip install -U yt-dlp`) — YouTube changes frequently
- Logs to stderr are JSONL — ship to your structured log pipeline
