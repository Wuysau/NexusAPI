# Private budget authorization

Run `npm run budget:dev` independently of `worker:dev` and control-web. The listener binds loopback by default; container deployment must set `BUDGET_HOST` to a private interface and restrict ingress to Gateway workloads. Required environment: `DATABASE_URL`, a distinct `BUDGET_SERVICE_TOKEN` (24+ characters); optional `BUDGET_HOST` and `BUDGET_PORT` (8081).

Gateway uses `BUDGET_SERVICE_URL` and `BUDGET_SERVICE_TOKEN`. Never expose the listener through public ingress or reuse `GATEWAY_INTERNAL_TOKEN`. The API is `POST /v1/reservations`, authenticated with the budget bearer token. Request schema: `packages/contracts/schemas/budget-request.schema.json`; binding: `packages/contracts/budget.ts`. Amounts return as decimal-string micros.

Each authorization validates tenant/org/key and immutable price associations, locks the tenant before reading ledger balance, and atomically persists a reserved request and balanced reservation. Replay uses the original expiry/amount and refuses conflicting inputs. The only money operation is a hold; Worker owns final usage/release. No model credentials, request content, user sessions or Control Plane calls are involved.

Existing request/ledger tables suffice. Use a distinct database identity with authorization reads and reservation insert permissions. Database grant enforcement and deployment topology must be verified before production; a fixture superuser proves behavior, not least-privilege deployment. Crosscurrency sale snapshots are refused until their historical rate provenance is corrected by TASK-0019.

For readiness, check PostgreSQL connectivity and an authenticated fixture authorization in a disposable tenant; do not use a real wallet as a health probe. Budget/database errors refuse new managed work. Worker may be stopped while the budget listener remains available; durable events accumulate. Unknown outcomes retain holds. Existing expiry reconciliation may release nonterminal holds and opens a case; later authoritative usage may still charge once.

An idle PostgreSQL connection loss emits a fixed structured `database_idle_connection_lost` error with `service: budget`. The driver discards that connection and the service remains available for subsequent explicit requests; raw database errors, SQL and client objects are not logged. This does not retry a reservation or suppress active query failures, and a continuing database outage still fails readiness/new managed work closed. Restart the service after upgrading to load this handler.

Roll out strict Worker first, then this service, then Gateway, then Control Plane tombstones. Drain old gateways before retiring `/api/internal/gateway/reserve` and `/settle`; old callers receive410. Roll back using a compatible independent budget/Worker path; never restore Control Plane final billing or live-price fallback. Preserve ledger keys and use compensating entries for corrections. See ADR-0008.
