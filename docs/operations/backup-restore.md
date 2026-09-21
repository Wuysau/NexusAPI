# Backup and Restore Runbook

## Backup posture

PostgreSQL is configured with:
- Encrypted full backups (daily).
- PITR (point-in-time recovery) via WAL archiving.
- Backup retention: 30 days.

Redis is ephemeral (rate-limit state, snapshot cache). No backup needed; a
restart rehydrates from Postgres.

## PITR recovery drill (quarterly)

Run in an ISOLATED environment (not production). The drill verifies that a
restored backup is usable: the ledger balances, the outbox is continuous,
price version references resolve, and KMS recovery works.

### Procedure

1. Restore the latest backup to a fresh instance:
   ```bash
   # In the isolated env
   pg_restore --clean --if-exists -d $DRILL_DATABASE_URL latest.dump
   ```
2. Replay WAL to a target time (simulating a mid-incident restore):
   ```bash
   recovery_target_time = '2026-09-11 12:00:00 UTC'
   ```
3. Run the verification script:
   ```bash
   DATABASE_URL=$DRILL_DATABASE_URL node scripts/ops/pitr-verify.mjs
   ```
4. The script checks:
   - **Ledger balance**: every account sums to zero (double-entry invariant).
   - **Outbox continuity**: no gaps in event sequence; all `published` events
     have a corresponding `usage_events` or `payments` row.
   - **Price references**: every `request_records.provider_price_version_id`
     resolves to an `approved` `price_versions` row.
   - **KMS recovery**: at least one credential can be decrypted (the KMS key
     version is available in the restored environment).

### What constitutes success

All four checks pass. A database backup without the KMS key is NOT a
successful recovery (OPERATIONS.md: "only database backup without key
recovery does not count as success").

### What NOT to do

- Do NOT run the drill against production.
- Do NOT skip the KMS recovery check.
- Do NOT consider the drill passed if the ledger does not balance.

## KMS recovery

The KMS master key is stored in the secrets manager, separate from the
database backup. The drill verifies that the key can be retrieved and used to
decrypt at least one credential. If the key is lost, all encrypted credentials
are unrecoverable — this is a SEV-0.
