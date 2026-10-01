# Production-ready image (spec §59)
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --break-system-packages --no-cache-dir yt-dlp

WORKDIR /app

COPY package.json ./
COPY dist ./dist
COPY bin ./bin
COPY schemas ./schemas
COPY docs ./docs
COPY README.md LICENSE agent.md ./

ENV NODE_ENV=production \
    UAAL_STATE_DIR=/data/state \
    UAAL_ARTIFACTS_DIR=/data/artifacts
VOLUME ["/data"]

# default: HTTP API; override command for CLI/MCP/worker
EXPOSE 7800
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.UAAL_HTTP_PORT||7800) +'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/interfaces/http/serve.js"]
