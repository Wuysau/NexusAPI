# Rollback Runbook

## Principle

Rolling back the application must NEVER roll back committed financial ledger
entries. A rollback restores the previous code version; money that moved
stays moved. Recovery uses compensating entries (refunds, adjustments), not
history deletion.

## Procedure

1. Identify the last known-good image: `nexusapi:$PREV_VERSION`.
2. Roll back the application deployment:
   ```bash
   # Redeploy the previous image
   docker compose -f infra/docker-compose.prod.yml up -d app
   ```
   Do NOT roll back the database. The schema is expand/migrate/contract; the
   previous code is compatible with the current schema.
3. If a migration was applied that is NOT backward-compatible (it should not
   be — this is a process violation), do NOT roll back the DB. Instead, write
   a forward migration that restores compatibility.
4. Verify:
   - Health check passes: `curl http://localhost:3000/api/health`
   - Error rate returns to baseline.
   - Outbox depth drains.
   - No new billing variance alerts.
5. Open an incident (see [incident.md](./incident.md)) if the rollback was
   triggered by a production failure.

## Worker rollback

The worker is stateless (claims are row locks released on crash). Roll back
the image; in-flight events become claimable again (INVARIANT #9).

## Gateway rollback

The Go gateway is stateless (snapshot cache, no master key). Roll back the
image; the previous snapshot cache refreshes on startup.

## What NOT to do

- Do NOT `pg_restore` to roll back the application. PITR is for data recovery,
  not deployment rollback.
- Do NOT delete outbox rows to "clear" a backlog. Events are at-least-once;
  deleting them loses billing facts.
- Do NOT edit ledger entries. They are immutable (DB trigger enforced).
