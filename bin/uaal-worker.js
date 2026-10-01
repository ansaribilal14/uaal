#!/usr/bin/env node
/**
 * UAAL remote worker entrypoint (spec §30).
 * Env: UAAL_COORDINATOR_URL, UAAL_WORKER_SECRET
 */
import { UaalWorker } from "../dist/workers/worker.js";

const coordinatorUrl = process.env.UAAL_COORDINATOR_URL;
const secret = process.env.UAAL_WORKER_SECRET;

if (!coordinatorUrl || !secret) {
  process.stderr.write("uaal-worker: UAAL_COORDINATOR_URL and UAAL_WORKER_SECRET are required\n");
  process.exit(2);
}

const worker = new UaalWorker({ coordinatorUrl, secret, logLevel: (process.env.UAAL_LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "info" });
process.on("SIGTERM", () => worker.stop());
process.on("SIGINT", () => worker.stop());
worker.run().catch((err) => {
  process.stderr.write(`uaal-worker: fatal: ${String(err?.message ?? err)}\n`);
  process.exit(1);
});
