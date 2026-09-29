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

Round 3 was committed as `a543b21` and merged/pushed to main (`7c8d463`).

## Round 4 design

The connector currently retries polls every second, can spin on malformed successful responses, and checks expired leases only on a 20-second renewal tick. Its internal cancellation also returns success to the CLI. Adopt bounded reconnect scheduling inspired by [cloudflared's backoff lifecycle](https://github.com/cloudflare/cloudflared/blob/master/retry/backoffhandler.go), using original code and no added dependency.

- Give the active lease its own deadline watcher, independent of blocked renewal, local model discovery and job polling. Re-check the current lease when a timer fires so a completed renewal cannot be canceled by an old deadline. On failure, cancel all work before waiting for workers; distinguish explicit caller cancellation from lease expiry and rejected connector identity.
- Keep direct Control Plane lease 401/403 as terminal authorization failures. Gateway transport 401/403 can also represent a temporary Control Plane failure, so retry them within the known lease instead of claiming permanent revocation.
- Use separate bounded exponential backoff with jitter for renewal and polling failures, starting at a 500 ms envelope and capped at 15 seconds. Keep normal renewal at 20 seconds, renew short leases earlier, and stop waits at cancellation or lease expiry. Add a minimum interval for immediate empty polls to avoid a busy loop.
- Reject malformed, oversized or incomplete job envelopes before scheduling local work. Read a complete bounded JSON envelope rather than accepting a valid prefix. Each new poll reads the current lease; assigned jobs retain their original token.
- Retry only polling and renewal. Pairing, local model execution and result uploads remain single attempts. An upload or cancellation-watch failure must never replay a model invocation.

Validation uses real HTTP listeners for transient recovery, blocked renewal, exact expiry cancellation, malformed response bounds and one-attempt execution, plus CLI process exit and the existing independent-process TLS connector suite. No Control Plane schema, routing authorization, credential scope or deployment replica support changes are planned.

Review refinements: bound the entire poll, including its response body, to 35 seconds; renewing the lease must not keep a broken body reader alive indefinitely. Check lease expiry under the same lock used to publish renewals, so a stale snapshot cannot cancel a newer valid lease. Pace immediate successful cancellation-watch responses while still canceling immediately on watch failure. Pairing input must also observe interruption before making its one-time HTTP call; the one-shot CLI process must return without waiting for Windows console reads to unblock.

## Round 4 validation

- Reproduced the old malformed-response loop with real HTTP: 3,047 polls in a 350 ms fixture run. Eight independent network test groups now pass, including blocked renewal at a 450 ms lease deadline, direct CP authorization rejection, transient Gateway 401 recovery, token rotation, stalled response body, bounded immediate 202/invalid 200 polling and exactly one model call after failed upload.
- Full native Go tests and `go vet ./...` passed. Final combined Linux `go test -race ./...` passed: connector client 6.374 seconds and CLI 3.771 seconds; unchanged packages reused validated cache entries. Go formatting, secret scan and diff checks passed.
- CLI subprocess tests verify exit code 1 for rejected identity and expired lease, sanitized output, and exit code 0 for explicit termination while running or waiting to paste a pairing token. Waiting-input cancellation makes zero pairing requests. Native CLI tests passed ten repetitions; Linux race CLI tests passed three repetitions.
- Windows redirected input cancellation is tested with an actual pipe. Physical Windows console Ctrl+C delivery was not automated. The CLI cancellation branch deliberately returns without waiting for the console's blocking read or close; this process-scoped behavior is kept out of the reusable client library.
- The existing TLS connector end-to-end suite passed all eight groups (16.89 seconds), using independent Gateway and connector processes, mock Ollama, canonical migrations and real PostgreSQL attribution/unknown-price handling.
- Independent review found no blocking issues. Initial startup still reports failure if its first lease cannot be acquired; an operator or process manager can restart it. Within an acquired lease, temporary network failures retry under the documented bounds. Single-Gateway deployment remains required.

Round 4 was committed as `adab5fd` and merged/pushed to main (`0e3d93c`).

## Round 5 design

The CLI currently redeems a one-time pairing token before opening its identity destination. An existing file or invalid destination can therefore consume the token without saving the new identity. Reserve a new private destination before the HTTP call, after the user has entered the token; exclusive creation must preserve existing files and reject invalid paths without contacting Control Plane.

Pairing stays a single attempt. On failure, remove only the still-empty file created by this invocation, after checking its file identity; never remove a replacement or any nonempty file. On success, validate the returned identity, persist, synchronize and close it before reporting success, and detect destination replacement or edits. Require complete IDs and the Control Plane's canonical credential shape; a successful HTTP status with an incomplete identity is a protocol failure. A failed save after redemption requires a new token and may leave a nonempty incomplete private file; preserve that file and explain the next step rather than risk deleting another process's contents. Keep credentials and raw filesystem errors out of logs.

Validate through independent CLI/HTTP tests: zero redemption calls for existing/invalid destinations, unchanged existing contents, one successful redemption with a private identity file, one failed/ambiguous redemption without an abandoned empty file, replacement-file preservation, malformed successful receipts, and the existing signal/lease tests. User cancellation during redemption exits cleanly but can leave the remote token consumed; it never triggers a second attempt. No server schema, credential policy or connector protocol changes are required.

## Round 5 validation

- Reproduced the existing-file and missing/invalid-parent defects: each incorrectly reached the pairing endpoint once. Independent real CLI/HTTP tests now verify zero calls for these cases, preservation of existing identities and symlink targets, and reservation of the empty destination before the server receives a valid redemption request.
- Successful pairing saves the complete identity, keeps the locally configured Control Plane origin and uses Unix mode `0600`. Rejected, disconnected, truncated and incomplete-identity responses make one attempt and remove only the owned empty placeholder. Replacement files and nonempty same-inode edits are preserved. Injected short/failed writes and synchronization/close failures return static errors and retain nonempty partial data.
- Full native `go test ./...` and `go vet ./...` passed. Combined Linux `go test -race ./...` passed (CLI 6.216 seconds, connector client 6.356 seconds), including Unix signal handling, permissions and symlink cases. Cancellation during an in-flight pairing request exits 0, cancels HTTP, makes no second attempt and cleans its own empty placeholder.
- The independent-process TLS connector suite passed all eight groups (17.56 seconds), covering real Control Plane pairing and subsequent multi-model inference/attribution. Go formatting, secret scan and diff checks passed. Independent review found no blocking issues.
- Private destination directories remain required. File-identity checks preserve observed replacements; they are not a security boundary against a malicious local user who controls the directory. No production deployment or migration was performed.

Round 5 was committed as `b83082a` and merged/pushed to main (`0653c13`).

## Round 6 design

Model discovery currently performs one serial Control Plane authorization for each connector model. An isolated real `ServeModels` reproduction with eight models and 25 ms authorization latency made eight calls, with peak concurrency one and 235 ms total latency. Each call can independently wait five seconds, so the catalog's delay grows with its model count. These fixture timings identify request amplification; they are not production benchmarks.

- Retain per-model `Router.Select` filtering, including tenant/project policy and breaker eligibility. Group only eligible local-connector candidates by their Channel and connection for the current authenticated identity. Keep ordinary API model behavior unchanged.
- Extend the existing internal connector authorization request with `requestedModels` (1–64 valid IDs). Allow this field only with `models:read`, complete channel/connection/tenant/project/organization/key bindings, no single `model`, and no transport heartbeat request. Validate the live lease, connector identity, owner, project, organization, key, provider, credential and Channel before returning the intersection of requested, ready and Channel-approved models.
- Keep authorization results within this catalog request. Batch model listing does not grant model execution permission or refresh connector online state. Chat forwarding keeps its existing live per-call checks. Old single-model and transport authorization requests remain supported.
- Bound Gateway catalog I/O with one five-second deadline and at most four simultaneous authorization checks. Split unusually large candidate groups into bounded batches; return only verified candidates. Validate returned identity, expiry and model membership so unsolicited model IDs cannot bypass routing exclusions.
- Test 64 models on one Channel requiring one batch request, bounded concurrent work, timeout and cancellation, partial availability, current revocation, malformed batch inputs, tenant/project/key isolation and unchanged Chat authorization. Run real PostgreSQL and the independent-process TLS connector suite.

No schema or deployment replica change is required. Deploy the Control Plane support before the new Gateway; an older Control Plane rejects batch discovery, so connector models will remain hidden until both are upgraded.

Review also found that the existing snapshot refresh mutex could outlive a caller's deadline while another request refreshed the same tenant. Refresh ownership now uses a context-aware gate: canceled waiters return promptly without canceling the owner, and background shutdown can also stop waiting. The existing single-flight and retained stale-state/error behavior are preserved. Shared live authorization now rejects malformed stored model lists and non-array key scopes rather than accepting JSON object keys or scalar substring matches.

## Round 6 validation

- The prior 64-model fixture made 64 authorization calls; it now makes one batch call. Eleven Go catalog test groups cover bounded batches/concurrency, shared deadline, client cancellation, partial availability, current revocation, Router exclusions, invalid grants, duplicate active/inactive catalog IDs and bounded complete JSON responses. Snapshot wait tests reproduced the old one-second lock wait despite a 50 ms caller deadline; canceled waiters now leave without disturbing the owner. Existing 32-caller single-flight tests pass.
- The real PostgreSQL and independent-process TLS connector suite passed all nine groups (18.65 seconds). Its two-model catalog makes exactly one batch authorization and zero single-model authorization calls. The new database fixture covers 22 request/binding boundaries and 19 live authorization states, including malformed scopes in both batch and single-model modes, model intersections, duplicate IDs and unchanged heartbeat timestamps. Existing inference, streaming, cancellation, timeout and attribution checks pass.
- `npm run typecheck` passed. Seven focused TypeScript unit/contract files passed all 100 tests. Go formatting, targeted TypeScript ESLint/Prettier, secret scan and diff checks passed.
- Independent CP and Go reviews found no blocking issues. The final response loop retains each model row's status check, so an active ID cannot restore a deprecated row that shares the same ID. No migration or production deployment was performed; CP-first rollout and the existing single-Gateway connector deployment constraint remain documented.
- Final combined `go test ./...` and `go vet ./...` passed (Gateway 21.453 seconds). Linux `go test -race ./...` passed (Gateway 65.004 seconds), including the final inactive-row regression and snapshot cancellation changes.

Round 6 was committed as `e9930f3` and merged/pushed to main (`970167a`).

## Round 7 design

Buffered inference currently writes the final JSON without a downstream deadline. A real Linux TCP fixture with an 8 MiB response and a client that stops reading leaves both Chat and Responses handlers blocked beyond the configured write budget. Chat also retains its tenant concurrency lease; Responses releases that lease before its final adapter write but still blocks its HTTP handler and graceful shutdown. Windows socket buffering did not reproduce blocking in the same fixture, so Linux verification is required.

Apply operation-specific deadlines, following the distinction between streaming and buffered I/O used in [Bifrost's provider design](https://github.com/maximhq/bifrost/blob/dev/AGENTS.md) and the bounded writes in [Caddy's HTTP transport](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/reverseproxy/httptransport.go). NexusAPI uses its existing `IdleTimeout`, original Go code and no new dependency.

- Cover the actual buffered Chat write and flush, and the final Responses adapter write/flush, after existing durable terminal persistence. Failure releases request resources without replaying inference or rewriting completed usage facts.
- Share deadline ownership with SSE: set a fresh deadline for each write/flush operation and clear successful intermediate deadlines. An armed HTTP/2 deadline can otherwise reset a healthy stream while terminal persistence is still running. Terminal writes retain the deadline for HTTP/1 chunk termination and HTTP/2 END_STREAM after the handler returns. Failed operations retain the failure instead of reopening the connection.
- Validate real TCP backpressure, HTTP/2 with verified TLS and slow terminal persistence, normal large outputs, downstream write/flush failures, exactly-once execution and unchanged accounting. Keep whole-request server WriteTimeout disabled so valid long inference is not cut off before output starts.

## Round 7 validation

- Real Linux TCP tests reproduced both buffered handlers remaining blocked beyond two seconds with a 150 ms write budget. After the change, both finish in about 290 ms including generation and serialization, release request resources, and retain exactly one completed terminal record/outbox event. Healthy clients receive the entire 8 MiB JSON content. Windows kernel buffering accepted this fixture without blocking, so its passing native run alone is not the backpressure proof.
- Verified TLS HTTP/2 tests reproduced `INTERNAL_ERROR` resets on both streaming APIs when persistence waited 300 ms after a successful write with a 100 ms deadline. Both now deliver their terminal completion marker, one execution, one terminal record and unchanged measured usage. Eight connection-reuse cases cover HTTP/1 and HTTP/2, both APIs, and JSON/streaming; after waiting longer than the completed response's write deadline, the same connection still serves the next request.
- Nine fault/lifecycle cases check deadline setup, intermediate cleanup, terminal retention, write/flush failures, unsupported in-memory writers and zero-timeout compatibility. Independent review verified that terminal deadlines remain armed for the standard library's final chunk/END_STREAM flush and found no blocking issues.
- Final `go test ./...` and `go vet ./...` passed (Gateway 23.350 seconds). Linux `go test -race ./...` passed (Gateway 76.425 seconds). Six TypeScript contract files passed all 70 tests; no TypeScript production source changed in this round.
- `node .test-artifacts/resilience/verify-connector.mjs` passed all nine real PostgreSQL/TLS independent-process connector groups (18.17 seconds), including streaming, cancellation, timeout, live authorization and attribution. Go formatting, secret scan and diff checks passed. No schema change, new dependency or production deployment was made.

Round 7 was committed as `f79628d` and merged/pushed to main (`7e9d8be`).

## Round 8 design

The current production rate limiter falls back locally after a Redis RPM or TPM error even when shared concurrency admission has succeeded. A targeted real-Redis failure reproduced one budget reservation, terminal record, outbox event and local bucket allocation. The fixture subsequently rejects its static provider credential in production, so it does not prove a provider call; it does prove that failed shared rate admission incorrectly reaches the budget and execution lifecycle. Independent tests also show that Chat and Responses omit the computed recovery hint on temporary rate rejection.

- Make `Limiter.Allow` return a separate error and require explicit permission for local fallback. Production and unspecified profiles reject failed or malformed Redis rate decisions with the existing 503 contract, before budget reservation. Caller cancellation never consumes a local bucket; development/test keeps its reduced fallback. Bound each Redis rate operation to one second and respect shorter parent cancellation.
- Use Redis `TIME` inside the atomic bucket script. The former caller timestamp allowed differing Gateway clocks to move stored refill time backward and then refill early on another instance. Keep the existing bucket identity and schema, and clamp stored capacity when policy tightens.
- Emit positive, rounded-up `Retry-After` only for known temporary RPM/TPM exhaustion, including Responses. Requests larger than the full bucket have no recovery-by-waiting promise. Waiting does not reserve future capacity, and inference is never automatically retried.
- Verify two independent Redis clients sharing rate capacity, concurrent requests, partial failures after successful concurrency admission, same-idempotency-key recovery, cancellation, explicit fallback and public error semantics. Keep existing catalog behavior, pricing, accounting and connector authorization unchanged. No dependency or migration is needed.

## Round 8 validation

- The production partial-failure reproduction now returns 503 for either rate script, with zero budget reservations, upstream calls, terminal records, outbox events and local buckets. Restoring Redis lets the same undispatched idempotency key reach one normal budget decision. A stalled rate command exits at its one-second deadline and releases that key.
- Eight real-Redis test groups cover two-client shared refill/capacity, 32 concurrent calls admitting exactly seven, server-clock timestamps, impossible request costs, explicit development fallback, cancellation before/during the script, a stalled command and ten malformed response variants. The full Redis integration selection also passed with Linux race detection (6.596 seconds).
- Four Chat/Responses public cases verify positive, rounded-up temporary 429 recovery hints without another dispatch or accounting event. Additional native tests cover strict profiles, cancellation preserving local capacity, immediate policy tightening, oversized costs and duration rounding without overflow.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 25.420 seconds); Linux `go test -race ./...` passed (Gateway 77.206 seconds). Six TypeScript contract files passed all 70 tests. The independent-process PostgreSQL/TLS connector suite passed all nine groups (18.21 seconds).
- Go formatting, secret scan and diff checks passed. Independent production-code review found no blocking issue. No TypeScript production code, migration, dependency or production deployment changed.

Round 8 was committed as `b180bdc` and merged/pushed to main (`d9441f8`).

## Round 9 design

Successful snapshot fetches currently bypass expiry enforcement. A real HTTP Control Plane fixture returning a correctly signed, already-expired bundle let `/v1/models`, Chat and Responses return 200 for either platform or tenant scope. Repeating each inference case executed the mock upstream twice and produced two reservations, terminal records and outbox events. Background refresh also replaced previously accepted state with an expired candidate. This contradicts the cache's existing promise that a successful `Get` returns fresh authority.

Apply the received-configuration validation and bounded-lifetime principles documented by [Envoy xDS](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol#ttl) within NexusAPI's existing signed protocol:

- Verify signed expiry strictly after the actual receipt time. Check both effective expiry and cancellation again after verification, before accepting a candidate. Network latency consumes the signed validity window; `ReceivedAt`, `FetchedAt` and the local maximum-age ceiling describe actual receipt.
- Preserve the previous accepted generation and its original expiry when a candidate is invalid. A new expired bundle is never eligible to supply authorization or turn on BYOK degradation. Existing legacy BYOK stale behavior only uses previously accepted tenant state and still requires a fresh platform directory.
- Make API key authentication honor the cache's error result and independently check freshness, including when time passes after `Get` returns. Keep public error codes; correct the expiry message so it also describes a responding Control Plane that supplies no valid replacement.
- Verify cold and repeated expired HTTP responses, exact nanosecond boundaries, expiry during fetch/verification, cancellation, background state retention, recovery and the legacy/v2 stale-policy matrix. No schema, signed envelope format, dependency or production deployment change is required.

## Round 9 validation

- The six real HTTP cold/replay cases now return 503 for expired platform or tenant bundles through models, Chat and Responses, with no reservation, upstream execution, terminal record or outbox event. Two background-refresh cases retain exactly the previously accepted fresh/stale generation.
- Five real HTTP policy/recovery cases retain legacy behavior: managed always refuses expired tenant configuration, BYOK refuses by default, explicit legacy BYOK can use previously accepted stale state, and v2 refuses even with that flag. All recover with exactly one new execution when a valid replacement arrives. No test grants permission from a newly received expired bundle.
- Deterministic native cases cover the exclusive signed-expiry boundary at nanosecond precision, expiry during retrieval and verification, the local maximum-age ceiling, actual receipt timestamps, successful source returns after cancellation, and authentication checking both the cache error and its own current time.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 25.782 seconds). Linux `go test -race ./...` passed (Gateway 77.954 seconds). Six TypeScript contract files passed all 70 tests. The independent-process PostgreSQL/TLS connector suite passed all nine groups (18.57 seconds).
- Go formatting, secret scan and diff checks passed. Independent production-code review found no blocking issue. No migration, dependency, TypeScript production change or production deployment was performed.

Round 9 was committed as `edae702` and merged/pushed to main (`d01d0c9`).

## Round 10 design

Request parsing silently changes stopping behavior: `stop: null` becomes a one-element empty-string array, while booleans, numbers, objects and malformed arrays can reach upstream inference. `top_p` has no range check. Real mock-upstream tests reproduce the changed null semantics and seven invalid stop shapes executing successfully with accounting side effects.

Use the explicit-input principle documented by [LiteLLM](https://docs.litellm.ai/docs/completion/drop_params) and the [Chat Completions parameter contract](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create):

- Parse `stop` once at ingress into canonical sequences. Accept a string, up to four string elements, or null; reject mixed/null array members and other types with the existing 400 error. Null, omission and empty arrays mean no stop sequences. Preserve explicit strings exactly.
- Validate `top_p` in the inclusive 0–1 range, using the shared Chat path for Responses. Preserve null/omission and the existing invalid-JSON response for wrong types. Reject before authentication, rate admission, idempotency ownership or budget reservation.
- Verify actual upstream wire values and zero side effects for rejected requests. A later valid call with the same idempotency key remains possible. Keep adapter capability work separate; no dependency, migration or pricing change is needed.

## Round 10 validation

- Thirteen real Chat/upstream cases verify null/omitted/empty-array behavior, exact explicit strings, the four-sequence boundary and rejection of seven malformed shapes. Rejected inputs create no reservation, provider call, terminal record or outbox event.
- Twenty-two real HTTP sampling cases cover Chat and Responses, negative/greater-than-one values, wrong types, exact 0/1 boundaries, fractional values, null/omission and corrected retries under the same idempotency key. Before the fix, out-of-range calls executed and made the corrected retry conflict; now only the valid operation executes.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 22.939 seconds). Linux `go test -race ./...` passed (Gateway 78.171 seconds). Six TypeScript contract files passed all 70 tests. The independent-process PostgreSQL/TLS connector suite passed all nine groups (16.76 seconds).
- Go formatting, secret scan and diff checks passed. Independent production-code review found no blocking issue. No migration, dependency, TypeScript production change or deployment was performed.

Round 10 was committed as `7580348` and merged/pushed to main (`553582d`).

## Round 11 design

The native Gemini adapter declares tools, vision and structured-output capabilities while its request serializer only handles text and sampling. It drops tools, tool choice, response formats and tool history; text extraction also discards non-text parts. Anthropic drops `response_format`. Real Gateway/mock-provider tests reproduce successful inference with the requested semantics missing, one credential resolution, reservation and terminal event per case.

Extend the [LiteLLM explicit-parameter principle](https://docs.litellm.ai/docs/completion/drop_params) to actual adapter behavior:

- Require a pure `ValidateRequest(*CanonicalRequest) error` on Go execution adapters. Return a typed unsupported-parameter error with a fixed field name, without request values. `BuildRequest` reuses the same validation for direct callers. Keep OpenAI-compatible serialization and arbitrary model IDs working; do not infer protocol support from model-name heuristics.
- Gemini rejects unimplemented tools, forced tool selection, tool history/results, non-text parts and structured output. Its advertised tools/vision/structured-output flags become false. Anthropic retains current tool support and rejects structured output. Null/omitted options, empty tools and exact text-only format remain compatible; Gemini accepts no-tool auto/none selection.
- Share canonical request construction between validation and dispatch. Narrow the existing Router's authorized, healthy and billable candidates before credentials, payment-mode choice, immutable price pinning and reservation. All later attempts use that compatible set. A compatible authorized candidate may serve the initial request; unsupported candidates never become a lossy fallback.
- Verify zero side effects and idempotency recovery for unsupported requests, both public APIs, supported Anthropic tools, custom-model OpenAI wire fidelity, mixed candidates and safe pre-connection failure. Preserve existing execution/replay and accounting rules. No schema, dependency or deployment change is needed.

## Round 11 validation

- Fifteen Gateway integration cases verify unsupported semantics are rejected before credentials, reservations, upstream execution and accounting. Corrected calls can reuse their undispatched idempotency key. Supported Anthropic tools and custom-model OpenAI-compatible parameters retain their actual wire values. Existing compatible candidates can serve requests, while excluded candidates and incompatible fallback attempts remain unavailable.
- Provider tests cover 23 unsupported Gemini/Anthropic cases, compatible defaults, null and empty options, immutable validation, sanitized typed errors and accurate capabilities/adapter versions. Direct `BuildRequest` callers receive the same validation. Independent reviews of both routing and adapter changes found no blocking issues.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 27.844 seconds). Linux `go test -race ./...` passed (Gateway 93.759 seconds). Six TypeScript contract files passed all 70 tests. The independent-process PostgreSQL/TLS connector suite passed all nine groups (19.32 seconds).
- Go formatting, secret scan and diff checks passed. No migration, dependency, TypeScript production change or production deployment was performed. The custom-model tool test exercises the OpenAI-compatible HTTP adapter; the existing connector end-to-end suite separately verifies connector transport and lifecycle.

Round 11 was committed as `05f2e54` and merged/pushed to main (`ae6bb78`).

## Round 12 design

Every authenticated request currently scans the platform API key directory. On a Windows amd64 Intel Ultra 7 255H benchmark with one CPU, a prewarmed 10,000-key directory takes 38.7–42.1 microseconds for successful full authentication at its last entry, and 41.3–48.3 microseconds for a missing key. A prototype generation-local index reduces those to approximately 0.43 and 0.26 microseconds without changing per-request allocations. Its representative serialized directory is 5.76 MB, within the current 8 MiB transport limit; the 50,000-key stress fixture exceeds that limit and is not a supported production-size claim.

Apply the version-local indexing pattern from [Envoy's resource groups](https://github.com/envoyproxy/go-control-plane/blob/main/pkg/cache/v3/resources.go) within the existing signed snapshot cache:

- Build a private hash-to-position map only after signature, schema, tenant and expiry checks pass. Preserve exact, case-sensitive hashes and first-match duplicate behavior. The index adds no signed or serialized fields and is published atomically with its generation.
- Keep authentication checks on every request: freshness, revoked/disabled/expired state, tenant and organization binding, scopes and project attribution. Do not cache authentication results or retain indexes across generations. Invalid refreshes preserve the previous generation and its original expiry.
- Retain a read-only linear fallback for manually constructed bundles; production verification always builds the index, including empty directories. Verify signed interoperability, refresh/revocation boundaries and concurrent reads/swaps under the race detector. Keep a reproducible benchmark for actual authentication and index construction costs.
- The prototype index costs about 0.42 MiB and 0.62–0.78 ms to build at 10,000 entries. No dependency, migration, protocol change or deployment change is required.

## Round 12 validation

- Three focused test groups verify signed lookup, first-match duplicates, exact hash case, empty directories, read-only manual fixtures and unchanged JSON/canonical HMAC. Four authentication groups with ten scenarios cover revoked/disabled/expired keys, removed scopes, changed tenant/organization/project, added/reordered/removed hashes and rejected tampered/expired refreshes. Sixteen concurrent readers observe coherent identities during 41 snapshot publications; the prior generation and existing identities remain unchanged.
- The retained benchmark compares full authentication on identical prewarmed directories using the production indexed path and the linear compatibility path. At 10,000 representative keys (5,760,436 serialized bytes), successful last-entry lookup measured 47.9–54.1 microseconds versus 0.479–0.672 microseconds, with the same 432 bytes/four allocations. Missing-key results varied more on the shared host (38.4–109.7 versus 0.256–0.270 microseconds), with unchanged 240 bytes/four allocations. Index construction measured 0.388–0.392 ms and 436,912 bytes. These are single-CPU Windows amd64 microbenchmarks, not end-to-end throughput or latency claims.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 27.345 seconds); the additional authentication file passed its focused checks and repeated concurrent-refresh run. Six TypeScript contract files passed all 70 tests. The independent-process PostgreSQL/TLS connector suite passed all nine groups (16.36 seconds).
- Final Linux `go test -race ./...` passed (Gateway 96.651 seconds), including the added concurrent authentication and signed-generation refresh tests.
- Go formatting, secret scan and diff checks passed. Independent production review found no blocking issues. No migration, dependency, signed-wire-format, TypeScript production or deployment change was made.

Round 12 was committed as `21476b3` and merged/pushed to main (`03dfbfa`).

## Round 13 design

`GATEWAY_UPSTREAM_TIMEOUT_SECONDS` reaches the adapter endpoint metadata but is never applied to execution. A real HTTP reproduction configured a 40 ms upstream attempt timeout, an 80 ms idle timeout and a one-second total timeout. An upstream that delayed its headers for 200 ms still returned a successful Gateway response after 220 ms. The existing endpoint contract describes this setting as the bound for one upstream attempt.

Use the separation of timeout responsibilities described in [Envoy's timeout guide](https://www.envoyproxy.io/docs/envoy/latest/faq/configuration/timeouts), retaining NexusAPI's documented whole-attempt semantics:

- Create the per-attempt context immediately before dispatch and keep it active through response streaming. Its parent retains the total execution deadline, client cancellation and channel lease cancellation. Release its timer with the attempt's load/probe/concurrency resources, including errors and safe pre-connection fallback.
- Preserve the separate idle timer and downstream write deadline. A stream making continued progress still respects its whole-attempt limit. Earlier parent deadlines win. Local connector transport observes the same request context.
- Report deadline expiry as the existing upstream-timeout error, including failures after streaming starts. Preserve observed usage, unknown execution state when work may have run, immutable accounting and the no-replay boundary after connection assignment. Do not turn timeout into permission to resend inference.
- Verify real delayed headers and ongoing streams through both public APIs, completion before the deadline, client cancellation and safe pre-connection fallback. No new environment variable, migration or dependency is required.

## Round 13 validation

- Four real HTTP delayed-header cases cover Chat/Responses and buffered/streaming requests. The former 200 responses after roughly 180–200 ms now return 504 under a 40 ms attempt limit, cancel the connected upstream, preserve one unknown execution and nullable v2 usage, and refuse the same idempotency key with 409. An eligible fallback is present but never receives the ambiguous request.
- Four continuously progressing streams previously ran about 900 ms despite a 150 ms attempt limit. They now stop at that limit, preserve partial output and the observed input count, leave missing output/total counts unknown, and record exactly one unknown terminal. Additional cases verify an earlier parent deadline, successful context release, a stalled 503 error body retaining known-failure status, and a pre-connection timeout followed by one actual execution with a fresh attempt deadline.
- Responses streaming retains its existing `server_error` enum with a static timeout message. The [official ResponseError contract](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_error.py) and existing truncation test were checked during review; internal accounting retains `upstream_timeout`. Arbitrary provider error messages are not relayed.
- The twelve new scenarios plus the existing Responses truncation check passed together (3.638 seconds). Full native `go test ./...` and `go vet ./...` passed (Gateway 29.833 seconds). Six TypeScript contract files passed all 70 tests. The independent-process PostgreSQL/TLS connector suite passed all nine groups (18.68 seconds), including cancellation, timeout and midstream failure.
- Final Linux `go test -race ./...` passed (Gateway 98.352 seconds), including independent attempt budgets, continuous output, parent cancellation and the existing connector lifecycle tests.
- Go formatting, secret scan and diff checks passed. Independent review found no remaining blocking issues. No migration, dependency, TypeScript production change or deployment was performed.
