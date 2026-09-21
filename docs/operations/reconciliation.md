# Reconciliation Runbook

## When to reconcile

- Scheduled: the worker runs reconciliation jobs every
  `WORKER_RECONCILE_INTERVAL_MS` (default 60s).
- On-demand: after an incident, before a billing cycle close, or when a
  variance alert fires.

## What is compared

Per provider account, date, currency, and model:
1. **Nexus usage** (`usage_records`).
2. **Provider usage/bill** (fetched from the provider's API or invoice).
3. **Ledger cost** (`ledger_entries` where `type = 'usage_charge'`).

A case is opened when the difference exceeds:
- Absolute threshold: > $1.00 (100,000 micros), OR
- Proportional threshold: > 0.5% of the provider-reported total.

## Resolution

1. Investigate the case (`reconciliation_cases.status = 'investigating'`).
2. Determine the root cause (missing event, wrong price, provider delay).
3. If money moved incorrectly, post a **compensating** ledger entry. Never edit
   the original entry (immutable, trigger-enforced).
4. Close the case with evidence and a reference to the compensating entry:
   ```sql
   UPDATE reconciliation_cases
     SET status = 'resolved',
         resolution = 'compensating entry posted: ledger_transactions.id = ...',
         resolved_by = $1,
         resolved_at = now()
   WHERE id = $2
   ```

## What NOT to do

- Do NOT edit historical `usage_records` or `ledger_entries`.
- Do NOT close a case without evidence.
- Do NOT auto-resolve unknown-completion events (INVARIANT #12).

## On-demand check

```bash
DATABASE_URL=... node scripts/ops/reconcile-check.mjs
```

The script reports the count of open cases, the oldest open case age, and the
total absolute variance across all open cases.
