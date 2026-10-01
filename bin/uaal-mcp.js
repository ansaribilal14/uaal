#!/usr/bin/env node
/**
 * UAAL MCP server entrypoint (stdio). stdout belongs to MCP protocol only.
 */
import { runMcpServer } from "../dist/interfaces/mcp/server.js";

runMcpServer().catch((err) => {
  process.stderr.write(`uaal-mcp: fatal: ${String(err?.message ?? err)}\n`);
  process.exit(1);
});
