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

## Streaming, output and accounting

The SSE parser enforces a 1 MiB event budget while reading, including line bytes, comments and framing. The relay uses one reader per request and bounded handoff to the response writer. Chat streaming forwards deltas without retaining the full output. Buffered chat accumulates text, reasoning and function calls only up to `GATEWAY_MAX_RESPONSE_BYTES`. Responses also bounds the output retained for its final response object, including streamed requests.

Transport EOF alone does not prove completion. Missing protocol completion, malformed/oversized events, idle timeout and disconnect retain the available usage evidence without reporting a completed request. Unknown counters remain unknown rather than becoming fabricated zeros. An ambiguous upstream outcome is recorded as `unknown`; it is not automatically charged, and its budget hold remains subject to reconciliation. Terminal persistence uses a bounded context independent of client cancellation. See [reconciliation](./reconciliation.md).

Once upstream execution may have occurred, the gateway does not switch providers to replay the request. Same-priority eligible channels use weighted selection informed by health, in-flight work and time to first token; this does not override eligibility or circuit-breaker checks.

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
