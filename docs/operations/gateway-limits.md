# Gateway limits and failure handling

Set these variables on the Go gateway process. The signed tenant policy may impose stricter limits.

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_MAX_CONCURRENT` | `256` | Process concurrency ceiling; also the upper bound for tenant concurrency policy. |
| `GATEWAY_CHANNEL_MAX_CONCURRENT` | `64` | Shared concurrent requests per channel across tenants and gateway instances; range 1–100000. |
| `GATEWAY_CONCURRENCY_WAIT_MS` | `0` | Wait for admission capacity; 0 rejects immediately, maximum 30000 ms. Cancellation also stops waiting. |
| `GATEWAY_MAX_RESPONSE_BYTES` | `16777216` (16 MiB) | Maximum buffered response size, including serialized JSON; range 4096–67108864 bytes (64 MiB). Also bounds the content retained for Responses completion events. |
| `GATEWAY_STREAM_IDLE_TIMEOUT_SECONDS` | `60` | Upstream chunk idle timeout and downstream write deadline. |
| `GATEWAY_TOTAL_TIMEOUT_SECONDS` | `300` | Whole-request time budget. |
| `GATEWAY_ENABLE_RESPONSES` | `false` | Enable the supported Responses subset described below. |

## Shared admission

Production requires `REDIS_URL`. Tenant and channel concurrency use expiring Redis leases shared by gateway instances. Channel capacity is shared even when different tenants use the same channel. Leases renew while work runs, release on completion/cancellation, and expire after a crashed process stops renewing. Renewal failure cancels the upstream request. Waiting for capacity remains bounded by both the configured wait and request cancellation.

Missing or unavailable Redis rejects production admission; adding replicas does not enable a local fallback. Only explicit development/test profiles allow local limits. During a Redis incident, restore Redis connectivity before expecting new production requests to succeed. Expired leases reclaim abandoned capacity; do not delete live lease keys to bypass caps.

The configured process concurrency cap is applied before the first admission. Startup does not consume a slot; caps below and above the default 256 are supported.

## Health probes and provider cooldown

`/healthz` reports process liveness. `/readyz` returns 200 only with a fresh verified platform key directory and a responsive database; production also requires a successful live Redis ping. A fresh tenant bundle cannot mask an expired platform directory, which every API key authentication needs. Database and Redis checks run concurrently with a shared two-second deadline. Development/test may report `admission_mode: "local"` and `checks.redis: false` while remaining ready. A production Redis outage returns 503. Health responses disable caching and omit dependency error details. Probe traffic never calls a model.

Database failure deliberately makes whole-instance readiness fail. The existing direct-request BYOK degradation policy remains, but a load balancer using `/readyz` removes that instance until persistence is healthy again.

The container runs `/app/nexus-healthcheck`, which probes the configured `GATEWAY_ADDR` port on loopback with a three-second deadline and a 64 KiB response bound. It requires all three dependency checks to be true. With `GATEWAY_TLS_CERT` and `GATEWAY_TLS_KEY` configured, it uses HTTPS and verifies certificates. For a certificate issued to a DNS name, set `GATEWAY_HEALTHCHECK_TLS_SERVER_NAME` to that name; the network target remains local. For a private CA, mount its PEM bundle and set `GATEWAY_HEALTHCHECK_CA_FILE` to the mounted path. System trust roots are used otherwise. Bind the Gateway to a wildcard or loopback address reachable by the probe. There is no insecure verification mode, redirect following or environment proxy use.

`/versionz` reports adapter versions and aggregate counts of closed/open/half-open breakers. Channel IDs and model names are not public diagnostics. Update any monitor that previously consumed the channel-keyed `breaker` object to use the aggregate state counts.

An upstream 429 immediately cools down its channel/model for later requests. `Retry-After` (seconds or HTTP date), `retry-after-ms` and `x-ms-retry-after-ms` are parsed as positive durations and capped at 60 seconds. Invalid hints are ignored; a 429 without a valid hint uses the existing breaker duration (30 seconds in the default runtime). A 503 with a valid hint also enters cooldown. The same channel's other models keep their independent state. Cooldown expires into the existing limited half-open probing path, and a concurrent earlier success cannot clear an active cooldown.

Invalid request and content-policy refusals do not count as upstream health failures. This avoids one caller's bad input removing capacity for other callers. Cooldown affects subsequent routing and does not sleep, retry, or fail over a request whose upstream execution may already have started. These states are per Gateway process; they are not a new distributed rate limiter.

The first local-connector transport forwards status and response body but does not forward retry headers. Its 429 responses use the default cooldown; per-provider hints apply to direct API channels.

## Local connector model discovery

`GET /v1/models` shares a five-second I/O deadline across API key authentication, snapshot loading and connector authorization. Eligible connector candidates still pass the existing Router policy and health filters first. Live checks are grouped by Channel, with at most 64 requested model IDs per batch and four batches running at once. The Control Plane intersects the request with currently ready and Channel-approved models after checking ownership, project, key and lease authorization.

Unverified connector models are omitted; other confirmed candidates can still be returned. Results are not cached between requests, do not refresh transport liveness, and do not authorize later inference. Chat retains its per-call live authorization. Update Control Plane before Gateway when deploying this batch protocol; an older Control Plane rejects it safely.

## Streaming, output and accounting

The SSE parser enforces a 1 MiB event budget while reading, including line bytes, comments and framing. The relay uses one reader per request and bounded handoff to the response writer. Chat streaming forwards deltas without retaining the full output. Buffered chat accumulates text, reasoning and function calls only up to `GATEWAY_MAX_RESPONSE_BYTES`. Responses also bounds the output retained for its final response object, including streamed requests.

Transport EOF alone does not prove completion. Missing protocol completion, malformed/oversized events, idle timeout and disconnect retain the available usage evidence without reporting a completed request. Unknown counters remain unknown rather than becoming fabricated zeros. An ambiguous upstream outcome is recorded as `unknown`; it is not automatically charged, and its budget hold remains subject to reconciliation. Terminal persistence uses a bounded context independent of client cancellation. See [reconciliation](./reconciliation.md).

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

Input may be a string or an array of text messages, `function_call` items and `function_call_output` items. Message roles are user, assistant, system and developer; content parts are `input_text` or `output_text`. Tools use Responses function definitions. Tool choice supports auto, none, required or a named function. JSON outputs contain text/function-call items; SSE uses typed Responses lifecycle and delta events, including completed, incomplete and failed terminal events.

`store:false` and `background:false` are accepted. Storage/background execution, `previous_response_id`, `conversation`, hosted tools, multimodal input, references and unknown options are rejected with HTTP 400 before budget reservation or upstream dispatch. Stored-response retrieval/deletion is not implemented. This is a documented subset, not full hosted Responses API compatibility. Disabled Responses and embeddings return HTTP 501.

## Verification

Run `go test ./...` and `go vet ./...` in `services/gateway`; run `go test -race ./...` where cgo and a C compiler are available. Redis lease integration checks require the isolated Redis fixture used by the Go CI gate. Mock-upstream measurements describe only that fixture and do not establish production latency or capacity.

Responses buffers function IDs, names and arguments within the response limit until successful termination, then emits complete function-call events. New text after pending tools is also buffered to preserve output order; earlier text remains live.
