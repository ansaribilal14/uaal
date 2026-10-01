# CLI

`uaal` — machine-readable JSON on **stdout**, structured logs on **stderr** (mandatory separation, spec §22).

Exit codes: `0` ok/partial · `4` empty · `1` failed/unsupported/requires_auth/blocked · `2` usage/fatal.

## Commands

| Command | Description |
|---------|-------------|
| `uaal resolve <url>` | Canonical identity (platform, type, id, canonical URL, fingerprint) |
| `uaal inspect <url>` | Availability + metadata without heavy acquisition |
| `uaal acquire <url>` | Verified artifact production (media, snapshots, manifests) |
| `uaal verify <artifactId\|path>` | Re-verify an artifact |
| `uaal routes [url]` | Route registry, learned stats; with a URL also live discovery |
| `uaal capabilities` | Capability registry + per-platform support |
| `uaal schema` | Export JSON Schemas for all contracts |
| `uaal health` | Non-destructive system health |
| `uaal sessions [--limit N]` | Recent execution history |
| `uaal stats [--reset [routeId]]` | Inspect / reset bounded route learning |
| `uaal mcp` | Run the MCP server on stdio |
| `uaal serve [--port N] [--host H]` | Run the HTTP API server |
| `uaal --version` | Version |

## Shared flags (resolve/inspect/acquire)

| Flag | Effect |
|------|--------|
| `--platform <p>` | Force platform (skips detection) |
| `--capability <c>` | Override capability (e.g. `--capability thread`) |
| `--format <f[,f]>` | Output format hints (`video,audio`) |
| `--max-bytes <n>` | Artifact size cap |
| `--timeout <ms>` | Per-attempt timeout override |
| `--dry-run` | Discovery + plan only — executes nothing (spec §51) |
| `--verbose` | Debug logging to stderr (spec §50) |
| `--request-id <id>` | Caller correlation id (echoed in the envelope) |

## Examples

```bash
# canonical identity of any URL shape
uaal resolve "https://m.youtube.com/watch?vi=dQw4w9WgXcQ"

# thread reconstruction
uaal inspect --capability thread "https://x.com/<user>/status/<id>"

# acquire audio only, capped at 200 MB, 60s per attempt
uaal acquire "https://www.youtube.com/watch?v=<id>" --format audio --max-bytes 200000000 --timeout 60000

# what WOULD happen (routes, policy, environment) without touching the network paths
uaal acquire "https://example.com" --dry-run

# debug a failure
uaal acquire "<url>" --verbose 2>uaal.log; cat uaal.log | jq -s 'map(select(.level=="error"))'
```

## Machine consumption pattern

```bash
out=$(uaal acquire "<url>" 2>/dev/null); code=$?
status=$(echo "$out" | jq -r .status)
case $code in
  0) echo "$out" | jq -r '.artifacts[0].path' ;;
  4) echo "resource does not exist" ;;
  *) echo "$out" | jq -r '.error.message' ;;
esac
```
