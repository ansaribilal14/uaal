/**
 * HTTP API server entrypoint (spec §23, §59): used by the Docker image and
 * `bin/uaal-serve.js`. Graceful shutdown handled inside buildHttpServer.
 */
import { startHttpServer } from "./server.js";
import type { UAALConfig } from "../../core/contracts.js";

function numEnv(name: string): number | undefined {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

const config: UAALConfig = {
  stateDir: process.env.UAAL_STATE_DIR ?? (process.env.UAAL_HOME ? `${process.env.UAAL_HOME}/state` : undefined),
  artifactsDir: process.env.UAAL_ARTIFACTS_DIR,
  attemptTimeoutMs: numEnv("UAAL_ATTEMPT_TIMEOUT_MS"),
  operationTimeoutMs: numEnv("UAAL_OPERATION_TIMEOUT_MS"),
  maxDownloadBytes: numEnv("UAAL_MAX_DOWNLOAD_BYTES"),
  logLevel: (process.env.UAAL_LOG_LEVEL as UAALConfig["logLevel"]) ?? "info",
  apiToken: process.env.UAAL_API_KEY
};

startHttpServer(config, { port: numEnv("UAAL_HTTP_PORT") ?? 7800, host: process.env.UAAL_HTTP_HOST ?? "0.0.0.0" })
  .then(({ url }) => {
    process.stderr.write(`uaal-http: listening on ${url}\n`);
  })
  .catch((err) => {
    process.stderr.write(`uaal-http: fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
