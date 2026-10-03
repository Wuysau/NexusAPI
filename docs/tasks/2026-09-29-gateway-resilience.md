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

Round 13 was committed as `14d8925` and merged/pushed to main (`9fb5133`).

## Round 14 design

Three real upstream truncations or idle failures leave the channel breaker closed with a zero failure rate. The relay cancels the shared execution context while cleaning up a failed stream; its caller then interprets that cancellation as a reason to exclude the upstream failure from health tracking. This prevents later requests from avoiding a repeatedly broken stream.

Extend the existing [LiteLLM error-specific cooldown principle](https://docs.litellm.ai/docs/routing) to stream completion:

- Cancel the active attempt during relay cleanup, preserving the parent cancellation signal for health classification. The parent still represents client cancellation and the overall execution deadline; channel lease loss remains a canceled attempt. Each failure is recorded at most once.
- Count upstream truncation, malformed stream data, idle expiry and individual-attempt expiry toward the existing channel/model breaker. Keep client cancellation, parent timeouts and downstream delivery failures excluded. Existing thresholds, cooldown and half-open behavior remain unchanged.
- Verify that reaching the threshold changes only later request routing. Partial or ambiguous executions still produce one terminal record and never replay automatically. Verify exclusions separately. No schema, dependency or protocol change is needed.

## Round 14 validation

- Eight real HTTP cases cover truncation, malformed data, idle expiry and individual-attempt expiry in buffered and streaming Chat. All reproduced a closed breaker with zero failures before the change. Each now records exactly one failure per request, reaches the existing threshold after three failures, and sends only the following request to a healthy eligible fallback. Partial executions retain one attempt/terminal/outbox and their observed input count with unknown output/total counts; health stays isolated by channel/model.
- Ten separate Chat/Responses scenarios exercise client cancellation, ordinary and timeout downstream-write failures, and an earlier parent total deadline. Each cancels the real mock upstream and retains one unknown terminal while recording zero health samples/failures and leaving no probe slot held. Independent review found no blocking issue in these tests or the cancellation change.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 31.642 seconds). Six TypeScript contract files passed all 70 tests. The independent-process PostgreSQL/TLS connector suite passed all nine groups (18.60 seconds). Go formatting, secret scan and diff checks passed.
- Final Linux `go test -race ./...` passed (Gateway 100.958 seconds), including stream-health failures and all ten exclusion scenarios.
- No migration, dependency, public protocol, TypeScript production change or deployment was performed. The existing breaker thresholds, cooldown rules, authorization filters and no-replay boundary are unchanged.

Round 14 was committed as `2624130` and merged/pushed to main (`aaa031d`).

## Round 15 design

Three real PostgreSQL/TLS independent-process reproductions show management readiness contradicting live authorization. Disabling the provider hides both connector models from `/v1/models`, yet connection state still reports both ready and resources remain active/healthy. Restricting the channel to one model or an uninstalled model similarly leaves both models marked ready. These state-only checks performed no inference; the existing authorization correctly refused unavailable models.

Keep the existing resource projection and identities, applying the project's separation of transport health and model readiness:

- Derive display-ready models from the lease report intersected with current enabled and correctly bound local-sidecar channels, provider and credential. Validate stored model lists with the same strict rules used for live authorization. A malformed channel does not grant any models.
- A connection can have multiple channels: its readiness is the union of eligible channel approvals intersected with local readiness. A channel resource uses only its own approved models. Disabled resources cannot report healthy solely because another channel on the same connection is ready.
- Preserve online as recent authenticated transport evidence. Management readiness does not assume any particular downstream API key grants permission; each catalog/inference request retains existing live key/project/lease checks. No new resource identity, migration, credential flow or inference capability is introduced.
- Verify provider/credential disable, model intersections, malformed configuration, channel bindings, multiple channels and recovery against the real database and process boundary, alongside focused TypeScript projection tests.

## Round 15 validation

- The real PostgreSQL/TLS independent-process suite passed all eleven groups (12.90 seconds). Two added groups cover twelve state mutations and recovery, including provider/credential/channel disable, credential provider/organization bindings, model intersections, empty/malformed approval and local reports, and incorrect transport. Multiple-channel checks preserve connection-level unions, channel-specific readiness, disabled/unknown health, visibility and existing resource identities. These added state checks execute no inference and do not borrow authorization from an arbitrary project API key.
- Eight focused TypeScript unit/contract files passed all 126 tests, including 26 new projection cases and the existing 30 live connector authorization cases. New cases cover strict model-list handling, compatible state transitions, project/organization availability, channel-scoped queries and unchanged management visibility.
- Fourteen existing resource catalog/pool tests also passed, covering the base projection reused by the route (140 focused TypeScript tests in total).
- `npm run typecheck`, independent `tsc --noEmit --incremental false`, targeted ESLint/Prettier, secret scan and diff checks passed. Root and independent reviews found no remaining blocking issue. Existing Go binaries were rebuilt for the process suite; no Go source changed after Round 14's complete native/race validation.
- No migration, dependency, public resource identity or production deployment changed. Live inference authorization remains authoritative and is unchanged.

Round 15 was committed as `37c3a29` and merged/pushed to main (`dd28d39`).

## Round 16 design

The existing cancelable snapshot gate merges successful refreshes but serializes failures. A real HTTP source returning 503 after 30 ms caused sixteen concurrent cold-cache callers to fetch sixteen times over 517.53 ms; an expired-cache group took 495.96 ms. Individual waiting callers could cancel, and the old generation remained intact. Authentication precedes the execution timeout, so this queue can add many fetch-timeout periods during a Control Plane outage.

Apply the duplicate-work sharing pattern documented by [Go singleflight](https://pkg.go.dev/golang.org/x/sync/singleflight) within the current cache:

- Track one typed refresh result per scope under a short mutex. Concurrent Get and background refresh callers share that operation's success or failure. Clear it immediately on completion; new requests can recover without waiting for a negative-cache TTL.
- Keep the initiating caller's context and synchronous fetch lifecycle. Waiters observe their own cancellation without canceling someone else's fetch. Keep unrelated scopes independent and preserve background refresh of still-fresh directories for revocation propagation.
- Preserve signature, schema, tenant and receipt/verification expiry checks, atomic generation replacement, original last-good expiry and existing stale-state error contracts. Recheck freshness after waiting so delayed delivery cannot return an expired successful result.
- Verify deterministic concurrent HTTP failures, malformed envelopes, immediate recovery, mixed background/request callers, cancellation and scope isolation. No new dependency, migration or public protocol is required.

## Round 16 validation

- Four real HTTP cases cover cold/expired caches and 503/malformed responses with sixteen deterministically overlapping callers. Each previously fetched sixteen times; each now fetches once and permits the next request to recover immediately. A fifth case pauses delivery until the successful generation expires and verifies refusal without another fetch. These cases passed ten repetitions.
- Nine independent scenarios cover both Get/background ownership orders, success/failure sharing, still-fresh background updates, retained fresh/expired generations, independent waiter cancellation, shared owner cancellation with immediate later recovery, and unrelated tenant progress. The old implementation failed the duplicate-refresh and owner-cancellation assertions; the new implementation passed ten repetitions. Independent production and test reviews found no blocking issue.
- The original 30 ms delayed-503 HTTP fixture now performs one fetch for sixteen callers, measuring 52.83 ms cold and 30.54 ms expired on the shared host, versus the original 517.53/495.96 ms. Separate waiting callers still cancel in about 10 ms. These are local fault-fixture measurements, not production latency claims.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 26.629 seconds). Linux `go test -race ./...` passed (Gateway 94.872 seconds). Seventy TypeScript contract tests and all eleven independent-process PostgreSQL/TLS connector groups passed (17.04 seconds). Go formatting, secret scan and diff checks passed.
- No migration, dependency, TypeScript production change, deployment or authorization-policy change was made. Completed failures are not cached and successful shared results retain signed freshness checks.

Round 16 was committed as `edf02bb` and merged/pushed to main (`7f7d7fb`).

## Round 17 design

A real HTTP reproduction accepts a valid signed envelope followed by a second JSON value or garbage. It also accepts 8 MiB plus one byte by truncating the response before verification. The first envelope still requires a valid signature; the defect is accepting malformed or truncated transport as a successful configuration refresh.

- Read at most the existing size limit plus one byte and explicitly reject overflow. Apply the bound to the HTTP response body, including automatic decompression, independently of Content-Length or chunked transfer. Close every response body.
- Decode the entire envelope as one JSON document. Preserve whitespace, unknown envelope fields and the raw signed bundle's numeric representation. Keep signature, tenant, schema, expiry and last-good-state checks unchanged.
- Verify exact-limit acceptance, over-limit rejection, fixed-length/chunked/gzip transfers, bounded reading of an endless source, malformed tails and retained accepted generations. Error messages contain no response content.
- This completes the current configuration-validation boundary inspired by Envoy xDS; it does not introduce a new wire format, limit, dependency or migration. Go's [LimitReader](https://pkg.go.dev/io#LimitReader) stops at its configured byte count, so an extra byte is necessary to distinguish overflow from a complete body at the limit.

## Round 17 validation

- Fourteen HTTP/transport cases cover 8 MiB minus one byte, exactly 8 MiB and one byte over for Content-Length, chunked and gzip bodies; extra JSON/junk over both ordinary transfer forms; and bounded reads plus closure of an endless source. Eight assertions failed against the previous behavior, including all three oversized valid-prefix responses. All now pass, with the six within-limit controls remaining accepted.
- Thirteen independent envelope/cache scenarios cover malformed and multiple documents, safe error text, legal whitespace, additive envelope metadata, signed numeric literals and exact integers above float64 precision. Two actual authentication cases verify that rejected candidates cannot replace the prior key index, add keys, change accepted permissions or extend generation expiry. Existing fresh authority remains usable; expired authority refuses new authentication. Independent review found no blocking issue.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 26.774 seconds). Linux `go test -race ./...` passed (Gateway 100.518 seconds). Seventy TypeScript contract tests passed. All eleven independent-process PostgreSQL/TLS connector groups passed (17.80 seconds). Go formatting, secret scan and diff checks passed.
- No migration, dependency, TypeScript production, protocol-version or deployment change was made. The 8 MiB limit is unchanged; it now rejects overflow explicitly instead of accepting a truncated prefix.

Round 17 was committed as `9d9ff3e` and merged/pushed to main (`f76f44a`).

## Round 18 design

Four real HTTP cases show Chat `max_completion_tokens` and Responses `max_output_tokens` becoming `max_tokens` before reaching the provider. A mock enforcing the documented modern field rejects all buffered/streaming calls with HTTP 400. The [OpenAI contract](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) distinguishes these fields, and [Qwen](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) documents a difference between total generated tokens and answer-only limits. Renaming every explicit modern field therefore breaks both compatibility and meaning.

- Retain the effective cap used by native adapters and reservations, and preserve the explicitly supplied modern field in the canonical request. Compatible serialization emits one selected field, retaining modern precedence when both client fields are supplied and preserving null/omission behavior.
- Carry the existing signed Channel provider code into adapter endpoint metadata. [Ollama's OpenAI conversion](https://github.com/ollama/ollama/blob/main/openai/openai.go) and [DeepSeek's Chat contract](https://api-docs.deepseek.com/api/create-chat-completion/) currently use `max_tokens`; retain this known mapping. OpenAI, Qwen and custom providers retain explicit modern input. Do not infer provider behavior from a model name or URL.
- Keep the existing Router, native Anthropic/Gemini fields, effective reservation cap, usage facts, no-replay rule and local connector identity/authorization. Increment the shared compatible adapter version to 1.0.1; no schema, dependency, connector protocol or CLI upgrade is needed.
- Verify actual wire rejection/recovery, aliases/nulls/defaults, provider bindings, native compatibility and request immutability. Add a real PostgreSQL/TLS independent-process test proving modern Chat/Responses caps reach local Ollama as effective legacy limits with unchanged project attribution and unknown prices.

## Round 18 validation

- Twenty-six Gateway HTTP scenarios cover buffered/streaming Chat and Responses, modern/legacy/omitted/null input, existing modern precedence, and signed provider selection for Ollama, DeepSeek, Qwen and custom compatible channels. Every request succeeds exactly once, reserves with the expected effective cap and retains one completed attempt/terminal/outbox. The original four strict-modern mock cases all returned 400 before the fix and now pass.
- Independent adapter tests cover 26 named provider/field/native scenarios plus legacy-model and native-default controls. They verify signed provider precedence, adapter-code fallback, no model/URL guessing, unchanged model IDs and canonical requests, native cap retention and observable compatible adapter version 1.0.1. Eight field assertions failed against the old adapter. Production and HTTP test reviews found no blocking issue.
- The PostgreSQL/TLS independent-process connector suite passed all twelve groups (17.44 seconds). The added group sends four buffered/streaming Chat/Responses calls with distinct modern caps through the standalone CLI. Mock Ollama receives each effective `max_tokens` value, each request retains project/key/connection attribution, and all four attempts remain BYOK with unknown price versions.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 27.690 seconds). Linux `go test -race ./...` passed (Gateway 106.984 seconds). Seventy TypeScript contract tests, TypeScript typecheck, targeted ESLint/Prettier, Go formatting, secret scan and diff checks passed.
- No migration, dependency, production deployment, connector wire change or CLI upgrade was made. Responses remains the existing opt-in subset. Parameter rejection never permits inference replay under an alternative field name.

Round 18 was committed as `157eb3d` and merged/pushed to main (`41fc575`).

## Round 19 design

Real HTTP and standalone-connector reproductions show that the Gateway returns reasoning with an assistant tool call but drops it when the client sends that same message back with tool results. Both second turns return 400 from a mock enforcing the provider contract. [DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode/) requires this reasoning history during tool follow-ups; [Ollama's protocol conversion](https://github.com/ollama/ollama/blob/main/openai/openai.go) accepts it as `reasoning`. This extends the parameter-fidelity principle adopted from LiteLLM.

- Add an optional string pointer to canonical Chat messages, retaining explicit empty values and rejecting invalid types at ingress. Missing/null values remain omitted. Preserve history supplied by the caller without synthesizing placeholder reasoning or thinking controls.
- Serialize compatible history using a separate wire copy. Only a configured Ollama provider changes `reasoning_content` to `reasoning`; other compatible providers retain the original field. Keep tool IDs, names, fragmented arguments and tool results unchanged, and do not mutate a request another candidate may inspect.
- Refuse this unsupported history in current native Anthropic/Gemini adapters before credential access, reservation or execution. Increment all three adapter versions to 1.0.2. Keep the Responses input subset, authorization, single-instance connector limit, no-replay boundary and unknown usage/pricing rules unchanged.
- Verify full two-turn conversations, both response modes, multiple tools, field omission/type handling, provider identity selection, native rejection, canonical immutability and content privacy. Use the actual independent Gateway/CLI processes, TLS and PostgreSQL for connector acceptance.

## Round 19 validation

- Gateway HTTP tests cover four two-turn compatible conversations, four native rejection/recovery cases and four invalid history types. Previously valid history disappeared and unsupported native history silently executed; the new behavior preserves compatible calls and rejects incompatible ones before credentials or accounting. An undispatched idempotency key remains usable after correcting the request. Completed turns retain exactly one attempt and terminal event each, without reasoning in persisted facts or logs.
- Independent adapter matrices verify configured provider precedence, no URL/model guessing, both streaming flags, explicit empty/nonempty history, missing/null/invalid values, unchanged tool fields and canonical requests, and native rejection for all message roles. Existing requests without history remain compatible. Independent production and test review found no blocking issue.
- The PostgreSQL/TLS independent-process connector suite passed all thirteen groups (17.00 seconds). The new group exercises buffered and streaming two-turn conversations with two tools and fragmented arguments. All four calls retain project/key/connection attribution. First turns without reliable usage retain null token counts; second turns retain observed 5/2 counts; prices remain unknown. Reasoning, tool arguments and tool results are absent from outbox and final process logs.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 30.898 seconds). Linux `go test -race ./...` passed (Gateway 110.203 seconds). TypeScript full nonincremental typecheck, targeted ESLint/Prettier, seventy TypeScript contract tests, Go formatting, secret scan and diff checks passed.
- No migration, dependency, production deployment, connector wire change or CLI upgrade is required. Tests use mock provider contracts and do not establish live-model support for every tool or reasoning feature.

Round 19 was committed as `d1f7fd2` and merged/pushed to main (`3974ed8`).

## Round 20 design

A structured Chat request can complete normally with a model refusal. The [official structured-output contract](https://developers.openai.com/api/docs/guides/structured-outputs) represents this in a separate `refusal` field. Two real HTTP reproductions show NexusAPI dropping all refusal fragments and returning an empty successful completion in both response modes. This breaks callers that distinguish a refusal from schema-conforming output.

- Preserve refusal as a separate optional canonical field. Return Chat `delta.refusal` or aggregated `message.refusal`, including explicit empty values; omit absent/null refusal. Keep ordinary content and reasoning separate. A nonempty refusal is semantic output for first-token timing.
- Map the same result into the existing opt-in Responses path using refusal content parts and `response.refusal.delta` / `response.refusal.done` events. Retain content/item indexes, sequence numbers, completion validation and bounded final objects/events. Do not recast normal refusal as a provider transport error.
- Retain compatible Chat refusal history and allow assistant messages whose only content is a refusal. Accept the corresponding assistant Responses output part for continuation. Native adapters reject history they cannot preserve before credentials/reservation, as in Round 19. Increment adapter versions to 1.0.3.
- Include refusal in the existing buffered-output limits, including serialized JSON expansion. Direct Chat streaming remains incremental; Responses keeps its existing bounded retained output. Preserve cancellation, incomplete-stream errors, health classification, unknown usage/prices and no replay after dispatch. Refusal text stays outside logs, error details and accounting facts.
- Verify parser and actual HTTP behavior, response modes, empty/null/invalid fields, mixed outputs, multiple-turn history, size limits, cancellation and partial failures. Add an independent-process connector test to verify this representation through the unchanged TLS transport.

## Round 20 validation

- Twelve Chat HTTP scenarios verify normal refusal in both response modes with observed/unknown usage, explicit empty values, independent ordinary text, decoded/escaped size limits and partial-stream failures with an eligible fallback. Eleven failed assertions reproduced the missing output before the change. Successful refusals retain exactly one completed attempt/event per call, one first-output observation and zero breaker failures. Partial refusals remain unknown and are never replayed; content stays out of logs and persisted execution facts.
- Independent provider tests cover 29 leaf scenarios: byte-fragmented Unicode SSE, empty/null values, malformed types with static errors and prior usage, companion content/tools and compatible/native history. Twenty-two Gateway input scenarios verify provider fidelity, native pre-execution refusal, invalid types and the assistant-only missing-content exception. Corrected undispatched requests retain idempotency-key reuse.
- Nine Responses test groups verify typed content/event lifecycle and indexes, explicit empty versus null, ordering after pending tools, valid/invalid assistant history, escaped/terminal-event bounds, real HTTP two-turn conversations across both response modes and usage states, truncation and client cancellation. Five initial mapper assertions failed before the fix. Independent production/test reviews found no blocking issue.
- All fourteen PostgreSQL/TLS independent-process connector groups passed (17.20 seconds). The added group sends four Chat/Responses buffered/streaming calls, retaining dedicated refusal output, exactly four completed attributed executions, one unknown and three observed usage records, and unknown prices. Final process logs and outbox contain no refusal marker.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 30.196 seconds). Linux `go test -race ./...` passed (Gateway 118.208 seconds). Seventy TypeScript contract tests, full nonincremental TypeScript checking, targeted ESLint/Prettier, Go formatting, secret scan and diff checks passed. A test initially required strictly positive first-output latency; Windows returned valid zero-duration samples. It now verifies exactly one recorded observation per call and passed twenty repetitions.
- No migration, dependency, production deployment, connector wire change or CLI upgrade was made. Normal refusal is a result representation, not a new inference or tool-execution capability.

Round 20 was committed as `5810313` and merged/pushed to main (`1fd54c0`).

## Round 21 design

Eight direct `BuildRequest` probes show the native Anthropic adapter advertising vision while forwarding OpenAI `image_url` parts unchanged, including images inside tool results and assistant tool history. System/developer images disappear during text extraction. Native image blocks and ordinary text controls remain intact. A strict native HTTP fixture subsequently rejects eight converted-image cases, while thirteen unsupported-input cases execute instead of being rejected before credentials.

Use the protocol translation pattern demonstrated by [LiteLLM's image conversion](https://github.com/BerriAI/litellm/blob/cede93e826b2c352de62dcc3bbe725f9728d0352/litellm/litellm_core_utils/prompt_templates/factory.py#L828), following the [Anthropic image contract](https://platform.claude.com/docs/en/build-with-claude/vision):

- Convert supported canonical `image_url` parts into native `image/source` blocks, preserving array order, ordinary text, tool-result relationships and assistant tool calls. Reuse one pure conversion routine during candidate validation and request serialization. Do not mutate canonical messages or fetch, resolve, decode as an image or read media files on the Gateway.
- Support absolute HTTPS references without embedded user information and nonempty valid standard base64 data URIs for JPEG, PNG, GIF and WebP. HTTPS-only is this adapter's deliberately limited conversion surface, not a vendor-wide requirement. Requests remain subject to the existing ingress-size bound; provider image limits and model support still apply.
- Accept omitted/null/auto image detail; reject other detail settings and untranslatable canonical image options before credentials or reservation. Preserve already-native image blocks and their metadata as before. Their existence does not authorize new Gateway network or filesystem activity.
- Reject non-text system/developer content and additional fields that the current string-only system translation would discard. Ordinary text and supported native message/tool behavior remain compatible. Keep compatible OpenAI and Gemini adapters unchanged and increment only Anthropic's version to 1.0.4.
- Verify real HTTP wire shape for both response modes, local media endpoints receiving no connection, native controls, early safe rejection with idempotency-key reuse, canonical immutability, accounting and content privacy. No connector protocol, migration, dependency or new Responses multimodal capability is required.

## Round 21 validation

- Twenty-three real Gateway HTTP scenarios passed: ten buffered/streaming requests cover ordered URL/data images, assistant history, tool calls/results and existing native-image controls; thirteen unsupported system/developer, detail, URI, MIME, base64 and option cases fail before credential access, reservation or execution. A corrected text request can reuse its undispatched idempotency key. Eight wire cases and all thirteen rejection cases failed before the fix.
- A local TLS media server observes zero accepted connections during these requests. Each valid inference retains exactly one attributed completed attempt/outbox event and reservation; image references/data remain absent from logs and persisted execution facts. The fixture validates native wire shape rather than making a live-model image-quality claim.
- Five independent provider test groups cover 77 leaf scenarios, including all four supported media types, detail/null handling, malformed encodings and URLs, tool relationships, original native blocks/metadata and text controls. Repeated builds preserve both canonical JSON and original raw content bytes. Base64 validation streams decoded bytes to discard without retaining or interpreting an image. Root and independent production/test reviews found no blocking issue.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 29.934 seconds). Linux `go test -race ./...` passed (Gateway 122.980 seconds). Seventy TypeScript contract tests and all fourteen PostgreSQL/TLS independent-process connector groups passed (17.03 seconds). Go formatting, secret scan and diff checks passed.
- No TypeScript production, migration, dependency, connector protocol, CLI upgrade or production deployment changed. Existing native block pass-through is retained; canonical image conversion has the documented limited source/detail support.

Round 21 was committed as `3a43608` and merged/pushed to main (`2036022`).

## Round 22 design

Real HTTP probes expose a gap in Round 11's pre-execution validation: ten malformed tool/choice/history cases across v1 and v2 return HTTP 400 only after one credential resolution, reservation, failed terminal and outbox record, despite zero upstream calls. Correcting the request under the same idempotency key returns 409. Two Responses probes reproduce the same path. A request with another authorized compatible candidate can also be stopped by Anthropic's late build failure.

- Reuse Anthropic's existing pure tool and message conversion routines during candidate validation, before credentials, capture or reservation. Promote only failures already defined by those builders; do not introduce vendor JSON Schema validation or model-name heuristics.
- Return static typed field errors for `tools`, `tool_choice` or `messages`. Validate the existing requirement for at least one non-system/developer message at this same boundary. Keep missing/null/default options, valid strict flags, tool identities, images, text and native serialization unchanged.
- Let the existing Router select among remaining authorized compatible candidates after excluding an adapter that cannot represent the request. Preserve project/channel/payment rules and the no-replay boundary. A wholly rejected request remains undispatched and its idempotency key can be corrected.
- Increment only Anthropic to 1.0.5. Verify provider validation/build consistency, actual HTTP side effects across v1/v2 and Responses, authorized candidate selection and disabled-candidate refusal. No new execution capability, migration, dependency or connector change is required.

The existing validation contract accepts JSON null surrounded by whitespace, but the old tool builder compared raw bytes and sometimes rejected it. Tool, choice, parameter and message defaults now reuse the existing `missingOrNull` helper so equivalent JSON values keep equivalent behavior.

## Round 22 validation

- Twenty-eight Gateway scenarios passed after reproducing all twenty-eight failures on the old code. Twenty-two managed Chat cases cover eleven definition/choice/history/system-only failures in both v1 and v2. Two BYOK cases additionally verify no legacy durable claim or v2 request capture; two Responses cases exercise the same translation boundary. Invalid calls perform zero credential resolutions, reservations, request/attempt captures, terminal writes, outbox writes and upstream requests. Corrected calls reuse the same key and execute exactly once.
- Two candidate-selection cases verify that an enabled, authorized compatible channel can retain a tool-choice representation Anthropic cannot translate, while a disabled compatible channel cannot bypass eligibility. No Anthropic request or reservation is attempted before compatible selection.
- Six independent provider groups cover 74 scenarios with matching static typed validation/build errors, preserved canonical input, no-conversation rejection, defaults/null whitespace, existing strict flags, forced choice, empty tool history and schema pass-through. Full provider tests and independent production/test reviews passed with no blocking issue.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 31.100 seconds). Linux `go test -race ./...` passed (Gateway 129.034 seconds). Seventy TypeScript contract tests and all fourteen PostgreSQL/TLS independent-process connector groups passed (16.75 seconds). Go formatting, secret scan and diff checks passed.
- No migration, dependency, TypeScript production, connector wire, CLI upgrade, model execution capability, price rule or production deployment changed. Provider rejection after actual dispatch still follows the existing no-replay and accounting rules.

Round 22 was committed as `3e0876d` and merged/pushed to main (`6a922d6`).

## Round 23 design

Two signed-bundle HTTP probes identify waste and coupled scheduling in SnapshotCache. Thirty-two formerly authorized tenants still generate 96 refresh RPCs across three passes after their keys are disabled. Sixteen 20 ms tenant failures stretch the observed platform-directory refresh interval to 333 ms despite a 10 ms setting. Authentication correctly rejects the disabled keys; this is background work and propagation latency, not an authorization bypass.

Apply the explicit-interest concept in [Envoy xDS resource subscriptions](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol#unsubscribing-from-resources) without adopting a new protocol:

- Keep `WarmAll` as the existing explicit synchronous refresh of every known scope. Change `RunRefresher` to two fixed loops: one platform-directory loop and one serial tenant loop. Neither overlaps its own sweeps; both keep per-scope single-flight and context deadlines. Join the tenant worker before returning on cancellation.
- Register cancellation and a join for the outer refresher in the existing Gateway cleanup stack, so startup or listener shutdown also waits for these workers before releasing transports.
- Add `warmInterestedTenants` for the scheduled tenant sweep. A fresh, verified platform directory selects only already known tenants with at least one potentially authenticatable key. Reuse the existing key status, expiry and ownership-field checks, preserving first-hash-match semantics and multiple-key union. Do not invent project or scope authorization rules here.
- If the platform directory is missing or expired, conservatively refresh the known tenant set as before. A rejected replacement cannot erase accepted state. This may resume background requests for inactive historical tenants during a directory outage; it does not grant authentication or extend expiry.
- Retain all accepted tenant states and expiry values. Reactivated keys can resume the existing explicit legacy BYOK stale policy during a tenant-source outage. This round does not implement memory eviction or claim to bound process-lifetime cache retention.
- First obtain failing real-HTTP concurrency/interest tests, then implement shared key checks and bounded loops. Verify revocation while a tenant blocks, cancellation/join, bounded concurrency, same-scope single-flight, key-state/duplicate/unknown-scope cases, last-good retention and reactivation. Run full native Go, vet, Linux race, contract and independent-process connector checks before committing.

No schema, dependency, connector transport, public configuration or model execution behavior needs to change.

## Round 23 validation

- Twenty-eight signed-bundle HTTP interest cases pass. Sixteen fail under an overlay using the former unconditional tenant sweep. The cases cover revoked/disabled/expired/malformed-ownership keys, null defaults, first-hash precedence, multiple keys, ownership changes, known-scope enrollment and conservative fallback. Usage-only, empty-scope and unattributed keys retain the existing eligibility rules.
- Retiring a key stops periodic tenant requests without dropping or extending its retained snapshot. Actual Gateway HTTP calls reject the disabled key, then preserve explicit legacy BYOK stale execution after reauthorization, and recover normal attributed execution when a fresh tenant bundle becomes available. A rejected platform candidate cannot overwrite a still-fresh accepted interest decision. Explicit `WarmAll` remains unchanged.
- Four HTTP concurrency scenarios across three test functions exercise independent platform generations and authentication revocation while a tenant fetch is blocked, one background fetch per loop, foreground single-flight and cancellation. The refresher waits for cleanup of fetches it owns; stopping it leaves request-owned platform/tenant fetches able to complete and publish. The old serial refresher fails the platform-propagation probe.
- Full native `go test ./...` and `go vet ./...` passed (Gateway 31.481 seconds). Linux `go test -race ./...` passed (Gateway 135.657 seconds). The four concurrency scenarios also passed twenty consecutive targeted runs (4.868 seconds). Seventy TypeScript contract tests and fourteen PostgreSQL/TLS independent-process connector groups passed (17.59 seconds). Go formatting, secret scan and diff checks passed. Independent production and test reviews found no blocking issue.
- No migration, dependency, public configuration or connector protocol changed. Retained tenant memory remains unbounded by this scheduling change. During a platform-directory outage, conservative tenant refresh may include historical inactive scopes; authentication still requires a fresh directory.

Round 23 was committed as `74e02b8` and merged/pushed to main (`2637268`).

## Round 24 design

Real loopback Gateway + ConnectorHub + connectorclient + mock-upstream probes show a transport gap: `Retry-After: 12` gives direct 429 and 503 channels a 12-second cooldown, but a connector 429 uses the default 30 seconds and a connector 503 remains immediately available. Each probe executes upstream once. The connector currently sends only status in its metadata frame.

Extend the existing per-model cooldown approach illustrated by [LiteLLM PR 5358](https://github.com/BerriAI/litellm/pull/5358) across the local transport. Preserve the integer-seconds or HTTP-date semantics in [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3), plus NexusAPI's existing supported millisecond headers:

- Move the existing bounded parser to `internal/retryafter` with a `Parse` function and `MaxDelay` constant. Keep the provider's private wrapper and existing parser/adapter tests. Add no dependency and do not make the CLI depend on all provider adapters.
- Add optional `retry_after_ms` as int64 to connector metadata. For 429/503 only, the CLI converts the supported upstream headers to a positive duration capped at 60 seconds, rounds up to milliseconds and sends that number. Raw headers, cookies, error bodies and private credentials remain local.
- The Hub considers the field only for 429/503, ignores nonpositive values, caps positive integers before formatting or arithmetic, and creates a numeric internal `retry-after-ms` header. Existing provider classification and the breaker decide cooldown for later requests; do not change replay, authorization or accounting paths.
- Missing/null values preserve old behavior. Malformed types or out-of-range int64 values fail through the existing frame decoder. An old CLI omits the field and an old Gateway ignores it; calls remain compatible in either upgrade order. Both components must be upgraded for hints to take effect.
- Verify real HTTP cooldown parity, default/no-hint handling, subsequent routing and recovery, per-model isolation, raw-header/body privacy, metadata integer boundaries, malformed frames, old decoder compatibility and one upstream execution. Add a PostgreSQL/TLS independent-process scenario and run Go, race, TypeScript and connector checks before committing.

HTTP dates are interpreted against the connector host's clock. Millisecond rounding and transfer latency mean this is a bounded relative hint, not an exact deadline shared across machines. No migration, lease change, new configuration or automatic inference retry is required.

## Round 24 validation

- The original four real HTTP probes now all produce the requested 12-second cooldown for direct and connector 429/503 paths, with one upstream call each. Two formal Client + Hub + Gateway cases additionally verify that later requests during cooldown produce no execution facts, another model remains available, and one successful half-open probe restores the cooled model. BYOK attribution, unknown failed usage and observed successful usage retain null prices.
- Thirty-five Hub HTTP/frame cases pass, including missing/null/negative values, MaxInt64 clamping before arithmetic, other statuses, malformed integer types, overflow and unknown private metadata. Nineteen fail under the prior Hub overlay. The existing upload tests plus these cases pass five repetitions.
- Sixty-five connector-client scenarios pass across real HTTP execution, the running lease/poll/upload lifecycle, privacy, old-frame decoding and sub-millisecond date rounding. Twenty-five wire scenarios fail under the prior Client overlay. Ten targeted repetitions and the complete connectorclient package pass. The existing eighteen parser cases continue to cover the shared implementation through the provider wrapper. Independent production and test reviews found no blocking issue.
- Fifteen PostgreSQL/TLS independent-process connector groups pass (23.06 seconds). The new group covers both statuses with a 1500 ms primary hint and 60-second secondary header, subsequent suppression, model isolation, recovery and six attributed executions. Suppressed requests have no attempts or outbox events; two failed executions retain unknown usage and four successful executions retain observed 5/2 usage. Private headers and error bodies stay absent from responses, logs and event payloads.
- Full native `go test ./...` and `go vet ./...` pass (Gateway 35.061 seconds). Linux `go test -race ./...` passes (Gateway 139.613 seconds). Seventy TypeScript contract tests, `npx tsc --noEmit --incremental false`, ESLint, Prettier, Go formatting, secret scan and diff checks pass.
- No schema, dependency, authorization, price rule or automatic-retry behavior changes. The optional metadata remains compatible with either older endpoint; both upgraded components are required to carry hints. Cooldown remains per Gateway process and HTTP-date timing remains relative to the connector host.

Round 24 was committed as `5a97ba9` and merged/pushed to main (`6d1fe1e`).

## Round 25 design

A separate connector-owned deadline can expire before the Gateway's attempt/idle deadlines. Four real HTTP probes show the existing pre-header path correctly returning `upstream_timeout`, while a body-read timeout after partial SSE content loses its cause and becomes `upstream_protocol_error`. Both paths already cancel the local inference and persist one unknown terminal without replay; the defect is error classification.

- In the connector's non-EOF read-error branch, use the existing static `timeout` frame code when the read error or local job context reports `context.DeadlineExceeded`. Preserve normal EOF, other I/O errors and ordinary cancellation behavior.
- Reuse the Hub's existing timeout mapping and Gateway Chat/Responses error handling. No new field, error text, protocol version, retry or authorization path is required. Already-started streams retain their HTTP status and partial content, then emit the existing terminal timeout event.
- Verify the actual CLI/Hub/Gateway path with local deadlines shorter than Gateway budgets: pre-header controls, buffered and streaming Chat/Responses, prompt privacy, one execution/terminal/outbox and the existing unknown/unpriced rules. Retain observed usage when present. Cover normal completion, disconnects and caller/lease/process cancellation so they do not become timeouts.
- Extend the independent-process connector timeout coverage, run native Go/vet, Linux race, TypeScript and connector checks, then commit. Keep unrelated behavior and the current single-Gateway deployment boundary unchanged.

The expanded HTTP tests exposed an additional cleanup race: after accepting a terminal timeout frame, Hub cancellation closed the pipe reader before the response consumer read the writer's error. Go then returned `io.ErrClosedPipe`, hiding the timeout. A deterministic probe waits for job cleanup before reading the body and reproduces this every time. Keep reader closure with the response consumer; context cleanup closes the writer, which wakes blocked reads/writes while preserving its first terminal error. The upload context watcher also uses the job's actual context error instead of hard-coding cancellation. Verify delayed reads for timeout, generic failures, normal completion and cancellation before completing this round.

## Round 25 validation

- Eight real Client + Hub + Gateway HTTP cases cover Chat/Responses, buffered/streaming replies and deadlines before/after response headers. Four body-timeout cases fail with the former Client implementation; the four pre-header controls already pass. Buffered errors retain 504, started streams retain partial output and their existing terminal timeout event, and each execution produces one attributed unknown terminal/outbox. Observed input usage survives when present; absent output usage and prices remain unknown. An eligible fallback stays unused and duplicate idempotency keys do not replay the call.
- Four deterministic Hub cases deliberately wait for job cleanup before reading the response body. Timeout, unavailable, normal EOF and caller cancellation all fail with the former reader-closing cleanup and pass with the corrected ownership. Twenty repetitions pass. The combined twelve HTTP scenarios pass in 10.994 seconds; independent production and test reviews found no blocking issue.
- Ten connector-client scenarios cover actual local deadlines after headers, wrapped timeout errors, ordinary I/O errors, EOF and caller/lease/process cancellation. Four timeout cases fail against the former Client implementation. Five targeted repetitions and the complete connectorclient package pass; raw errors, paths and private values stay absent from uploaded frames.
- Sixteen PostgreSQL/TLS independent-process connector groups pass on the final production code (26.33 seconds). The new group keeps chunks arriving inside the Gateway idle budget until the shorter local deadline expires, then verifies buffered and streamed timeout results, local cancellation, two attributed unknown terminals/outbox events and no prompt or private-error disclosure.
- Full native `go test ./...` and `go vet ./...` pass (Gateway 42.890 seconds). Linux `go test -race ./...` passes (Gateway 149.025 seconds). Seventy TypeScript contract tests, `npx tsc --noEmit --incremental false`, targeted ESLint/Prettier, Go formatting, secret scan and diff checks pass.
- No migration, dependency, frame field, public configuration, authorization, price rule or retry behavior changes. Existing single-Gateway connector deployment constraints remain in effect.

Round 25 was committed as `d91ba78` and merged/pushed to main (`627b4e4`).

## Round 26 design

The console's connector test route gives its Gateway fetch a 60-second timeout but drops the incoming request's cancellation signal. Real route calls with a loopback HTTP Gateway reproduce three failures: an already-aborted request still executes successfully, and cancellation during header wait or response-body reading leaves the request running until the test server releases it. All three can then report success and query the attempt attribution after the caller has canceled.

Follow the signal-composition pattern in [Vercel AI SDK](https://github.com/vercel/ai/blob/main/packages/ai/src/util/merge-abort-signals.ts) and the request-lifetime propagation already exposed by [Next.js's request adapter](https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/spec-extension/adapters/next-request.ts). Use Node's supported `AbortSignal.any` to combine `req.signal` with the existing 60-second timeout at the fetch boundary. Preserve permission checks, project-key validation, static error responses, successful attribution checks and the Gateway's existing cancellation/accounting rules. This adds no retry or separate cancel endpoint.

Verify actual HTTP dispatch and connection closure for pre-aborted, header-wait and body-read cases, independent deadline expiry, normal success and permission failures. The route must not perform a success-attribution lookup after its fetch is canceled. Cancellation stops further work when received; it cannot erase usage already incurred. This change does not claim that closing a client-side panel necessarily cancels its outstanding browser request, nor that every deployment proxy forwards disconnects identically.

## Round 26 validation

- Nine route scenarios use the real HTTP fetch and loopback Gateway while substituting only authority/database fixtures. The former route fails the three cancellation cases; six deadline, success, permission and error controls pass. The body-read case waits until the real `response.json()` starts on incomplete JSON before canceling. Canceled calls close the unfinished HTTP connection, make no success-attribution query, disclose no private reason and execute at most once. A pre-aborted call makes no Gateway request.
- The unchanged 60,000 ms timeout is verified independently with a short real deadline; successful calls retain their scoped attribution lookup. Permission/project-key rejection, sanitized upstream failure and different-channel reporting retain their existing behavior. Independent production and test reviews found no blocking issue.
- A separate Node HTTP probe using the installed Next.js signal helper confirms disconnect propagation before headers and during body reading, and verifies that normal response completion does not abort. This exercises the actual helper and HTTP sockets, not a full `next start` deployment or a reverse proxy.
- The final combined connector/control-plane/contract run passes 348 tests across 29 files (9.86 seconds). All sixteen PostgreSQL/TLS independent-process connector groups pass (23.32 seconds). Go implementation and migration files are unchanged; the full Go/vet/race checks from Round 25 remain applicable.
- Final targeted route tests pass 9/9 after a test-helper timer typing correction (802 ms). `npx tsc --noEmit --incremental false`, targeted ESLint/Prettier, secret scan and diff checks pass. No dependency, database, public API or deployment configuration changed.

Round 26 was committed as `3b16b87` and merged/pushed to main (`b295084`).

## Round 27 design

Two real HTTP probes expose remaining gaps in native request preflight. First, Anthropic and Gemini silently drop nonempty Chat participant names, execute upstream and report success, while the OpenAI-compatible control preserves both names. [OpenAI documents names](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) as model-visible differentiation between participants sharing a role. Second, Gemini already refuses system/developer-only input during request building, but does so after credential resolution, reservation and failure recording. A corrected call using the same idempotency key is then rejected as a duplicate even though no upstream inference occurred.

Extend the existing [LiteLLM-inspired parameter-fidelity checks](https://docs.litellm.ai/docs/completion/drop_params):

- In each native validator, reject nonempty `Message.Name` with the existing static `unsupported_parameter` on `messages`. Preserve absent/null/empty string behavior and compatible serialization. Do not synthesize names into prompt text or claim a new native capability.
- Move Gemini's known requirement for at least one non-system/developer message into `ValidateRequest`, matching its existing request builder. Retain its current accepted roles/content subset and defensive build check; add no new vendor policy.
- Keep filtering within the existing authorized, healthy, billable candidate list, before credentials, durable execution claims or budget reservation. A compatible candidate may still carry the original names. Disabled or unauthorized candidates cannot become a workaround.
- Bump only the two changed native adapter versions, Anthropic to 1.0.6 and Gemini to 1.0.4. No new canonical field, migration, dependency, retry behavior or connector protocol is needed.
- Verify static errors, unchanged input, native and compatible wire behavior, Chat/Responses and v1/v2/BYOK execution boundaries. Corrected undispatched requests must reuse the same idempotency key successfully. Run full native Go/vet, Linux race, TypeScript contracts and independent-process connector regression before committing.

## Round 27 validation

- Fourteen Gateway HTTP scenarios fail on the old implementation and pass after the fix. They cover named native history, Gemini Chat/Responses with only instructions, v1/v2 managed traffic and representative BYOK paths. Rejection creates no credential resolution, reservation, durable claim, request/attempt capture, terminal, outbox event or upstream request; shared health stays unchanged. Correcting the same idempotency key produces one completed, attributed execution. Managed v2 attribution remains in the budget reservation; BYOK v2 retains its Gateway capture.
- Four candidate-selection cases prefer a native channel but use the original named history only when an eligible compatible candidate exists. Disabling that candidate prevents execution. Actual compatible HTTP bodies retain names/content. The fourteen scenarios also pass five consecutive runs (2.101 seconds).
- Twenty-nine provider scenarios cover names across roles, whitespace, absent/null/empty defaults, compatible OpenAI/Ollama messages, empty Gemini conversation and valid user/assistant controls. Sixteen fail on the old validators; thirteen controls already pass. Validation/build errors are static and canonical input remains unchanged. The full provider package and provider vet pass; independent production and test reviews found no blocking issue.
- Full native `go test ./...` passes (Gateway 40.643 seconds), as do `go vet ./...`, Linux `go test -race ./...` (Gateway 149.543 seconds), seventy TypeScript contract tests and all sixteen PostgreSQL/TLS independent-process connector groups (26.45 seconds). Go formatting, secret scan and diff checks pass. One synthetic test credential initially exceeded the scanner's literal-length rule; it was replaced with an existing short fixture value without changing scanner rules, and all twenty-nine provider cases passed again.
- No TypeScript production, schema, dependency, price rule, connector protocol or inference retry behavior changed. The native versions expose the changed validation behavior; compatible adapter versions remain unchanged.

Round 27 was committed as `cf59d2e` and merged/pushed to main (`fcdff2a`).

## Round 28 design

Round 26 propagates an incoming cancellation through the console test route, but the current browser panel never sends one. Closing its dialog only clears polling timers; an already dispatched test and its asynchronous UI callbacks continue. Add an explicit user control and tie local request ownership to the panel lifetime.

- Keep the existing `apiSend` signal parameter. Give each test its own AbortController and retained identity. Show a cancel action only during a test, clear the key and release the busy state on cancellation, and use a fixed message that does not imply already incurred usage was undone.
- Invalidate the request identity before aborting. Every continuation checks both panel lifetime and request identity before changing state, so a delayed success, failure or `finally` from a canceled call cannot overwrite a new test or its key. Check cancellation before reading a possibly absent parsed response.
- Give polling GET requests a panel-lifetime signal. On unmount, cancel polling and the current test, and ignore late results. Key the panel by connection ID to reset state when switching connections. Preserve pairing authorization and dispatched mutation behavior; ignore pairing UI updates after its panel is gone.
- Reuse current components, styles, permission checks and the real project API Key path. No cancel endpoint, browser credential storage, global API helper change or automatic replay is required.
- Use the existing Playwright/Next setup for explicit cancel, dialog unmount, retry and stale-result checks. At least one test must reach a real Next route and a loopback HTTP Gateway before cancellation and observe that upstream connection closing. UI stubs may test display races but cannot establish server propagation. Retain the separate Go/CLI end-to-end regression for actual model execution and accounting.

## Round 28 validation

- `node tests/e2e/local-connector-cancel.mjs` passes nine browser groups against Chromium, the actual Next application and the dedicated PostgreSQL fixture. Four requests reach the real console POST route and a loopback mock Gateway: explicit cancel before headers, cancel after partial JSON is sent, closing the dialog and Escape. Each closes the unfinished Gateway connection and dispatches exactly once. These browser cases do not run a Go inference or claim a production-proxy test.
- Separate, explicitly stubbed UI controls verify reopening after unmount, immediate completion while a background status GET is held, and a deliberately delayed old promise. Releasing the canceled result cannot display its message, erase a new Key, unlock the newer request or hide its cancel action. The newer result completes normally. A wrong-project key is rejected by the real route without Gateway dispatch; project viewers retain test controls while pairing stays forbidden, and revocation hides test controls.
- The browser fixture creates its own connection/identity/lease through real routes and marks only that test lease transport-fresh. It verifies zero attempt rows for that connection, creates no synthetic usage, stops its Next process and disables its fixture keys/lease. Generated Next type-path changes are restored without overwriting unrelated edits. The cancel screenshot was visually reviewed with an empty Key input and clear cancellation notice.
- The first setup used a Webpack development mode incompatible with the existing CSP, so it was changed to the repository's default Turbopack. Viewer project membership and the revoked-row selector were also corrected in the test fixture. No CSP, authorization or production configuration was relaxed. This new UI feature did not use an old-component RED overlay.
- All 348 related TypeScript unit/contract tests pass (9.71 seconds). Non-incremental TypeScript, targeted ESLint/Prettier, secret scan and diff checks pass. Go, connector transport, control-plane test-route logic and migrations are unchanged from the already verified preceding rounds. No dependency or global API-helper behavior changes.

Round 28 was committed as `8f177cb` and merged/pushed to main (`c2c5982`).

## Round 29 design

The browser API helper catches every `Response.json()` failure and returns `null` for successful HTTP statuses. A real loopback HTTP probe reproduces canceled body reads, broken connections and malformed JSON as fulfilled promises. Await-only mutation callers can then announce success; typed callers can fail later with an unrelated property-access error. This does not establish whether a dispatched server mutation succeeded.

- Keep failure semantics at the shared parsing boundary, following the [Fetch body consumption contract](https://fetch.spec.whatwg.org/#concept-body-consume-body). A successful status requires a readable JSON body, except explicit 204/205 no-content responses. Valid JSON `null` remains valid.
- Preserve the actual `AbortError`. Normalize other successful-response body failures to a fixed `invalid_response` ApiError that retains the received HTTP status and asks the user to refresh and check the result. Do not expose parser excerpts or raw transport errors.
- Preserve existing non-success status/error normalization, authentication handling, request signatures and CSRF behavior. No automatic retry, mutation replay, new dependency or generic response-schema assertion is needed.
- Add native-fetch HTTP regressions with deterministic body-consumption gates, including normal JSON/no-content and non-success controls. Repeat the connector browser lifecycle suite because it uses this shared helper, then run relevant TypeScript, lint, format and privacy checks. Go and database schemas are unchanged.

## Round 29 validation

- Thirty-two native-fetch HTTP scenarios pass (323 ms). The same complete test file against an isolated copy of the old helper fails fourteen defect assertions and passes eighteen compatibility controls (341 ms). Tests cover both GET and mutations, cancellation after actual body consumption starts, broken responses, malformed/empty/whitespace JSON, gzip decoding failure, and prevention of false success or later token dereference. Cancellation retains the exact original `AbortError`; other failures retain the received 200/201/202 status with a fixed message.
- Valid objects, null, scalar false, 204/205, structured 401/403, non-JSON 502 and canceled non-success bodies retain their existing behavior. Every HTTP fixture checks one dispatch and closes its connections. No response excerpts are added to public errors, and two independent reviews found no blocking issue.
- `npx vitest run src/components/lib src/lib/connectors src/app/api/connections tests/contract --reporter=dot` passes 391 tests across 31 files (10.78 seconds). Non-incremental TypeScript, targeted ESLint/Prettier, secret scan and diff checks pass.
- The existing nine-group Chromium/Next connector cancellation suite passes again using the dedicated PostgreSQL fixture. Its four real console-to-mock-Gateway disconnects remain single-dispatch, while UI race and permission controls still pass. This is a browser compatibility check; the new helper body failures are established by the separate native-fetch tests. The fixture stopped its Next process and restored generated types.
- No Go, migration, dependency, server error contract or retry policy changed. The local browser error is documented separately from server responses; a lost response cannot establish whether a mutation was applied.

Round 29 was committed as `be7e31a` and merged/pushed to main (`c2459b6`).

## Round 30 design

A React/Chromium probe importing the actual routing page reproduces a project-selection mismatch: after selecting project B, project A's policy stays visible while B loads and after B fails. The shared `useApiData` effect cancels obsolete work, but its retained data, error, permission and timestamp states have no request-path identity. A disabled `null` path also leaves its previous result visible. Seven checks reproduce these defects; same-URL refresh failure correctly retains the previous result and must remain supported.

- Follow [TanStack Query's query-key principle](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys) within the existing hook: one state record binds all result fields to the exact path. Reset it conditionally during rendering when the path changes, using [React's documented state-adjustment pattern](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes), so children never commit a new path with old data.
- Disabled paths expose empty data/error/permission/timestamp state and do not request. Re-enabling begins a new load. Preserve same-path last-good data and timestamp during refresh failure; use the success timestamp to distinguish an unfetched result from valid JSON null.
- Keep `reload` stable for polling callers. Retain per-effect cancellation and add captured-path checks to asynchronous state updates. No query cache, automatic retry, dependency or new authorization path is needed.
- Remove the overview page's redundant refresh counter from its URL. The hook already listens to the global counter; the endpoint reads only `days` and responds with `no-store`. Date-range changes still form a different query, while same-range refresh retains last-good behavior.
- Verify committed React states, path disable/re-enable, delayed old results, same-path refresh and the actual routing-page display. Component browser fixtures establish UI lifetime behavior; they do not replace the existing Next/Gateway authorization tests.

## Round 30 validation

- `node tests/e2e/api-data-scope.mjs` passes nine groups (4.12 seconds), importing the real hook, RefreshProvider, SessionProvider and RoutingPage under React StrictMode and Chromium. Loopback HTTP gates control responses; only Next Link/CSS need harness adapters. No Next server, database, authorization bypass or model execution is claimed.
- The same formal suite against a `git show HEAD` copy of the old hook, loaded through an explicit esbuild overlay, fails six groups and passes three compatibility controls. The overlay never replaces workspace production code. Old ABA and 401 cases fail first on retained cross-path state; they do not establish a failure of the original cancellation guard.
- Layout-effect records verify that every committed state for a newly selected path has no previous data, timestamp, error or forbidden flag. A null path clears state and local/global refresh dispatches nothing. Both same-path refresh mechanisms retain last-good data/time on 503 and recover, including a successful JSON null result. The reload callback remains stable.
- Deliberately delayed, already-read browser promises verify obsolete success/error/finally cannot affect a newer A request after A→B→A. A held 401 session refresh cannot finish a newer B request's loading state. The actual RoutingPage hides A's policy while B waits or fails and shows B after a successful retry. Fixtures close Chromium and their HTTP listener, including launch failure cleanup.
- All 391 related TypeScript tests pass again (10.79 seconds). Non-incremental TypeScript, targeted ESLint/Prettier, secret scan and diff checks pass. Independent hook/caller reviews found no blocking issue. No Go, database, API response, dependency or retry behavior changed.

Round 30 was committed as `fcc084c` and merged/pushed to main (`9603136`).

## Round 31 design

An actual DashboardLayout/Topbar/LoginScreen/ReauthDialog browser probe reproduces three stale session reads: a delayed authenticated response restores the UI after logout, overwrites a newly logged-in viewer with the previous owner, and reverses a successful fresh-auth display. The provider survives the shell's switch to LoginScreen, so its initial effect cleanup does not protect later refreshes. These are confirmed client-state errors, not demonstrated server authorization bypasses.

- Apply [SWR's separation of read ordering and mutation boundaries](https://github.com/vercel/swr/blob/main/src/index/use-swr.ts) inside the existing SessionProvider. Each explicit auth operation changes its intent identity and invalidates the current session GET; each GET also has its own identity. A response may update state only while its provider lifetime, intent and read are current.
- During a login/logout/reauth POST, ordinary refresh returns without dispatching or superseding that operation. Only the current successful login/reauth can start its follow-up session read. Retain one POST per requested operation and do not add POST cancellation or replay.
- Superseded login/reauth promises reject with a fixed AbortError, preventing stale `onSuccess` callbacks such as a high-risk action retry. Logout retains its nonthrowing behavior and only the current operation may show anonymous state. The public `error` action also invalidates pending reads and operations.
- Reuse the guarded reader for initial loading. Each effect setup has its own lifetime, with cleanup invalidating reads and pending continuations under StrictMode and unmount. Preserve current error normalization and capability derivation.
- Verify real UI races, native HTTP cancellation, deliberately late consumed-body promises, pending-mutation refresh suppression and normal success/failure controls. Re-run both query-scope browser tests and the actual Next connector console flow. Client guards cannot undo a dispatched server mutation or a late browser Set-Cookie response; server authorization remains authoritative.

## Round 31 validation

- `node tests/e2e/session-lifecycle.mjs` passes thirteen browser groups. It imports the real DashboardLayout, Topbar, LoginScreen, ReauthDialog, SessionProvider and high-risk action hook under React StrictMode against controlled loopback HTTP. An isolated old-provider overlay fails all three Dashboard race cases; workspace production is never replaced. This component fixture does not test a Next authorization service or a browser Set-Cookie race.
- Consumed-body promise gates establish that stale reads cannot restore logout, replace a newly logged-in viewer with the former owner, or undo fresh-auth display. Native body-read fixtures prove superseding reads, explicit errors and unmount close the HTTP connection. Late failures cannot clear a newer identity, and obsolete POST continuations cannot unlock a newer mutation or trigger another session GET.
- The real ReauthDialog rejects a superseded completion and invokes neither its success callback nor the high-risk retry. A login superseded by provider unmount returns the fixed AbortError, with one POST and no subsequent GET. Current login/reauth error codes and statuses remain intact; malformed reads use the existing static invalid-response error, and logout failure remains nonthrowing and anonymous.
- The initial StrictMode test originally required two dispatched GETs. The guarded startup microtask correctly prevents the obsolete setup from dispatching, so the final test verifies two setup lifetimes, one surviving initial GET and a working subsequent refresh. No lint rule is suppressed. Chromium and all fixture HTTP listeners are closed.
- Existing query-scope browser regression passes 9/9 (4.40 seconds), and the dedicated PostgreSQL/actual Next connector browser flow passes 9/9, including four single-dispatch disconnects and zero synthetic usage. The Next process stopped, generated types were restored and the fixture database was released.
- All 391 related TypeScript tests pass (10.87 seconds). Final non-incremental TypeScript, targeted ESLint/Prettier, secret scan and diff checks pass. Independent production and test reviews found no remaining blocker. No Go, schema, dependency, server credential or retry policy changed.

Round 31 was committed as `52c25fd` and merged/pushed to main (`1642095`).

## Round 32 design

The shared provider SSE reader recognizes LF/CRLF but does not split standalone CR lines allowed by the [SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream). Twelve actual Gateway/upstream HTTP cases differ only in line endings: eight LF/CRLF controls complete with content and observed usage, while four CR Chat/Responses buffered/streaming cases lose content and become protocol failures. This establishes a compatibility defect, not a claim that default Ollama emits CR.

- Extend the existing reader to recognize CR immediately and suppress one optional following LF across buffer and event boundaries. Follow the incremental-line principle in [OpenAI Node SDK v7.27.0](https://github.com/openai/openai-node/blob/v7.27.0/src/internal/decoders/line.ts) using original Go code. Retain incomplete-event EOF discard and provider completion checks; do not adopt the SDK's separate EOF compatibility extension.
- Preserve the 1 MiB wire-byte bound, counting comments, unknown fields and framing. A CR that closes a blank line reserves one possible following LF byte before dispatch. This avoids waiting for lookahead or charging a deferred LF to the next event. At the new CR-only exact-limit edge, the allowed block is conservatively one byte smaller; existing LF/CRLF boundaries remain unchanged. Document and test this explicit resource-limit tradeoff.
- Preserve UTF-8 bytes, multiline data, arbitrary fragmentation, event metadata, cancellation, unknown usage, existing health classification and no-replay rules. A valid completed CR response follows the normal content/observed-usage path. No new adapter, dependency, schema or request field is needed.
- Formalize the twelve Gateway HTTP cases and provider boundary probes, including paused CR dispatch, split CRLF, mixed endings, exact-limit next events and EOF/error controls. Measure common LF parser cost before choosing a loop implementation, then run full Go/vet/race, contract and independent-process connector regression.

## Round 32 validation

- The formal twelve-case Gateway/upstream HTTP suite fails the four CR cases against the previous reader and passes the eight LF/CRLF controls. With the repair, all twelve pass, preserving Chat content/stop/DONE or Responses completed lifecycle, exact observed usage 5/2/7, tenant/organization/key/channel/connection/provider attribution and healthy channel state. Each has one capture, attempt, terminal and outbox entry, zero eligible fallback calls and no managed budget reservation. Synthetic content and credentials remain absent from execution facts and logs.
- Eight provider test groups cover CR/LF/CRLF, mixed endings, one-byte UTF-8 fragments, immediate CR dispatch through a still-open pipe, delayed LF suppression, raw-size boundaries, comments/unknown fields, incomplete-event discard and upstream errors. Native OpenAI/Anthropic/Gemini CR completion/truncation controls preserve observed partial usage. The boundary suite passes ten repetitions, and the Gateway HTTP suite passes five. Independent reader and test reviews found no blocker.
- The initial per-byte prototype was rejected after an isolated common-LF benchmark showed 7.73 times the old CPU cost and nineteen additional allocations at 64 KiB. Buffered scanning with two `IndexByte` searches reduced the adjacent chunk prototype's 64 KiB median by 26.6%, with unchanged allocations. The committed `BenchmarkSSELineEndings` verifies the full payload each operation: Windows amd64 median LF is 5.197 microseconds at 1 KiB and 46.495 microseconds at 64 KiB, with five and six allocations respectively. These local parser measurements do not establish end-to-end performance, and the payload-validating benchmark is not an exact comparison with the earlier research fixture.
- Final `go test ./...` passes (Gateway 49.818 seconds), followed by `go vet ./...`. Linux `go test -race ./...` passes (Gateway 152.378 seconds, provider 6.754 seconds). All seventy related TypeScript contract tests pass (2.27 seconds), and all sixteen dedicated PostgreSQL/independent Gateway/CLI/TLS/mock-Ollama integration groups pass (27.24 seconds). Existing twenty-six migrations are exercised by the fixture; no migration was added or modified.
- Docker initially failed to start on an inaccessible stale runtime socket. After verifying the engine was stopped and the runtime directory contained only zero-byte endpoints, its `run` directory was preserved under a dated backup and recreated. The original containers and volumes remained available; only the dedicated test PostgreSQL/Redis were started. No persistent data reset or Docker upgrade was performed.
- Go formatting, secret scan and diff checks pass. No new dependency, adapter version, request field, credential access, authorization path, pricing rule or connector deployment mode was introduced. The connector's explicit single-Gateway restriction remains in effect.

Round 32 was committed as `c259b4d` and merged/pushed to main (`5adb5e0`).

## Round 33 design

Eight Gateway/upstream HTTP probes reproduce silent loss from an initial UTF-8 BOM: the four no-BOM controls preserve content and observed usage, while the four BOM cases discard their first content or usage event and still report completed. This is a parser defect; it is not evidence that a default Ollama installation emits a BOM. The [SSE interpretation specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation) requires removing only one leading BOM from the stream.

- Extend the existing reader with a first-line flag, following the separation of initial stream state in [eventsource-parser](https://github.com/rexxars/eventsource-parser/blob/c3729207bf7bc71297cc4485629633b3bce2fb05/src/parse.ts). After the raw line bytes have passed the existing size accounting, remove one exact UTF-8 BOM prefix from the first line only. Do not strip later line prefixes, a second BOM or characters inside field values. Existing buffered assembly handles a BOM split across reads. This is a directly owned byte stream; other SDK decode pipelines are not assumed to have identical BOM handling.
- Keep all three BOM wire bytes inside the 1 MiB bound. Preserve CR immediate dispatch/reservation, incomplete-event discard, provider completion markers, cancellation, observed/unknown usage, privacy and no-replay boundaries. No adapter, schema or transport change is needed.
- Verify first content and first usage for Chat and Responses, strict first-only behavior, raw-size boundaries and native-adapter completion/truncation. Add the same framing through the independent CLI/Gateway/TLS/mock-Ollama path with durable project attribution and unpriced reconciliation. Run appropriate Go/vet/race, TypeScript contracts and connector integration checks before committing.

## Round 33 validation

- The formal sixteen-case Gateway/upstream HTTP suite fails all eight BOM cases against the Round 32 reader and passes all eight no-BOM controls. With the repair, all sixteen pass (independent run 0.620 seconds). First-content and first-usage cases preserve their exact downstream envelope and observed 5/2/7 usage, frozen ownership attribution, one capture/attempt/terminal/outbox, zero eligible fallback calls, healthy channel state and content/credential privacy.
- Six provider groups cover one initial marker split into one-byte reads, metadata/comments/blank lines, later markers across events, repeated markers, payload characters, partial BOM/EOF/read errors and strict raw-size limits. All three native adapters preserve initial observed usage and completion/truncation behavior. The full provider suite passes (2.081 seconds), and an independent fresh focused run passes (0.473 seconds). The production change adds only seven lines; the bounded line scanner remains unchanged.
- A new independent Gateway/CLI/TLS/mock-Ollama integration group makes sixteen calls: twelve Chat cases cover both response modes, both first-event types and all three line endings; four Responses cases cover both modes and first-event types with LF. Exact content, completion and observed counts survive the local transport. PostgreSQL records one attempt, project/key/connection attribution and one outbox per request. Worker anchors all sixteen usage events, creates sixteen missing-price reconciliation cases and writes no usage records or request usage ledger entries. Synthetic content and credentials remain absent from retained facts and process logs. The complete suite passes 17/17 (23.23 seconds); its pre-repair run failed the new group's first-content check while all sixteen existing groups passed.
- The new mock initially omitted cached/reasoning dimensions while expecting fully known metering. Its corrected fixture explicitly reports zero for those two dimensions, as the existing normal/refusal mock does; assertions now include the observed detail fields. Production does not infer missing zeros. The existing incomplete-usage paths remain covered separately.
- One integration run also failed existing inference cases with `model_not_found` before SSE parsing. The preceding resource-projection test temporarily disables both channels, then checked only the restored Control Plane view. Its background Gateway snapshot can still reflect that temporary state. The fixture now waits for HTTP 200 and the exact restored Gateway model list before subsequent inference; it does not dispatch/retry inference. Publishing the empty generation during that particular run is an inference from the refresh/cache code, since the diagnostic log does not include model contents.
- `go test ./...` and `go vet ./...` pass (Gateway 48.122 seconds); Linux `go test -race ./...` passes (Gateway 174.745 seconds, provider 8.107 seconds). All seventy related TypeScript contracts pass (2.11 seconds). Final non-incremental TypeScript, targeted ESLint/Prettier, Go formatting, secret scan and diff checks pass. Independent production, Gateway test and integration-fixture reviews found no blocker. Existing twenty-six migrations are exercised; no schema, dependency, adapter version, authorization, pricing or deployment change was made.

Round 33 was committed as `9148286` and merged/pushed to main (`0bb6fe3`).

## Round 34 design

An actual HTTPS probe confirms `caFile` establishes remote trust but not local model discovery against the same explicitly configured certificate. The constructor appends the PEM to its remote TLS roots, while its local transport uses only system roots. The configuration accepts private HTTPS upstreams and the user guide describes `caFile` as the private-CA option, so this prevents a documented configuration from working.

- Apply a clone of the existing immutable TLS configuration to the local transport. The configured bundle extends system trust for both remote services and the explicitly configured local HTTPS endpoint. Following [cloudflared's origin CA pattern](https://developers.cloudflare.com/tunnel/reference/origin-parameters/#capool), retain certificate chain, validity and configured-host verification. No verification bypass or server-name override is added.
- Keep TLS 1.2 minimum, fixed private-IP upstreams, approved models, fixed model/chat paths, no redirects and no environment proxy. Preserve HTTP/2 negotiation with `ForceAttemptHTTP2`; supplying a custom TLS configuration otherwise disables the previous automatic attempt in Go Transport.
- Formalize private-CA success and rejected untrusted/wrong-host/expired certificates with actual TLS listeners. Change the dedicated integration mock's local model endpoint to HTTPS under its existing private fixture CA, exercising discovery and all seventeen Gateway/CLI groups. Run connector/CLI Go checks, scoped Linux race, TypeScript and integration checks. No new config field, schema or adapter change is needed.

## Round 34 validation

- The new formal TLS suite uses independently generated ECDSA CA/leaf certificates and actual listeners. Before repair, both valid configurations establish remote trust but fail local model discovery/chat; no-CA and unrelated-CA controls remain rejected. Wrong-IP and expired-leaf tests also fail their precise expected cause because the old local client stops at unknown authority. After repair all six cases pass (fresh independent run 0.191 seconds): TLS 1.2/HTTP 1 works, actual HTTP/2 is observed for local discovery/chat, and certificate negatives report the appropriate x509 reason with zero HTTP handler calls. No previously accepted invalid certificate is claimed.
- The positive tests exercise remote Pair, local approved-model discovery, a fixed Chat request and its result upload. They verify local bearer credentials stay absent from remote headers/pair bodies, raw and decoded result frames and synthetic server logs. This fixture proves transport behavior with a prefix plus EOF; protocol completion is established separately by the full integration suite. Independent security and test reviews found no blocker.
- `go test ./connectorclient ./cmd/nexus-connector -count=1` passes (10.462 and 4.459 seconds), followed by scoped `go vet`. Linux race passes the same packages (11.882 and 6.002 seconds). All seventeen PostgreSQL/independent Gateway/CLI groups pass with the local mock now using private-CA HTTPS (27.82 seconds), including first-BOM content/usage, both response modes, durable attribution, unpriced reconciliation, timeouts, cancellation and permission controls. Existing HTTP-target unit tests still pass.
- Non-incremental TypeScript, targeted ESLint/Prettier, Go formatting, secret scan and diff checks pass. No migration, dependency, credential format, runtime lease rule, routing policy, adapter version or configuration field changed. The explicit single-Gateway connector restriction remains. The guide now states that `caFile` extends trust for both remote and local HTTPS and that a literal-IP endpoint requires a matching IP SAN.
