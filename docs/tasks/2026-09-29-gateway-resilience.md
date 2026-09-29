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
