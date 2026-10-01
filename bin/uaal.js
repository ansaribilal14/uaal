#!/usr/bin/env node
/**
 * UAAL CLI entrypoint. stdout = machine output, stderr = logs.
 */
import { runCli } from "../dist/interfaces/cli.js";

runCli(process.argv).catch((err) => {
  // never leak secrets; never pollute stdout with errors
  process.stderr.write(`uaal: fatal: ${String(err?.message ?? err).replace(/(ghp?_[A-Za-z0-9]{16,}|Bearer\s+\S+)/g, "[REDACTED]")}\n`);
  process.exit(2);
});
