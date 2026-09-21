# Nexus billing worker (TypeScript)

Consumes the PostgreSQL outbox written by the Go data plane (ADR-0005), computes
charges from each request's **pinned** price versions, settles reservations
against the double-entry ledger, and drives reconciliation.

This process owns no money logic of its own: the arithmetic and postings live in
`src/lib/billing/` so Worker settlement and reconciliation share the same implementation.
Control Plane reserve/settle endpoints are retired; an independent private budget
process owns reservation authorization (ADR-0008, services/budget/README.md).
Final usage is computed only from durable request pins and frozen sale rates;
missing/corrupt pins enter reconciliation.

## What it does

```
outbox_events (pending)
   │  SELECT ... FOR UPDATE SKIP LOCKED   ← one transaction per poll
   ▼
processOutboxEvent (per event, inside a SAVEPOINT)
   ├─ completed → release the hold, post the authoritative usage charge
   ├─ failed    → release the hold, charge nothing
   └─ unknown   → open a reconciliation case; keep the hold; never auto-retry
   ▼
usage_records + request_records projection + audit_events
```

Every poll also claims a poll-level advisory lock, so a second instance skips
rather than sweeping the same batch. A `kill -9` is safe: the batch transaction
rolls back and the events are claimable again. Re-processing is harmless because
the ledger idempotency keys are derived from the request id
(`usage:<requestId>`, `reservation_release:<requestId>`) and `usage_events` is
unique on `(tenant_id, event_id)`.

On a slower cadence it runs the reconciliation jobs:

- `unknown` requests → case `unknown_completion` (hold retained),
- expired non-terminal reservations → release + case `reservation_timeout`,
- recent settled charges that no longer reproduce from their pinned versions →
  case `amount_mismatch`.

## Prerequisites

1. **PostgreSQL reachable** and migrated. The worker needs the additive outbox
   retry columns from `drizzle/0003_worker_outbox_retry.sql`:

   ```bash
   psql "$DATABASE_URL" -f drizzle/0003_worker_outbox_retry.sql
   ```

   The worker refuses to start (fail-closed) if `outbox_events.next_attempt_at`,
   `claimed_by` or `claimed_at` are missing.

   > Note: `drizzle/0003_worker_outbox_retry.sql` is hand-written and not in the
   > Drizzle journal (same convention as `drizzle/0001_migrate_legacy.sql`).
   > Apply it explicitly; fold it into the generated snapshot when the schema
   > owner next regenerates migrations.

2. A wallet + ledger account for every tenant that uses managed (platform)
   channels. BYOK tenants need none.

## Run

```bash
DATABASE_URL=postgresql://... npx tsx services/worker/index.ts
```

`.env` is loaded automatically (`dotenv`), so a local `.env` with `DATABASE_URL`
also works. The worker writes one JSON line per batch to stdout.

Graceful shutdown: `SIGINT`/`SIGTERM` finish the in-flight batch and exit.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `WORKER_ID` | `worker-<pid>` | Recorded in `outbox_events.claimed_by` and audit |
| `WORKER_POLL_INTERVAL_MS` | `5000` | Outbox poll cadence |
| `WORKER_BATCH_SIZE` | `25` | Events claimed per transaction |
| `WORKER_MAX_ATTEMPTS` | `5` | Attempts before dead-letter |
| `WORKER_BACKOFF_BASE_MS` | `5000` | First retry delay (doubles per attempt) |
| `WORKER_BACKOFF_MAX_MS` | `300000` | Backoff ceiling |
| `WORKER_RECONCILE_INTERVAL_MS` | `60000` | Reconciliation cadence |

## Operational signals

- `outbox_events.status`: `pending` → `published`; `failed` is a dead letter.
- `outbox_events.next_attempt_at`: when a retried event becomes eligible.
- `outbox_events.last_error`: redacted, bounded error text.
- Audit actions: `billing.settled`, `billing.settled_replayed`,
  `billing.failed_released`, `billing.unknown_reconciled`,
  `billing.reconciliation_opened`, `billing.reconciliation_resolved`,
  `billing.outbox_dead_letter`.

Dead letters require operator attention: the event is never retried again, and
the usage fact it carries has **not** been billed. Inspect `last_error`, fix the
cause, then reset the row to `pending` with `next_attempt_at = NULL`.

## Historical settlement compatibility

Control Plane settle returns410 and never writes funds. Worker preserves existing
usage/reservation_release idempotency keys so N-1 posted ledger transactions
remain authoritative. Missing durable authorization or frozen price pins require
reconciliation; no live rule is substituted. Mutated event replays are rejected.
An N-1 ledger-only reservation cannot become a new budget grant.

## Tests

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db \
  npx vitest run tests/integration/billing-reconciliation.test.ts
```
