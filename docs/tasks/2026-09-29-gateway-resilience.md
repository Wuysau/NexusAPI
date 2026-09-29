# Gateway resilience: design and acceptance

## Intent

Continue improving NexusAPI with independently implemented ideas from established open-source gateways. Keep project authorization, signed snapshots, upstream credentials and immutable usage attribution authoritative. Work in small verified rounds, as requested by the user.

Base: clean `origin/main` at `a1bf222`; branch `codex/gateway-resilience`. The existing post-commit workflow merges verified commits to main and pushes them.

## Round 1 design

1. Respect bounded upstream cooldown hints. Parse `Retry-After` seconds/HTTP dates and the millisecond variants, clamp to 60 seconds and discard malformed values. A 429 immediately excludes that channel/model for later requests; a 503 with a positive hint also cools it down. Recovery uses the existing half-open admission guard. A concurrent older success must not clear an active cooldown. No sleeping or broader replay of the current request.
2. Count provider health failures by their meaning. Invalid input and content-policy refusals do not poison shared channel health. Quota, authentication, transient transport and server errors retain their explicit handling. Unknown execution and missing usage stay unknown.
3. Make readiness reflect dependency checks. Require a fresh signed snapshot and responsive database; production also requires a successful live Redis check. Development can explicitly report local admission. Bound probes to two seconds and do not publish raw errors. Public version output exposes aggregate breaker counts without channel/model identifiers.
4. Correct startup concurrency initialization. Apply the configured process cap before admission; startup must not permanently consume a slot or fix the cap to 256.
5. Replace the HTTP-only container probe with a compiled local readiness command. Reuse configured port and TLS mode, verify certificates, optionally trust an operator-supplied CA and DNS name, and bound the probe to three seconds/64 KiB.

No schema changes, provider source copying, new upstream secret paths, subscription credential usage, or relaxed authorization are needed.

## Primary references

- [LiteLLM routing and error-specific cooldown](https://docs.litellm.ai/docs/routing)
- [Portkey automatic retries and bounded retry hints](https://portkey.ai/docs/product/ai-gateway/automatic-retries)
- [LiteLLM health checks](https://docs.litellm.ai/docs/proxy/health)
- [Bifrost provider routing](https://github.com/maximhq/bifrost/blob/dev/docs/providers/provider-routing.mdx)

These references inform behavior; NexusAPI keeps its stricter replay and financial rules. Repository source code is not copied.

## Validation plan

- Parser tests for seconds/dates/ms, missing/negative/malformed/overflow input, and maximum duration.
- Breaker tests for per-channel/model isolation, concurrent success, expiry, half-open probe limits and release.
- Gateway requests prove current calls are not replayed, later traffic can use another eligible channel, and bad input cannot trip shared health.
- HTTP readiness tests for startup, fresh/stale snapshot, database/Redis failure and recovery, timeout, and development profile.
- Public diagnostics test that channel and model identifiers never appear.
- Startup admission tests below and above 256 concurrent slots, release and reuse.
- Full Go tests, vet, formatting; relevant TypeScript contracts and secret scan before commit.

## Results

- `go test ./...` and `go vet ./...` passed, including real HTTP/TLS probe servers, cooldown, routing/streaming, admission, and platform-directory freshness regressions.
- Five related TypeScript contract files passed: 67 tests (`gateway-contracts`, `gateway-callers`, `gateway-artifact`, `usage-event-v2`, `owned-access-accounting`).
- Go format, changed document/test formatting, diff whitespace and secret scan passed.
- Healthcheck binary builds with `CGO_ENABLED=0`; no new dependencies or migration.
- Docker image build and container race validation were unavailable because Docker Desktop's Linux engine was not running. Host Go race still needs a C compiler/CGO. No production rollout was performed.
- Review found and fixed readiness accepting an expired platform key directory when a tenant bundle remained fresh. Tests first reproduced the false-ready response and now require 503.
- Existing local-connector framing does not forward upstream retry headers; local 429 uses the configured default cooldown. Per-provider hints currently apply to direct API channels.

## Next round

Investigate and fix server request identity versus client correlation, plus two-phase shutdown that allows terminal persistence to finish. Both defects have been reproduced with real HTTP requests. Keep these changes separate from the first verified commit.

## Round 2 design

Round 1 was committed as `a3ab3a8` and merged/pushed to main (`43f3745`).

- Generate each authoritative request ID on the Gateway and carry it through a private request context. A client-provided correlation header must not become the global database primary key. Responses, Chat, errors, response headers, budgets and usage facts must use the same server-generated ID. Echo only a bounded safe client correlation value in a separate `x-client-request-id` header; do not persist it as identity.
- Preserve explicit `Idempotency-Key` behavior. A scoped durable duplicate returns 409 even when the local guard was lost/restarted; unrelated database errors remain storage failures. Make MemoryStore model the database's global request-ID uniqueness so tests cannot hide cross-tenant collisions.
- Stop admitting requests when shutdown starts, drain during the caller's grace period, then cancel remaining server request contexts and close sockets if the grace expires. Allow up to 12 additional seconds for handler cleanup (the terminal write budget is 10 seconds) before releasing registered dependencies. Report cleanup timeouts explicitly; do not claim graceful success or rewrite unknown execution as completed.
- Regression tests cover duplicate caller correlations, concurrent calls, explicit durable duplicate keys, Responses identity consistency, graceful stream completion, cancellation, delayed terminal persistence before resource closure, and the bounded emergency path.

The identity change intentionally changes the response `x-request-id` from an echo to the authoritative server ID. Clients needing their original correlation should read `x-client-request-id`; clients needing deduplication must use `Idempotency-Key`. No database migration is required.

## Round 2 validation

- `go test ./...` and `go vet ./...` passed. Shutdown tests use real listeners and delayed terminal persistence; main lifecycle tests cover cleanup transfer, HTTP/TLS listener startup failure and emergency cleanup.
- Docker Desktop was started for isolated verification. `docker run --rm ... golang:1.27 go test -race ./...` passed on Linux; this closes the earlier host CGO limitation for the tested code.
- `docker build -t nexus-gateway:resilience-check -f services/gateway/Dockerfile .` passed. The resulting image uses UID/GID 1001 and the compiled readiness command. No production container or existing image tag was replaced.
- Prepared only disposable `convergence_gateway18` through `scripts/prepare-project-gateway-fixture.mjs`, then ran `go test . -run '^TestProjectV2PostgresCaptureTerminal$' -count=1 -v` with the explicit `127.0.0.1:55439/convergence_gateway27` fixture DSN. Passed with two valid tenant/organization/credential scopes, repeated caller correlation, durable v2 duplicate detection, immutable project facts and atomic outbox rollback.
- `tests/integration/local-connector.test.ts` passed all 8 groups using separate compiled Gateway/connector processes, verified TLS, real PostgreSQL in disposable `connector_test_resilience`, and mock Ollama.
- Six related TypeScript contract files passed, 70 tests. Go formatting, modified Compose/test formatting, secret scan and diff checks passed.
- Independent review found and fixed main's deferred cleanup bypassing Server's emergency protection. Dependencies are now transferred to Server; the startup defer only handles initialization failures. Telemetry shutdown has a separate two-second bound. Compose now provides 60 seconds before forced termination.
- Review also reproduced a pre-existing legacy v1 BYOK gap: after the admission claim expires or is lost, terminal-only persistence cannot prevent upstream replay of an explicit idempotency key. The v2 fix is not presented as legacy durable replay protection; a separate bounded round will address that path.

Round 2 was committed as `0caf630` and merged/pushed to main (`8429926`).

## Round 3 design

- Persist a minimal legacy v1 BYOK claim before dispatch when the caller supplies `Idempotency-Key`. Existing `request_records` uniqueness arbitrates between processes. A dedicated guarded terminal update completes only the matching `created` BYOK claim; managed reservations and v2 immutable project facts keep their separate paths. A failed or ambiguous claim prevents dispatch. Created-only crash claims remain owned without fabricated usage or automatic replay. No-key legacy degradation remains supported.
- Keep fallback candidates in the selected execution mode for both v1 and v2, so a BYOK operation cannot unexpectedly become a managed charge. Preserve the existing prohibition on replay after possible upstream execution.
- Wire process-local HTTP counts and timing to the actual four public API endpoints, and expose them through optional Bearer-authenticated `/metrics`. The fixed metric names carry no request-controlled labels or content. Preserve response writer capabilities and error propagation needed by streaming and cancellation. Remove unwired pre-registered counters that falsely suggest operational coverage.
- Verify duplicate requests across independent proxy/store instances, lost admission state, created-only crash claims, guarded terminal updates, cross-tenant keys, atomic outbox rollback, unavailable/old schema, metrics authentication, stream failure and cancellation, and response-controller forwarding. Run canonical PostgreSQL and independent connector end-to-end regressions in addition to native Go/race and TypeScript contracts.

No new migration or dependency is planned. Deploy all current migrations before enabling durable explicit-key v1 BYOK calls; older fixtures deliberately exercise fail-closed behavior.

## Round 3 validation

- Full native `go test ./...` and `go vet ./...` passed; Linux `go test -race ./...` passed with the combined changes (Gateway 52.838 seconds). Regression cases cover durable explicit-key operations with separate proxies, lost admission state, storage failures, terminal identity guards and execution-mode-preserving fallback.
- Canonical PostgreSQL `TestProjectV2PostgresCaptureTerminal` passed through the existing disposable fixture. Independent database pools produced exactly one upstream call for concurrent duplicate requests; restart/cache-loss duplicates returned 409. Separate tenant ownership, created-only crash claims, terminal/outbox transaction rollback, seven identity mutations and managed/v2 takeover rejection passed.
- Metrics tests passed for optional authentication, malformed credentials, the four actual API routes, content exclusion, HTTP error semantics, successful body writes, streaming cancellation, concurrent scrapes and preserved HTTP/1 and HTTP/2 writer capabilities. `FlushError` remains observable through `ResponseController`; instrumentation cannot silently swallow downstream flush failures.
- `npm run typecheck` passed. Six TypeScript contract files passed all 70 tests, and the independent-process TLS local-connector suite passed all 8 groups. Go formatting, Compose formatting, secret scan and diff checks passed.
- Independent review found no blocking defects. No production deployment, schema change, additional subscription credentials or provider pricing assumptions were introduced.
- The intentional historical-schema fixture `TestBudgetPostgresControlPlaneOutage` passed against disposable `convergence_gateway27` and Redis. Explicit-key BYOK rejected before upstream dispatch; no-key BYOK and managed reservations continued through Control Plane outage. Compiled Budget and Worker processes plus `scripts/verify-budget-worker.mjs` verified five events, three releases, fixture managed charges of 201 micros and unchanged ledger postings after replay. Temporary service processes were stopped.
