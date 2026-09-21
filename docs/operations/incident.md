# Incident Response Runbook

## Severity

| Severity | Definition | Response |
|---|---|---|
| SEV-0 | Key/tenant data leak, wrong billing spread, unexplained money | Stop affected capability, preserve evidence, rotate credentials, notify lead. |
| SEV-1 | Large-area gateway outage, possible usage loss, double payment | Freeze write path, start reconciliation. |
| SEV-2 | Single provider/region degraded, catalog delay, report delay | Isolate channel or use approved fallback. |

## Procedure

1. **Acknowledge**: on-call acknowledges the page within the SLO response time.
2. **Assess**: determine severity. When in doubt, over-rate.
3. **Mitigate**: stop the bleeding (rollback, freeze, isolate).
4. **Preserve evidence**: capture logs, metrics, DB snapshots. Do NOT delete
   logs to "fix" the incident.
5. **Communicate**: notify stakeholders. Internal channel first; external
   notice only when confirmed customer impact.
6. **Resolve**: restore service.
7. **Postmortem**: within 48 hours, write a blameless postmortem:
   - Timeline (with timestamps).
   - Impact (tenants, requests, money affected).
   - Root cause.
   - Mitigation applied.
   - Recovery evidence.
   - Follow-up tasks (linked to `tasks/`).

## What NOT to do

- Do NOT paste secrets into tickets or chat.
- Do NOT delete logs.
- Do NOT edit ledger entries to "correct" billing.
- Do NOT roll back the database to hide an incident.

## Evidence preservation

```bash
# Capture the current outbox state
psql $DATABASE_URL -c "SELECT status, count(*) FROM outbox_events GROUP BY status"

# Capture the ledger state
psql $DATABASE_URL -c "SELECT tenant_id, account_type, currency, sum(amount) FROM ledger_entries GROUP BY tenant_id, account_type, currency"

# Capture the reconciliation cases
psql $DATABASE_URL -c "SELECT status, count(*) FROM reconciliation_cases GROUP BY status"
```
