# CONTRIBUTING

## Principles (non-negotiable)

1. **Fail closed, never fabricate.** A route's `ok` is a claim; only verification promotes it. Absent information is `null` + `uncertainty.missing`, never a plausible-looking default.
2. **Never-raise boundaries.** Routes and verifiers return structured results; exceptions become classified failures.
3. **No LLM in the core.** Extraction, routing, validation, verification are deterministic.
4. **No bypass functionality.** Nothing whose sole purpose is defeating authentication or access controls (spec §28, §65).
5. **Contracts before features.** New behavior extends `src/core/contracts.ts` + `schemas.ts` first, then implementations.

## Development

```bash
npm install
npm run typecheck      # strict TS, zero errors expected
npm test               # 149+ tests (unit, security, contracts, integration, interfaces)
npm run build
npm run smoke          # offline end-to-end
npm run schema:export  # regenerate schemas/uaal.schema.json when contracts change
```

Branches: feature branches → PR against `main`. CI runs typecheck + build + tests + schema export + smoke on Node 20/22/24.

## Live-network checks (manual, not CI)

Live platforms change; run spot checks before releases and record the date:

```bash
node bin/uaal.js resolve "https://youtu.be/dQw4w9WgXcQ"
node bin/uaal.js inspect "https://x.com/jack/status/20"
node bin/uaal.js inspect "https://www.reddit.com/r/..." 
node bin/uaal.js acquire "https://example.com"
```

Expect honest failures (`requires_auth`, `blocked`, `empty`) from datacenter IPs on some platforms — that is correct behavior, not a bug. Update the per-route expectations in `docs/ROUTE_GUIDE.md` if endpoint semantics changed.

## Adding an adapter

Follow `docs/ADAPTER_GUIDE.md`; the contract test suite picks your adapter up automatically. Required: honest `limitations()`, provenance in evidence, fixture-based tests, no live-network dependence in tests.

## Code standards

- TypeScript strict; ESM (`"type": "module"`); Node >= 20.
- Public surfaces documented (JSDoc on contracts).
- Structured errors with `FailureCode`; no bare `throw new Error` across module boundaries.
- Logs via the engine logger (JSONL on stderr); never `console.log` in src/.
- Security-sensitive changes require a note in `docs/SECURITY.md`.

## Reporting security issues

Open a private security advisory or contact the maintainer directly before public disclosure.
