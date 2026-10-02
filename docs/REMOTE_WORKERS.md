# REMOTE_WORKERS

UAAL separates **route execution** from the **coordinator** (spec §29–30). Routes can declare where they may run (`environmentCompatibility.local/remote`), and a remote worker lets you execute acquisition in a different environment — different IP class, more bandwidth, binaries that are missing locally — without exposing that complexity to the calling agent.

## Architecture

```
UAAL (coordinator/engine)                 uaal-worker (remote host)
        │  claim job (signed)                  │
        ├──────────────────────────────────────▶│  runs the SAME local engine:
        │                                       │  detection → routes → verification
        │◀──────────────────────────────────────┤  → artifacts (inline ≤ cap or contentUrl)
        │  submit result (signed)               │
        ▼
results re-enter the normal envelope path
```

## Security model

- **HMAC-SHA256 signatures** cover the JSON body: `X-UAAL-Signature: t=<unixMs>,v1=<hex>`; the timestamp window (default ±5 min) blocks replay. Verification is timing-safe (`verifySignature`).
- The shared secret (`UAAL_WORKER_SECRET`) never crosses the wire; signatures do.
- Workers are untrusted: their artifacts re-enter local verification (checksums are validated; the artifact gate re-runs on intake).
- Workers are stateless; the coordinator owns job state.

## Protocol

| Step | Endpoint (coordinator) | Body |
|------|------------------------|------|
| Claim | `POST /worker/jobs/claim` | signed poll envelope → `204` when idle, else a `RemoteJobPayload` |
| Submit | `POST /worker/jobs/:id/result` | signed `RemoteJobResult` |

`RemoteJobPayload`: `{ jobId, operation (resolve|inspect|acquire|verify), resource, capability, constraints {output, environment, policy, platform}, issuedAt, signature }`

`RemoteJobResult`: `{ jobId, status (completed|partial|failed), envelope?, artifacts?: [{filename, mimeType, size, checksum, contentBase64?, contentUrl?}], errors? }`

Artifacts above the inline cap (default 8 MiB) return `contentUrl` instead of `contentBase64` — fetch them through the artifact delivery API with checksum verification.

## Running a worker

```bash
export UAAL_COORDINATOR_URL=https://uaal.example.com
export UAAL_WORKER_SECRET=<long-random-secret>
uaal-worker                    # polls, executes, submits; SIGTERM for clean stop
```

The worker boots the same engine as local mode — same adapters, same verification gates, same honest failures.

## Route compatibility

Routes declare `environmentCompatibility: { local, remote }`. With no remote provider configured, `remote: true`-only routes are filtered with an explicit discovery reason (spec §9 explainability). The `local` provider always claims local-compatible routes; the remote-worker provider plugs into the same `ExecutionProvider` contract (`src/exec/local.ts`).

## Coordinator reference implementation

The signature primitives (`signPayload`, `verifySignature`, `makeJobPayload`, `validateCoordinatorUrl`) live in `src/workers/protocol.ts` and are covered by tests (tamper, wrong secret, replay). Wire them into your coordinator's HTTP surface as shown in the table above; the worker side is already implemented (`src/workers/worker.ts`).
