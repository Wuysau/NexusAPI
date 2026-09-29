# Gateway limits and failure handling

Set these variables on the Go gateway process. The signed tenant policy may impose stricter limits.

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_MAX_CONCURRENT` | `256` | Process concurrency ceiling; also the upper bound for tenant concurrency policy. |
| `GATEWAY_CHANNEL_MAX_CONCURRENT` | `64` | Shared concurrent requests per channel across tenants and gateway instances; range 1–100000. |
| `GATEWAY_CONCURRENCY_WAIT_MS` | `0` | Wait for admission capacity; 0 rejects immediately, maximum 30000 ms. Cancellation also stops waiting. |
| `GATEWAY_MAX_RESPONSE_BYTES` | `16777216` (16 MiB) | Maximum buffered response size, including serialized JSON; range 4096–67108864 bytes (64 MiB). Also bounds the content retained for Responses completion events. |
| `GATEWAY_STREAM_IDLE_TIMEOUT_SECONDS` | `60` | Upstream chunk idle timeout and downstream write/flush budget, including buffered Chat and Responses output. |
| `GATEWAY_TOTAL_TIMEOUT_SECONDS` | `300` | Upstream execution time budget; authentication, terminal persistence and downstream delivery have separate limits. |
| `GATEWAY_UPSTREAM_TIMEOUT_SECONDS` | `120` | Maximum duration of one dispatched attempt, including response headers and the complete stream. The total deadline and client/lease cancellation may end it earlier. |
| `GATEWAY_ENABLE_RESPONSES` | `false` | Enable the supported Responses subset described below. |

## Shared admission

Production requires `REDIS_URL`. Tenant and channel concurrency use expiring Redis leases shared by gateway instances. Channel capacity is shared even when different tenants use the same channel. Leases renew while work runs, release on completion/cancellation, and expire after a crashed process stops renewing. Renewal failure cancels the upstream request. Waiting for capacity remains bounded by both the configured wait and request cancellation.

Missing or unavailable Redis rejects production admission; adding replicas does not enable a local fallback. Only explicit development/test profiles allow local limits. During a Redis incident, restore Redis connectivity before expecting new production requests to succeed. Expired leases reclaim abandoned capacity; do not delete live lease keys to bypass caps.

RPM and estimated TPM checks each have a one-second Redis operation budget, shortened by request cancellation. A failed or invalid shared rate response returns HTTP 503 before budget reservation or inference, even if concurrency admission succeeded. Production does not consume a local fallback bucket. Development/test fallback uses one tenth of the configured rate capacity, with a minimum capacity of one; cancellation never falls back. Redis server time controls shared token refill, so Gateway clock differences cannot create extra capacity.

Temporary RPM/TPM exhaustion returns HTTP 429 with `Retry-After` rounded up to whole seconds. The hint reflects that bucket's current refill and is not a reservation; competing requests may consume the replenished capacity. A request whose estimated cost exceeds the full bucket cannot become eligible merely by waiting and receives no hint. Backend failures and budget/concurrency errors do not invent a rate recovery time. Chat and the Responses adapter share this behavior, and neither automatically replays inference.

The configured process concurrency cap is applied before the first admission. Startup does not consume a slot; caps below and above the default 256 are supported.

## Execution timeouts

Each dispatched attempt has its own upstream deadline. The timer remains active while receiving the response body, even when tokens continue arriving. Idle limits separately bound gaps between chunks. Long-running models need appropriate upstream and total limits; a larger idle limit alone does not extend either deadline. Previously, the upstream timeout setting was read but not enforced by execution.

A deadline before the response starts returns HTTP 504 with `upstream_timeout`. After streaming begins, Chat emits a terminal error; Responses emits `response.failed` with its compatible `server_error` code and the static message `Upstream timed out.` Internal records retain the timeout cause and any reliable usage already observed. Unknown counts remain unknown. An assigned upstream connection prevents automatic replay, including a timeout before headers. A failure before connection assignment may use an already eligible fallback under the existing retry rules; that attempt gets a new timer within the original total deadline. The same context reaches local connectors.

## Signed snapshot freshness

A valid signature and HTTP 200 are insufficient to refresh authorization. A fetched bundle must have a signed expiry strictly after receipt, remain valid through verification, and complete within the fetch context. Effective expiry is the earlier of signed expiry and receipt plus the configured maximum age. A bundle that is already expired, expires during retrieval/verification, or arrives after cancellation cannot replace the cached generation.

The complete HTTP response must fit within 8 MiB and contain one JSON document. The size check applies to the body after HTTP decompression, including whitespace; exactly 8 MiB is allowed. Extra JSON values, malformed trailing data and oversized responses are rejected without publishing their valid prefix. Normal surrounding JSON whitespace and existing unknown envelope fields remain compatible. Size/framing errors omit response content and retain the same last-good-state rules as other rejected refreshes.

Failed candidates retain the last accepted snapshot and its original expiry; repeated successful HTTP responses containing an expired bundle do not extend its lifetime. With no previously valid state, requests fail with 503. API key authentication always requires a fresh platform directory. Previously accepted tenant snapshots retain the existing explicit legacy BYOK stale-policy behavior; managed and v2 execution fail closed on expiry. This does not allow a newly received expired bundle to enable that policy.

Concurrent callers for one scope share the active refresh's success or failure. A Control Plane outage therefore causes one fetch per concurrent group, rather than one serialized fetch per waiting request. Each waiter can cancel independently; canceling the initiating caller ends that shared fetch. Completed failures are not cached, so a later request can retry immediately. Background refresh joins an active fetch or starts a new one even while cached state is fresh, retaining the existing key-revocation propagation interval. Different tenant scopes remain independent, and a successful shared result is checked for expiry when delivered.

After verification, each generation builds a private API key hash index. Requests still check current directory freshness, key state, expiry and scopes; the index stores directory positions, not authentication results. A newly accepted generation replaces the whole index, so revocation and project changes retain their existing snapshot refresh boundary. The signed envelope and 8 MiB response limit are unchanged. From `services/gateway`, run `go test . -run '^$' -bench 'BenchmarkSnapshot(Authentication|KeyIndexBuild)' -benchmem -cpu=1` to measure authentication and refresh-index costs with 1,000 and 10,000 representative keys. These measurements exclude HTTP, model execution and snapshot verification.

If the Control Plane responds but requests report snapshot errors, check that its signed `expires_at` is current, Gateway and Control Plane clocks are synchronized, and intermediary caches are not replaying old responses. Readiness remains false when the platform directory is expired. Do not change host time or extend cached expiry to bypass authorization checks.

## Health probes and provider cooldown

`/healthz` reports process liveness. `/readyz` returns 200 only with a fresh verified platform key directory and a responsive database; production also requires a successful live Redis ping. A fresh tenant bundle cannot mask an expired platform directory, which every API key authentication needs. Database and Redis checks run concurrently with a shared two-second deadline. Development/test may report `admission_mode: "local"` and `checks.redis: false` while remaining ready. A production Redis outage returns 503. Health responses disable caching and omit dependency error details. Probe traffic never calls a model.

Database failure deliberately makes whole-instance readiness fail. The existing direct-request BYOK degradation policy remains, but a load balancer using `/readyz` removes that instance until persistence is healthy again.

The container runs `/app/nexus-healthcheck`, which probes the configured `GATEWAY_ADDR` port on loopback with a three-second deadline and a 64 KiB response bound. It requires all three dependency checks to be true. With `GATEWAY_TLS_CERT` and `GATEWAY_TLS_KEY` configured, it uses HTTPS and verifies certificates. For a certificate issued to a DNS name, set `GATEWAY_HEALTHCHECK_TLS_SERVER_NAME` to that name; the network target remains local. For a private CA, mount its PEM bundle and set `GATEWAY_HEALTHCHECK_CA_FILE` to the mounted path. System trust roots are used otherwise. Bind the Gateway to a wildcard or loopback address reachable by the probe. There is no insecure verification mode, redirect following or environment proxy use.

`/versionz` reports adapter versions and aggregate counts of closed/open/half-open breakers. Channel IDs and model names are not public diagnostics. Update any monitor that previously consumed the channel-keyed `breaker` object to use the aggregate state counts.

An upstream 429 immediately cools down its channel/model for later requests. `Retry-After` (seconds or HTTP date), `retry-after-ms` and `x-ms-retry-after-ms` are parsed as positive durations and capped at 60 seconds. Invalid hints are ignored; a 429 without a valid hint uses the existing breaker duration (30 seconds in the default runtime). A 503 with a valid hint also enters cooldown. The same channel's other models keep their independent state. Cooldown expires into the existing limited half-open probing path, and a concurrent earlier success cannot clear an active cooldown.

Incomplete or malformed upstream streams, idle expiry and single-attempt expiry count toward that channel/model's existing failure threshold. Client cancellation, the parent total deadline and downstream delivery failures do not count as upstream health failures. Reaching the threshold affects later requests; partial or ambiguous execution still has one terminal record and is never replayed automatically. Stream cleanup cancels only its own attempt, preserving the original cancellation cause for this distinction.

Invalid request and content-policy refusals do not count as upstream health failures. This avoids one caller's bad input removing capacity for other callers. Cooldown affects subsequent routing and does not sleep, retry, or fail over a request whose upstream execution may already have started. These states are per Gateway process; they are not a new distributed rate limiter.

The first local-connector transport forwards status and response body but does not forward retry headers. Its 429 responses use the default cooldown; per-provider hints apply to direct API channels.

## Local connector model discovery

`GET /v1/models` shares a five-second I/O deadline across API key authentication, snapshot loading and connector authorization. Eligible connector candidates still pass the existing Router policy and health filters first. Live checks are grouped by Channel, with at most 64 requested model IDs per batch and four batches running at once. The Control Plane intersects the request with currently ready and Channel-approved models after checking ownership, project, key and lease authorization.

Unverified connector models are omitted; other confirmed candidates can still be returned. Results are not cached between requests, do not refresh transport liveness, and do not authorize later inference. Chat retains its per-call live authorization. Update Control Plane before Gateway when deploying this batch protocol; an older Control Plane rejects it safely.

## Request parameter validation

Chat message history preserves an explicit string `reasoning_content`, including an empty string. Ollama channels receive the same value as `reasoning`; other compatible channels retain `reasoning_content`. Provider selection uses signed channel metadata, never model names or URLs. Missing/null history remains omitted, and invalid field types fail before execution. The gateway does not invent missing reasoning or enable a provider's thinking mode. Native Anthropic/Gemini adapters reject this history with `unsupported_parameter` on `messages` before credential access or reservation because their current translation cannot preserve it. Responses keeps its existing documented input subset.

An explicit Chat `max_completion_tokens` keeps that field name for OpenAI, Qwen and custom compatible providers. Responses `max_output_tokens` uses the same path. Explicit `max_tokens` remains the legacy field; when both non-null fields are supplied, the existing modern-field precedence applies. Null or omitted limits do not invent an upstream cap. The reservation estimate uses the same effective value regardless of the wire name.

Known Ollama and DeepSeek channels retain their documented `max_tokens` mapping, including modern client input. The adapter uses the provider code from the signed channel, with its registered adapter code as the legacy fallback. Model names and endpoint URLs do not select a parameter dialect. Anthropic and Gemini retain their native fields and existing defaults. A compatible endpoint or individual model may still reject a parameter it does not support; the Gateway does not retry inference under a different field name.

Chat `stop` accepts a string, an array of at most four strings, or `null`. Omitted/null/empty-array values add no stop sequences; explicit strings, including an empty string, retain their supplied value. Other types and null/non-string array elements return HTTP 400 with `param: "stop"` before rate admission, reservation or execution. Both Chat and Responses require numeric `top_p` values in the inclusive range 0–1; null and omission leave it unset. Out-of-range values return 400 with `param: "top_p"`, and wrong JSON types retain the existing `invalid_json` response. Provider-specific restrictions may be stricter.

Each execution adapter also validates whether it can represent the canonical request before the Gateway resolves credentials, captures execution or reserves a budget. This validation only narrows the existing authorized, healthy and billable Router candidates. The selected compatible candidates retain the existing payment-mode, price and retry rules. When all eligible candidates reject an input field, the Gateway returns 400 `unsupported_parameter` with its field name and no upstream request or usage event.

The current native Gemini adapter supports text messages and streaming. It rejects function definitions, forced tool selection, tool-call history/results, non-text content parts and structured response formats because those translations are not implemented. The native Anthropic adapter retains its existing tools support and rejects structured response formats. Omitted/null options, empty tool lists and the exact format `{"type":"text"}` add no constraint; Gemini also accepts `auto`/`none` tool choice with no tools. These are adapter implementation limits, not claims about the vendors' native capabilities.

OpenAI-compatible channels, including the local Ollama path, preserve tools, tool choice and response-format fields through the existing serializer. Custom model names are not used to reject those fields. Whether the selected model itself supports them remains subject to its approved configuration and upstream validation. Responses requests share the same checks after their existing conversion into Chat.

## Streaming, output and accounting

The SSE parser enforces a 1 MiB event budget while reading, including line bytes, comments and framing. The relay uses one reader per request and bounded handoff to the response writer. Chat streaming forwards deltas without retaining the full output. Buffered chat accumulates text, reasoning, refusal and function calls only up to `GATEWAY_MAX_RESPONSE_BYTES`. Responses also bounds the output retained for its final response object, including streamed requests.

Normal model refusals retain their dedicated representation: Chat returns `message.refusal` or `delta.refusal`; Responses returns a `refusal` content part and `response.refusal.delta` / `response.refusal.done` events. A normally finished refusal remains a completed inference with its observed usage and no channel-health penalty. Missing usage remains unknown. Refusal text is not copied into logs, accounting facts or error messages. A malformed, oversized or interrupted refusal follows the same failure and no-replay rules as other output.

Clients can retain Chat assistant `refusal` history or the corresponding Responses assistant content part for subsequent turns. Compatible adapters preserve it, including an explicit empty string; absent/null Chat values remain omitted. Native Anthropic/Gemini adapters reject this history before credentials or reservation because the current translations cannot preserve it. Responses input accepts refusal parts only on assistant messages. Refusal-only Chat assistant history may omit `content`; other roles retain the existing content requirement.

Transport EOF alone does not prove completion. Missing protocol completion, malformed/oversized events, idle timeout and disconnect retain the available usage evidence without reporting a completed request. Unknown counters remain unknown rather than becoming fabricated zeros. An ambiguous upstream outcome is recorded as `unknown`; it is not automatically charged, and its budget hold remains subject to reconciliation. Terminal persistence uses a bounded context independent of client cancellation. See [reconciliation](./reconciliation.md).

Buffered Chat and Responses delivery also has a write/flush deadline. A client that stops reading cannot indefinitely hold the handler or Chat's tenant concurrency slot after terminal persistence. A delivery failure after persistence does not replay inference or rewrite its completed usage fact. Successful intermediate SSE flushes clear their write deadline while the handler waits for more upstream data or durable terminal storage; this prevents an unrelated HTTP/2 reset during a storage wait. Final writes retain their deadline for the HTTP server's remaining protocol framing. Long upstream execution remains governed by its own timeout rather than a server-wide response write timer.

Once upstream execution may have occurred, the gateway does not switch providers to replay the request. Same-priority eligible channels use weighted selection informed by health, in-flight work and time to first token; this does not override eligibility or circuit-breaker checks.

## Request identity and shutdown

Every Gateway call receives a new server-generated `x-request-id`. That ID is used by response/error bodies, budget authorization, request/attempt records and usage events, including calls through the Responses adapter. Repeating a caller's `x-request-id` no longer causes a database primary-key collision. A safe caller correlation (at most 128 letters, digits, dots, underscores or hyphens) is echoed separately as `x-client-request-id`; this value is not an accounting or authorization identity. Prefer sending it in `x-client-request-id`; legacy incoming `x-request-id` is accepted as correlation only.

Use `Idempotency-Key` to identify an operation explicitly. Both v2 capture and legacy v1 BYOK with an explicit key persist ownership before dispatch. Same-tenant durable duplicates return 409, including after the admission cache was lost or on another instance. A correlation header has no deduplication semantics. The existing managed path retains its reservation rules.

An explicit legacy BYOK key requires the canonical database schema and an available durable store; missing schema or a failed/ambiguous claim returns 503 before calling the provider. Apply all existing migrations before deploying this behavior. Legacy BYOK requests without an explicit key retain the existing database-degradation policy and have no cross-process deduplication guarantee. No new migration is required.

Claims do not expire automatically. A process crash after claiming may leave a `created` request with no terminal usage. That state blocks reuse of the key because provider execution is uncertain; it does not create token usage, charges, project facts or a synthetic completion. Inspect and reconcile the original operation before deliberately starting a new operation with a different key. Retries after any possible upstream execution remain prohibited.

Shutdown stops admission and allows active requests 30 seconds to complete. When grace expires, request contexts are canceled and sockets closed. A separate cleanup window of up to 12 seconds lets handlers finish detached terminal persistence (which has a 10-second deadline) before dependencies close. Canceled or partial execution stays unknown with its available usage evidence. Shutdown reports a missed grace deadline even when cleanup succeeds. If a handler remains stuck beyond cleanup, an explicit incomplete-cleanup error is returned; process exit remains an emergency boundary, not a claim that all usage was persisted.

The production Compose Gateway has a 60-second `stop_grace_period`. Give other orchestrators at least 30 + 12 seconds plus teardown margin (telemetry flush has a separate two-second bound), or they may kill the process during terminal persistence. Main transfers dependency ownership to Server and skips blocking dependency closes when emergency cleanup remains incomplete. Keep the database and Redis available while the Gateway drains.

## Operational metrics

Set a separate random `GATEWAY_METRICS_TOKEN` of at least 24 characters to enable `GET /metrics`. An empty token returns 404; a missing or incorrect `Authorization: Bearer ...` returns 401. Responses disable caching. Configure the scraper's Bearer credential through its secret store and use verified HTTPS whenever traffic crosses a trusted local network boundary. The production Compose file passes this optional value only to the Gateway.

The Prometheus endpoint exposes these process-local observations:

| Metric | Meaning |
| --- | --- |
| `nexus_requests_total` | Requests reaching the four fixed `/v1` endpoints: Chat, Responses, embeddings and models. |
| `nexus_request_errors_total` | Those requests whose committed HTTP status is at least 400. |
| `nexus_request_duration_seconds` | Histogram of handler lifetime, including response streaming and terminal persistence. |
| `nexus_first_byte_duration_seconds` | Histogram of time until the first response body bytes accepted by the writer. Header-only flushes do not count. |

Metrics have no tenant, model, request, arbitrary path or credential labels. Request and response content is not retained by instrumentation. Scrapes and health probes do not increase these counters. Each Gateway restart resets its observations; let the scraper attach its normal instance label when aggregating replicas.

First body byte is not time to first model token: it may be a JSON error or a stream lifecycle event. A stream that fails after HTTP 200 does not increment the HTTP error counter. Use request/attempt facts for execution outcomes and the existing ledger for financial reporting. Unwired provider, billing and worker counters are not published as misleading zero values.

## Credential-bound connection reuse

Local and Vault credential paths reuse HTTP/1.1 connections only for equivalent immutable authorization grants. The pool key covers tenant/reference/version, encrypted binding, grant deadlines, target and destination policy; it contains no plaintext credential. Fresh credential resolution still occurs. Issuance windows permit equivalent grants to share an expiry without extending the maximum 30-second grant lifetime.

Authorization is checked before every request and socket write, including writes on reused connections. Destination/DNS restrictions and redirect refusal remain in force. HTTP/2 is disabled because its multiplexed write authorization is not supported by this transport boundary.

Each resolver keeps at most 64 cached grant/target transports, with at most 2 idle connections per entry and a 15-second idle timeout. Entries expire at their authorization deadline, old entries are evicted, and shutdown closes the pool. Evicting an active response closes its connection after the body completes. These are transport lifecycle bounds, not a substitute for concurrency admission.

## Responses compatibility

`POST /v1/responses` is opt-in and shares the gateway's authentication, routing, limits, budget authorization and durable usage path. Supported fields are `model`, `input`, `instructions`, `stream`, `max_output_tokens`, `temperature`, `top_p`, `tools` and `tool_choice`.

Input may be a string or an array of text messages, `function_call` items and `function_call_output` items. Message roles are user, assistant, system and developer. Content supports `input_text`; assistant history also accepts `output_text` and `refusal` parts. Tools use Responses function definitions. Tool choice supports auto, none, required or a named function. JSON outputs contain text/refusal messages and function-call items; SSE uses typed Responses lifecycle and delta events, including completed, incomplete and failed terminal events.

`store:false` and `background:false` are accepted. Storage/background execution, `previous_response_id`, `conversation`, hosted tools, multimodal input, references and unknown options are rejected with HTTP 400 before budget reservation or upstream dispatch. Stored-response retrieval/deletion is not implemented. This is a documented subset, not full hosted Responses API compatibility. Disabled Responses and embeddings return HTTP 501.

## Verification

Run `go test ./...` and `go vet ./...` in `services/gateway`; run `go test -race ./...` where cgo and a C compiler are available. Run `go test -tags redisintegration ./...` with `NEXUS_TEST_REDIS_URL` pointing to an isolated Redis fixture (default `redis://127.0.0.1:56381`) to check shared concurrency and rate admission, partial Redis failures, cancellation and instance coordination. Mock-upstream measurements describe only that fixture and do not establish production latency or capacity.

Responses buffers function IDs, names and arguments within the response limit until successful termination, then emits complete function-call events. New text or refusal items after pending tools are also buffered to preserve output order; earlier announced content remains live.
