# nexus-gateway

The standalone Go data plane. It serves the OpenAI-compatible API,
routes to upstream providers, and writes usage facts to the outbox.

Local Ollama connectors use an outbound HTTPS reverse transport. See the
[two-machine setup](../../docs/operations/local-connector.md). This optional transport
adds a metadata-only live Control Plane authorization check to every call for immediate
revocation, and a dedicated PostgreSQL session lock enforcing a single Gateway.
It reuses the Router, OpenAI adapter, attribution and v2 outbox; local upstream secrets
remain on the connector computer. Control Plane availability is required for connector calls.

The production workload holds **no master key**, reads **no control-plane configuration table**, and
in normal operation needs no control-plane round trip on the request path:

| It does | It does not |
|---|---|
| verify downstream keys against the signed snapshot | read `downstream_api_keys` |
| read prices/catalog from the signed snapshot | read `src/lib/catalog.ts` or any price table |
| unwrap upstream secrets through independent Vault grants | obtain plaintext credentials from the control plane |
| write `request_records` + `attempts` + `outbox_events` | write ledger, wallet or config tables |

## Run

```bash
# from the repository root
cd services/gateway
go build ./...
GATEWAY_ENV=development \
CONTROL_PLANE_URL=http://127.0.0.1:3000 \
GATEWAY_INTERNAL_TOKEN=dev-internal-token-0123456789 \
BUDGET_SERVICE_URL=http://127.0.0.1:8081 \
BUDGET_SERVICE_TOKEN=dev-budget-token-distinct-0123456789 \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db \
REDIS_URL=redis://127.0.0.1:6379 \
SNAPSHOT_SIGNING_KEY=dev-signing-key-at-least-32-chars-long \
go run .
```

The control plane must also have `GATEWAY_INTERNAL_TOKEN` set to the same value
and `SNAPSHOT_SIGNING_KEY` set to the same signing value. This key signs routing
snapshots; it does not grant access to provider secrets. For desktop credentials
saved through the UI, configure the same `NEXUS_LOCAL_CREDENTIAL_DIR` on the
development gateway, or use `npm run gateway:local` from the repository root.
Production uses [independent Vault enrollment](../../docs/operations/independent-secret-enrollment.md)
and rejects the local credential profile.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `GATEWAY_ENV` | `development` | `production` turns on the fail-closed checks |
| `GATEWAY_ADDR` | `:8080` | |
| `CONTROL_PLANE_URL` | `http://127.0.0.1:3000` | required in production |
| `GATEWAY_INTERNAL_TOKEN` | — | required in production (≥24 chars); unset closes the internal API |
| `SNAPSHOT_SIGNING_KEY` | dev fallback | required in production (≥32 chars); independent of provider encryption |
| `SNAPSHOT_SIGNING_KEY_PREVIOUS` / `_VERSION` | — | previous snapshot key for verification after rotation |
| `DATABASE_URL` | — | required in production; used only for the outbox tables |
| `REDIS_URL` | — | required for production shared admission; local fallback only in development/test |
| `KMS_PROVIDER` | `local` | production requires `vault` and independent registry/workload configuration |
| `GATEWAY_SNAPSHOT_TTL_SECONDS` (control plane) | `120` | how long a signed bundle stays valid |
| `GATEWAY_SNAPSHOT_MAX_AGE_SECONDS` | `300` | gateway-side ceiling on bundle freshness |
| `GATEWAY_TOTAL_TIMEOUT_SECONDS` | `300` | whole-request budget |
| `GATEWAY_STREAM_IDLE_TIMEOUT_SECONDS` | `60` | per-chunk idle timeout (also the slow-client write deadline) |
| `GATEWAY_MAX_BODY_BYTES` | `1048576` | |
| `GATEWAY_MAX_CONCURRENT` | `256` | process-wide, per-tenant may only tighten |
| `GATEWAY_CHANNEL_MAX_CONCURRENT` | `64` | shared per-channel cap across tenants and gateway instances; range 1–100000 |
| `GATEWAY_CONCURRENCY_WAIT_MS` | `0` | bounded admission wait; 0 rejects immediately, maximum 30000 ms |
| `GATEWAY_MAX_RESPONSE_BYTES` | `16777216` | accumulated output content cap (16 MiB); range 4096–67108864 bytes |
| `GATEWAY_REQUESTS_PER_MINUTE` / `GATEWAY_TOKENS_PER_MINUTE` | `600` / `2000000` | system caps |
| `GATEWAY_ENABLE_RESPONSES` | `false` | enables the documented text/function-call subset; disabled endpoint answers 501 |
| `GATEWAY_ENABLE_EMBEDDINGS` | `false` | embeddings currently answer 501 |

## Endpoints

| Path | Purpose |
|---|---|
| `POST /v1/chat/completions` | streaming and buffered chat |
| `GET /v1/models` | from the signed snapshot, never an upstream call |
| `GET /healthz` | liveness |
| `GET /readyz` | readiness: a verified snapshot must be present |
| `GET /versionz` | adapter versions + circuit-breaker states |
| `POST /v1/responses` | opt-in JSON/SSE text and function-call subset; see [supported fields and exclusions](../../docs/operations/gateway-limits.md#responses-compatibility) |
| `POST /v1/embeddings` | **501** |

## Degradation policy

| Failure | Managed traffic | BYOK traffic |
|---|---|---|
| control plane unreachable, snapshot unexpired | continue on last-known-good | continue |
| snapshot expired | **503 `snapshot_expired`** | continue only if the tenant policy `byok_continue_when_stale` is set in that same signed bundle |
| no snapshot at all | **503** (cannot route) | **503** (cannot route) |
| Redis down | production rejects admission; development/test may use local limits | same |
| PostgreSQL / outbox uncommittable | **503 `storage_unavailable`** (checked before dispatch, so no credit is spent) | continue; the outbox write is retried in-process |
| independent budget service unreachable | **503** | no hold is taken, so continue |

`status=unknown` is never charged: the hold is left in place for reconciliation
using the recorded usage evidence. A truncated stream, missing protocol
completion or malformed upstream response does not become a successful request.
Missing counters remain unknown.

## Streaming and transport bounds

The SSE parser limits events to 1 MiB while reading. Chat streaming uses one
reader per request and bounded handoff without accumulating the full output.
Buffered text, reasoning and function calls share `GATEWAY_MAX_RESPONSE_BYTES`;
Responses applies this bound to output retained for its final object as well.
Cancellation closes upstream reads, and terminal usage persistence is detached
from client cancellation with a bounded timeout.

Local/Vault clients reuse HTTP/1.1 only within equivalent immutable authorization
bindings and deadlines. Every request and socket write rechecks authorization;
DNS/destination restrictions and redirect refusal remain enforced. HTTP/2 is
disabled. Each resolver caches at most 64 transports with 2 idle connections per
entry; idle/expired entries and shutdown release connections. See
[gateway limits and failure handling](../../docs/operations/gateway-limits.md)
for lease recovery, configuration ranges and pool lifecycle details.

## No unsafe switching

A different channel is tried **only** when the failure happened before any
response, and only for a retryable classification. Once an upstream has returned
a 2xx, the gateway is committed: a second provider would duplicate work that
cannot be undone. Each attempt is persisted as its own `attempts` row and the
usage event references the final one.

## Tests

```bash
cd services/gateway
go vet ./...
go test ./...
go test -race ./...      # requires cgo + a C compiler (see below)
```

Coverage: scrypt/RFC 7914 + cross-language signing vectors, canonical JSON
byte-equality with the TypeScript signer, snapshot verify/expiry/atomic-swap,
key auth (revoked/disabled/expired/scope/unset-token), SSE fragmentation down to
one byte per read for OpenAI, Anthropic and Gemini, slow client, disconnect
cancel, idle timeout, circuit breaker, Redis degradation, control-plane outage
with and without a stale snapshot, duplicate idempotency key, unknown terminal
state, attempt records on failover, outbox-unhealthy fail-closed, and goroutine
release after cancelled requests. Hardening regressions cover bounded SSE and
output parsing, tool-call deltas, authorization-isolated connection reuse and
revocation/expiry, weighted routing, and Redis lease recovery.

### `-race` on Windows

`go test -race` needs cgo and a C toolchain. If the Windows host lacks a supported
C compiler, run it in a Linux container instead:

```bash
docker run --rm -v "$PWD/../..:/w" -w /w/services/gateway golang:1.24 go test -race ./...
```

## Performance report methodology

The target is **p95 proxy overhead < 75 ms excluding upstream**. Measure it with
a mock upstream that responds instantly, so the residual is Nexus's own cost:

1. `go test -run TestPerfOverhead -count=1` drives N concurrent streaming
   requests against an `httptest` upstream with zero think time and reports
   p50/p95/p99 of (gateway total − upstream handler time).
2. Vary the payload (1 KB / 8 KB / 64 KB messages), concurrency (1 / 16 / 64)
   and stream duration (short / 200-chunk long stream), and run with and without
   TLS termination in front.
3. Report the hardware (CPU, cores, RAM), Go version, `GOMAXPROCS`, and whether
   the process ran in a container.

The committed perf test asserts only a generous ceiling so it is not flaky in
CI; the published numbers must come from a dedicated run on named hardware.

## Layout

```
main.go        wiring, startup, graceful shutdown
config.go      fail-closed configuration
server.go      http.Server timeouts + drain-then-close shutdown
routes.go      chi routes, /readyz, disabled endpoints
proxy.go       the hot path (auth → limits → route → stream → persist → asynchronous Worker settlement)
snapshot.go    signed bundle schema, verification, atomic swap, fail-closed cache
keyring.go     snapshot signing keyring (mirrors src/lib/crypto.ts)
scrypt.go      scrypt (RFC 7914) on the standard library
canonical.go   canonical JSON byte-compatible with the TS signer
auth.go        downstream key verification against the signed key directory
limit.go       token buckets and process/local concurrency limits
admission.go   shared Redis tenant/channel leases, renewal and cancellation
router.go      eligibility filters and weighted selection within priority bands
breaker.go     circuit breaker, failure rate and time-to-first-token health
outbox.go      request + attempt + outbox event in one transaction
reserve.go     private independent budget authorization client
credential.go  resolver interface and explicit development/test clients
credential_vault.go  independently authorized Vault credential resolution
credential_local.go  explicit development desktop credential profile
credential_pool.go   bounded HTTP/1.1 reuse for equivalent authorization grants
contracts.go   NexusUsageEventV1 + Validate
errors.go      public API error contract
telemetry.go   OpenTelemetry provider with a redacting exporter
provider/      ProviderAdapterV1 execution half: openai/deepseek/qwen, anthropic, gemini
```

## Independent accounting authorization

Configure explicit BUDGET_SERVICE_URL and a distinct BUDGET_SERVICE_TOKEN. Managed
requests authorize budget at POST /v1/reservations on that private service;
Control Plane reserve/settle return410. Gateway sends the already verified
provider/sale/FX pins and never computes money or calls final settlement.
Worker consumes durable outbox events and is the only final usage writer.
The budget process remains available when the asynchronous consumer is stopped.
Missing/expired/malformed grants and budget/database failure deny managed work.
See [the Budget README](../budget/README.md) and
[production enrollment](../../docs/operations/independent-secret-enrollment.md)
for deployment requirements.
