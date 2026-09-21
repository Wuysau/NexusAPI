# Release Runbook

## Pre-release

1. Create a change task in `tasks/` with the scope, risk, and rollback plan.
2. Run all quality gates locally:
   ```bash
   npm run format:check && npm run lint && npm run typecheck
   npm run test:unit
   DATABASE_URL=... npm run test:contract
   DATABASE_URL=... npm run test:integration
   DATABASE_URL=... npm run test:security
   DATABASE_URL=... npm run build
   DATABASE_URL=... npm run db:migration:verify
   npm run security:check && npm run secrets:scan
   ```
   Integration and migration verification reset the supplied database schemas: use a disposable test database only. Deployment uses `DATABASE_URL=... npm run db:migrate`, which preserves existing data and validates journal history. See [legacy migration](legacy-migration.md) for the separate import procedure.
3. If a DB migration is included, verify it follows expand/migrate/contract:
   - expand: additive, backward-compatible (new columns nullable, new tables).
   - migrate: deploy the compatible code first, backfill data.
   - contract: remove old columns/shapes only after all consumers updated.

## Deploy

1. Build the image: `docker build -t nexusapi:$VERSION -f infra/Dockerfile .`
2. Push to the registry.
3. Canary: deploy to an internal tenant first. Observe for 10 minutes:
   - Error rate < 1%.
   - p95 latency < 150 ms.
   - Outbox depth stable.
   - No billing variance alerts.
4. If canary is clean, roll out to production.

## Post-release

1. Watch metrics for 30 minutes.
2. Verify the SLO error budget was not consumed beyond the 50% threshold.
3. Close the change task with evidence (build ID, gate outputs, canary metrics).

## Rollback

If any gate fails or an incident is declared, see [rollback.md](./rollback.md).

## Contract compatibility

The gateway and event contracts maintain N / N-1 compatibility. A breaking
change deploys the consumer first; the producer stays on the old contract
until all consumers are updated.
