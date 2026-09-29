# Local connector implementation and acceptance

## Delivered

- Ollama `local_sidecar` Connection configuration creates an existing Channel and opaque provider-credential accounting reference. No upstream secret is uploaded. Resource projection uses that same Channel identity.
- Migration `0025_local_connectors` adds single-use pairing hashes, independent identity hashes, and connector bindings/readiness on existing leases. Historical migrations are unchanged.
- Admin pairing/rotation, identity-authenticated renewal, connection revocation and live project/key/channel/model checks are implemented. Console sessions cannot forge connector heartbeat.
- Standalone Go CLI pairs from stdin and stores identity locally. Its explicit private-IP `/v1` target, model allowlist and optional local environment credential cannot be replaced by a dispatched request.
- Gateway and connector exchange jobs, framed streaming results and cancellation over outbound HTTPS. Production startup requires incoming TLS, HTTPS to Control Plane, a one-replica declaration and PostgreSQL singleton lock. Private CA support verifies certificates without disabling checks.
- Existing Router/OpenAI adapter, immutable request/attempt attribution and v2 outbox/Worker remain authoritative. No price is invented. Transport timeout after possible execution is an unknown outcome, with a 504 client response and no replay.
- Console creation, model configuration, one-time token display, status, test call and revocation; two-machine instructions in `docs/operations/local-connector.md` and the new-user manual.

## Validation

Executed on Windows, Node 24 and Go, using a separately created `nexus_connector_test_20260929` PostgreSQL database. No daily-use database was reset.

| Check | Command / result |
|---|---|
| TypeScript | `npm run typecheck` — pass |
| Lint | `npm run lint` — pass |
| Source, contracts and security | `node --env-file=.test-artifacts/local-connector/test.env node_modules/vitest/vitest.mjs run src tests/contract tests/security --reporter=dot` with `NEXUS_CONNECTORS_ENABLED=false` — 87 files, 887 tests passed |
| Relevant integration and migrations | `node --env-file=.test-artifacts/local-connector/test.env node_modules/vitest/vitest.mjs run tests/integration/canonical-migrations.test.ts tests/integration/workspace-management.test.ts tests/integration/project-snapshot.test.ts tests/integration/worker-project-v2.test.ts tests/integration/local-connector.test.ts --reporter=dot` — 5 files, 71 tests |
| Independent-process E2E | `local-connector.test.ts` — 8 groups passed; real compiled Gateway and CLI, real route handlers and PostgreSQL, mock Ollama on another listener; trusted test TLS on both remote endpoints |
| Browser | `node --env-file=.test-artifacts/local-connector/test.env tests/e2e/local-connector.mjs` against dedicated Next server — passed; screenshot `output/playwright/local-connector.png` |
| Go | `npm run gateway:test`, `npm run gateway:vet`, `npm run gateway:fmt` — pass |
| Migration metadata | `npx drizzle-kit check` — pass; canonical fresh bootstrap applies 26 entries |
| Formatting and secrets | Prettier on changed files, `git diff --check`, `npm run secrets:scan` — pass |
| Race detector | `go test -race ./...` unavailable: Windows environment has CGO disabled and no C compiler |

E2E covers concurrent/replayed/invalid pairing, identity rotation, forged heartbeat, multiple models, cross-project/tenant access, unconfigured models, key/channel disable, removed project binding, expired lease, connection revoke, disconnected CLI, upstream timeout, client cancel, incomplete SSE, reliable and unknown usage, unpriced Worker behavior, second-Gateway rejection, and secret/prompt omission from records/logs.

An independent code review found and prompted fixes for long-upload read deadlines, HTTPS enforcement on the Gateway-to-Control-Plane link, early upload failure cleanup, and ambiguous timeout attribution. Regression tests cover those changes.

## Limits and Git state

- Single enabled Gateway only; all connector and inference traffic must reach it. No horizontal session distribution or rolling overlap.
- First adapter is OpenAI-compatible Chat Completions over Ollama. No general HTTP proxy, commands, filesystem execution, or subscription credential forwarding.
- Readiness is based on an authenticated lease, recent transport and local model listing, not a guarantee that the next inference succeeds. Console transport freshness window is 35 seconds.
- Production deployment and a real Ollama installation were not exercised here; acceptance used TLS and mock Ollama. Existing production Vault/Redis/budget prerequisites remain.
- Work started from clean `main` at `4b1c433` and is isolated on `codex/local-connector`. The initial remote fetch failed; the user requested a commit retry, and the subsequent fetch succeeded with `origin/main` still at `4b1c433`. Submission uses the existing post-commit merge-and-push workflow; Git history records the resulting commit and publication state.
