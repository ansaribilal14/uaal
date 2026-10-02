# SECURITY

UAAL's job is access to *public and authorized* resources. It is designed to be safe to run as an agent tool: untrusted input (URLs, remote payloads, downloaded bytes, filenames) is validated at every boundary, and the system fails closed.

## Threat model

| Threat | Control |
|--------|---------|
| **SSRF** (agent-supplied URLs probing internal networks) | `assertPublicUrl`: https-only, standard-port allowlist, credential-in-URL rejection, metadata-hostname blocklist. DNS resolution is validated **on every connect** through a custom undici lookup — every resolved address must be public, which also defeats DNS rebinding. Redirects are followed manually with per-hop re-validation (max 5). |
| **DNS rebinding** | The validating lookup runs inside the connection pool for every new connect; a hostname that flips to a private address mid-session is refused. |
| **Path traversal / arbitrary file writes** | Route outputs may only exist inside per-route sandboxes under the artifact store; `resolveWithin` + symlink-escape checks (`assertInsideRoot`); filenames pass `sanitizeFilename` (basename, control chars, `..`, separators). Remote ids used in filenames are digits-only validated. |
| **Command injection / shell interpolation** | `safeExec`: argv arrays only, never a shell; minimal env allowlist (PATH/HOME/TMPDIR/…); detached process groups with SIGTERM→SIGKILL so timeouts and cancellation leave **no orphan processes**. |
| **Memory / disk exhaustion** | Hard byte caps on HTTP bodies (default 20 MiB, configurable), downloads (`UAAL_MAX_DOWNLOAD_BYTES`), subprocess stdout/stderr capture (2 MiB), bounded logs/JSONL rotation, bounded caches and stats windows. |
| **Slow-loris / truncated transfers** | Deadlines on every request and every attempt; Content-Length equality checks; truncated files are deleted, never promoted. |
| **Zip bombs / oversized archives** | Archives are detected by magic bytes and treated as opaque artifacts with size caps; no automatic extraction. |
| **Symlink attacks** | Symlinks inside artifact paths are rejected or must resolve within the root; temp files are created `wx` (exclusive) then renamed. |
| **Credential leakage** | Credentials enter only via env (`UAAL_CREDENTIAL_*`) or explicit policy; never from HTTP bodies; never hardcoded. `redactSecrets` scrubs token/bearer/JWT/URL-credential patterns from every log line and redacts sensitive keys in structured fields. The HTTP layer strips `Cookie`/`Authorization`/`Proxy-*` headers from caller-supplied header sets. |
| **Unsafe administrative exposure** | The HTTP API exposes operations, not management: no route-mutation, no file deletion, no config writes. Optional bearer auth + per-IP rate limiting. |
| **Untrusted workers (remote execution)** | HMAC-SHA256 signatures over job bodies with timestamp windows (replay protection); workers authenticate to the coordinator; results carry checksums and re-enter local verification on intake. |

## Responsible access (spec §28, §65)

- The policy layer distinguishes `public` and `authorized` access. Routes needing credentials declare `requirements.credentials` and run **only** when the caller supplied them via policy/env.
- The system does not implement, and will not accept contributions for, functionality whose sole purpose is defeating authentication, paywalls, or platform access controls. When a platform refuses access, UAAL reports `requires_auth` or `blocked` — honestly.
- Politeness: per-host pacing (default 400 ms), bounded retries with backoff, one-request-per-surface budgets where the references proved it necessary.

## Data handling

- The environment profile collects **no personal information** (OS/arch/runtime/binary presence/network family; CI/container/cloud booleans). It exists solely for route compatibility.
- Sessions record request/attempt/timing metadata with redaction applied at write time.
- No cookies are stored or replayed; no cross-run credential caches exist.
- Learning data is per-environment, bounded, and resettable (`uaal stats --reset`).

## Verification pipeline (defense in depth for artifacts)

1. Transfer: Content-Length equality, byte caps, deadlines.
2. File: existence, regular file, sandbox containment, size floor/completeness.
3. Content: magic-byte sniffing, HTML masquerade rejection (for media kinds), kind-vs-content match, checksum when declared.
4. Media: ffprobe (container, duration, streams) with a documented degradation ladder; MP4 moov-atom walk for truncation detection.
5. Only then: atomic rename into the store and registry publication. `verificationStatus: "verified"` is the only success marker.

## Reporting

Please report security issues privately to the repository owner (see CONTRIBUTING) before opening public issues.
