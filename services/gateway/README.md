# nexus-gateway

The standalone Go data plane (ADR-0001). It serves the OpenAI-compatible API,
routes to upstream providers, and writes usage facts to the outbox.

It holds **no master key**, reads **no control-plane configuration table**, and
in normal operation needs no control-plane round trip on the request path:

| It does | It does not |
|---|---|
| verify downstream keys against the signed snapshot | read `downstream_api_keys` |
| read prices/catalog from the signed snapshot | read `src/lib/catalog.ts` or any price table |
| unwrap upstream secrets via the control plane's Secret Plane | hold `UPSTREAM_ENCRYPTION_KEY` for decryption |
| write `request_records` + `attempts` + `outbox_events` | write ledger, wallet or config tables |

## Run

```bash
# from the repository root
export PATH="$PATH:/c/Program Files/Go/bin"   # Windows; Go 1.27 at C:\Program Files\Go

cd services/gateway
go build ./...
GATEWAY_ENV=development \
CONTROL_PLANE_URL=http://127.0.0.1:3000 \
GATEWAY_INTERNAL_TOKEN=dev-internal-token-0123456789 \
BUDGET_SERVICE_URL=http://127.0.0.1:8081 \
BUDGET_SERVICE_TOKEN=dev-budget-token-distinct-0123456789 \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db \
REDIS_URL=redis://127.0.0.1:6379 \
UPSTREAM_ENCRYPTION_KEY=dev-passphrase-at-least-32-chars-long \
go run .
```

The control plane must also have `GATEWAY_INTERNAL_TOKEN` set to the same value
and `UPSTREAM_ENCRYPTION_KEY` set to the same passphrase, because the snapshot
signature is an HMAC under the scrypt-derived keyring (`src/lib/crypto.ts`
`buildKeyring`). `services/gateway/scrypt.go` reimplements that KDF against the
standard library; `testdata/signing-vectors.json` was produced by Node's
`scryptSync` and pins the two implementations together.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `GATEWAY_ENV` | `development` | `production` turns on the fail-closed checks |
| `GATEWAY_ADDR` | `:8080` | |
| `CONTROL_PLANE_URL` | `http://127.0.0.1:3000` | required in production |
| `GATEWAY_INTERNAL_TOKEN` | — | required in production (≥24 chars); unset closes the internal API |
| `UPSTREAM_ENCRYPTION_KEY` | dev fallback | required in production (≥32 chars) |
| `UPSTREAM_ENCRYPTION_KEY_PREVIOUS` / `_VERSION` | — | N-1 key for verification after a rotation |
| `DATABASE_URL` | — | required in production; used only for the outbox tables |
| `REDIS_URL` | — | rate limiting; unset ⇒ conservative local buckets |
| `KMS_PROVIDER` / `ALLOW_LOCAL_KMS_IN_PRODUCTION` | `local` / `false` | `local` is refused in production |
| `GATEWAY_SNAPSHOT_TTL_SECONDS` (control plane) | `120` | how long a signed bundle stays valid |
| `GATEWAY_SNAPSHOT_MAX_AGE_SECONDS` | `300` | gateway-side ceiling on bundle freshness |
| `GATEWAY_TOTAL_TIMEOUT_SECONDS` | `300` | whole-request budget |
| `GATEWAY_STREAM_IDLE_TIMEOUT_SECONDS` | `60` | per-chunk idle timeout (also the slow-client write deadline) |
| `GATEWAY_MAX_BODY_BYTES` | `1048576` | |
| `GATEWAY_MAX_CONCURRENT` | `256` | process-wide, per-tenant may only tighten |
| `GATEWAY_REQUESTS_PER_MINUTE` / `GATEWAY_TOKENS_PER_MINUTE` | `600` / `2000000` | system caps |
| `GATEWAY_ENABLE_RESPONSES` / `GATEWAY_ENABLE_EMBEDDINGS` | `false` | disabled endpoints answer 501 |

## Endpoints

| Path | Purpose |
|---|---|
| `POST /v1/chat/completions` | streaming and buffered chat |
| `GET /v1/models` | from the signed snapshot, never an upstream call |
| `GET /healthz` | liveness |
| `GET /readyz` | readiness: a verified snapshot must be present |
| `GET /versionz` | adapter versions + circuit-breaker states |
| `POST /v1/responses`, `POST /v1/embeddings` | **501** until implemented and contract-tested |

## Degradation policy

| Failure | Managed traffic | BYOK traffic |
|---|---|---|
| control plane unreachable, snapshot unexpired | continue on last-known-good | continue |
| snapshot expired | **503 `snapshot_expired`** | continue only if the tenant policy `byok_continue_when_stale` is set in that same signed bundle |
| no snapshot at all | **503** (cannot route) | **503** (cannot route) |
| Redis down | continue under conservative local limits | same |
| PostgreSQL / outbox uncommittable | **503 `storage_unavailable`** (checked before dispatch, so no credit is spent) | continue; the outbox write is retried in-process |
| independent budget service unreachable | **503** | no hold is taken, so continue |

`status=unknown` is never charged: the hold is left in place for reconciliation
(INVARIANT #12).

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
go test ./...            # ~60 tests
go test -race ./...      # requires cgo + a C compiler (see below)
```

Coverage: scrypt/RFC 7914 + cross-language signing vectors, canonical JSON
byte-equality with the TypeScript signer, snapshot verify/expiry/atomic-swap,
key auth (revoked/disabled/expired/scope/unset-token), SSE fragmentation down to
one byte per read for OpenAI, Anthropic and Gemini, slow client, disconnect
cancel, idle timeout, circuit breaker, Redis degradation, control-plane outage
with and without a stale snapshot, duplicate idempotency key, unknown terminal
state, attempt records on failover, outbox-unhealthy fail-closed, and goroutine
release after cancelled requests.

### `-race` on Windows

`go test -race` needs cgo and a C toolchain. This machine has no `gcc`, so the
command fails with `cgo: C compiler "gcc" not found`. Run it in a container
instead:

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
limit.go       token buckets (Redis + local fallback), concurrency guard
router.go      hard filter then soft score; deterministic ordering
breaker.go     circuit breaker per (channel, model) + latency EWMA
outbox.go      request + attempt + outbox event in one transaction
reserve.go     private independent budget authorization client
credential.go  Secret Plane client (short-TTL in-memory cache)
contracts.go   NexusUsageEventV1 + Validate
errors.go      public API error contract
telemetry.go   OpenTelemetry provider with a redacting exporter
provider/      ProviderAdapterV1 execution half: openai/deepseek/qwen, anthropic, gemini
```

## Independent accounting authorization (ADR-0008)

Configure explicit BUDGET_SERVICE_URL and a distinct BUDGET_SERVICE_TOKEN. Managed
requests authorize budget at POST /v1/reservations on that private service;
Control Plane reserve/settle return410. Gateway sends the already verified
provider/sale/FX pins and never computes money or calls final settlement.
Worker consumes durable outbox events and is the only final usage writer.
The budget process remains available when the asynchronous consumer is stopped.
Missing/expired/malformed grants and budget/database failure deny managed work.
See services/budget/README.md and ADR-0008 for deployment and rollback ordering.
