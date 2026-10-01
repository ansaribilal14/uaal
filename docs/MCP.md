# MCP

UAAL ships a stdio MCP server exposing the universal contract as strict, self-describing tools (spec §21, §45).

## Run it

```bash
uaal mcp                 # or: node bin/uaal-mcp.js after a build
```

Client config (Claude Desktop / any MCP client):

```json
{
  "mcpServers": {
    "uaal": { "command": "npx", "args": ["-y", "uaal", "mcp"] }
  }
}
```

`stdout` carries only the MCP protocol; UAAL logs go to stderr (level via `UAAL_LOG_LEVEL`, default `warn` in MCP mode).

## Tools

Every tool description states purpose, inputs, outputs, errors, side effects and artifact behavior. Inputs are strict zod-derived JSON Schemas; unknown arguments are rejected.

| Tool | Purpose | Inputs | Side effects |
|------|---------|--------|--------------|
| `uaal_resolve` | Canonical identity (platform/type/id/URL). Cheapest; may expand shortlinks over the network. | `resource` (required), `platform?`, `capability?`, `format?`, `maxBytes?` | none |
| `uaal_inspect` | Availability + metadata without heavy acquisition. | same | none |
| `uaal_acquire` | Produce **verified** artifacts. Idempotent: repeats reuse the same verified artifact (visible via warnings). | same | writes artifact store files |
| `uaal_verify` | Re-verify an artifact. | `artifactId?` or `path?` | none |
| `uaal_routes` | Route registry + learned statistics. | — | none |
| `uaal_capabilities` | Capability matrix + per-platform limitations. | — | none |
| `uaal_schema` | JSON Schemas for all response contracts. | — | none |
| `uaal_health` | Non-destructive health: adapters, routes, storage, dependencies. | — | none |

## Output contract

Tool results are JSON envelopes (see `agent.md` §5). Status is honest: `ok | partial | empty | failed | unsupported | requires_auth | blocked`. A failed acquisition is **not** an MCP `isError` unless the call itself was malformed — an exhausted fallback chain is a *successful diagnostic* about a failed acquisition, and the envelope explains why (per-route attempts).

## Schemas

Call `uaal_schema` (or `GET /api/schema`) to receive JSON Schemas for `Envelope`, `NormalizedResource`, `Artifact`, `VerificationResult`, `ResourceIdentity`, `AttemptRecord`, `DiscoveredRoute` — validate responses yourself without trusting prose. The same schemas are checked in at `schemas/uaal.schema.json`.
