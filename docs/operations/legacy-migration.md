# Canonical schema and explicit legacy import

Schema deployment uses `DATABASE_URL=... npm run db:migrate`. The runner requires an explicitly injected database URL, takes an advisory transaction lock, validates the complete applied journal prefix, and commits all pending DDL and history together. A failure rolls back the batch. It never loads a local environment file implicitly.

Published SQL, timestamps and checksums remain unchanged. Migration 0005 repeats four outbox definitions from 0003: the runner recognizes only its pinned original checksum and skips those four statements only after checking the existing column and index definitions. Any drift refuses deployment. `drizzle/0001_migrate_legacy.sql` is an obsolete, unjournaled historical reference; never run it manually or add it to the journal. The explicit importer below replaces it. Migration 0007 adds provenance and historical usage archive tables.

`DATABASE_URL=... npm run db:migration:verify` checks Drizzle metadata and executes real PostgreSQL migration tests, including schema resets. Supply an isolated disposable test database; this command is not a deployment command.

## Authoring schema migrations

`npm run db:generate` compares `src/db/schema.ts` with the latest generator snapshot; it does not compare the ORM schema with a live database or reconstruct it from published SQL. `drizzle-kit check` validates migration metadata/history and does not establish that the latest snapshot matches the current schema. Keep those checks separate from canonical SQL deployment.

For a normal ORM schema change, review the generated SQL, journal entry and snapshot together before committing. For manually authored schema DDL, update the ORM declaration and append its current-schema snapshot as part of the same change. Generate and review that snapshot in an isolated copy with a minimal `dialect`/`schema`/`out` config and no database credentials; verify that its differences correspond to the new canonical SQL before adopting it. Do not apply or publish duplicate SQL for changes already present in the journal. Preserve published SQL, journal timestamps/checksums and older snapshots. SQL-only functions, triggers or data migrations do not need fictitious ORM schema changes. In the installed Kit 0.31.10, `generate --custom` retains the previous schema shape, so an empty custom migration alone does not synchronize a stale baseline.

The appended `0026_snapshot.json` records the current ORM schema after the manual connector migration and provider metadata indexes. Its parent is the prior 0022 snapshot; intervening SQL-only migrations remain unchanged. This metadata adds no database migration and does not certify every live constraint name or SQL-only invariant. Databases through 0026 retain six unnamed connector UNIQUE/foreign-key constraints with PostgreSQL names different from the ORM names; 0027 aligns those names as described below. Before changing or removing any manually authored constraint, inspect its actual `pg_constraint` name and review generated ALTER/DROP statements against it; an unchanged generation check does not verify those future operations.

Run the offline generator regression after a migration change:

```bash
npx vitest run tests/contract/migration-generation.test.ts
```

It runs the installed CLI against temporary copies, requires unchanged generation to emit no SQL or metadata changes, and verifies an intentional isolated schema addition. It reads no `.env` or database credentials. Run `npm run db:migration:verify` separately with an explicitly injected disposable PostgreSQL database to verify the canonical SQL and legacy import.

## Migration 0027: connector constraint names

`0027_connector_constraint_names` renames the three UNIQUE constraints and three foreign keys introduced by 0025 to the existing ORM names. This makes later generated constraint changes target the actual objects. PostgreSQL also renames the three UNIQUE backing indexes; the existing objects, stored rows, uniqueness and foreign-key actions are retained. The snapshot inherits 0026's current ORM shape through Kit's custom-migration path, with a new snapshot identity and journal entry. Earlier SQL and metadata remain immutable. This is a naming alignment for these six constraints, rather than a certificate of every manually authored database object.

Schedule a schema maintenance window for the connector tables: `ALTER TABLE ... RENAME CONSTRAINT` takes an `ACCESS EXCLUSIVE` lock and can wait for existing readers or writers. Inject the deployment `DATABASE_URL` and run the normal `npm run db:migrate`, then verify readiness before resuming connector traffic. Apply this migration before deploying a future generated change to these constraints. Current Control Plane and Gateway queries use column-based conflict handling and retain compatibility with the renamed objects; the coordinated 0026 writer upgrade remains a separate prerequisite.

Fresh deployment, populated-prefix preservation, constraint enforcement and actual future generated DDL are covered by:

```bash
npx vitest run tests/integration/connector-constraint-migrations.test.ts tests/integration/connector-constraint-generation.test.ts --no-file-parallelism
```

These tests reset schemas and require an explicitly injected loopback disposable `DATABASE_URL`: the existing CI `convergence_ci15` or the dedicated local `migration_constraint_round44`, both on port 55439. Never use an application database. Generated changes that deliberately remove uniqueness or change a delete action are executed only inside transactions that roll back in this fixture. They are test controls, rather than published migrations.

## Migration 0026: provider diagnostic metadata

`0026_provider_request_metadata` replaces the two tenant/provider-identifier unique indexes with ordinary lookup indexes. It preserves existing rows and opaque identifiers. The original secondary provider-ID deduplication assumed a shared namespace across providers, accounts and custom endpoints; diagnostic metadata does not establish that operation identity. Request/attempt primary keys, scoped client idempotency claims, tenant/event-ID uniqueness, full event replay checks and request-derived ledger keys remain the accounting protections. Two distinct operations can retain the same upstream correlation value.

Deploy this migration in a maintenance window:

1. Prepare the compatible Gateway build, drain active calls, and stop every Gateway writer and Worker consumer.
2. Inject the intended deployment `DATABASE_URL` and run `npm run db:migrate` with the normal migration runner. Index replacement is transactional; ordinary index construction takes write locks.
3. Restart the compatible Gateway and Worker builds, verify readiness, and resume calls. The Gateway build must use plain attempt INSERTs rather than `ON CONFLICT (tenant_id, upstream_request_id)`.

Older Gateway binaries cannot write attempts after this migration because their conflict target requires the removed unique index, including for pending attempts with a null identifier. The compatible writer build is the rollback floor. Restoring old global uniqueness can fail once valid repeated identifiers have been stored; do not use it as an automatic rollback. Published earlier migrations and their checksums remain unchanged.

## Prepare ownership and recovery evidence

Stop every legacy writer, drain reservations, and keep writes frozen through final verification. Take a protected database backup, record its SHA-256 and storage reference, and verify it restores into a separate database. Neither the manifest nor the importer proves an operator actually froze external applications or stored a backup: those references must point to reviewed operational evidence. Import transactions additionally take SHARE locks on all four source tables and serialize importers with an advisory lock.

Provision destination organizations and provider codes explicitly. Every source ID in every table must have an exact tenant and organization mapping. Missing mappings, surplus mappings, wrong currencies or unsupported schemas fail preflight. Do not infer ownership from current names or assign unknown history to a default project.

The manifest has the following shape; replace all examples with audited values. Each `rows` object must include all actual source IDs, even for settings and logs. An empty object is valid only when its source table is empty.

```json
{
  "version": 1,
  "namespace": "legacy-cutover-2026-09",
  "sourceSchema": "public",
  "currency": "USD",
  "timezone": "Asia/Shanghai",
  "backup": {
    "reference": "protected-backup-receipt",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "freeze": { "reference": "approved-writer-freeze-receipt", "confirmed": true },
  "rows": {
    "relay_channels": {},
    "relay_keys": {},
    "relay_logs": {},
    "relay_settings": {}
  }
}
```

Each populated mapping is `"source-id": {"tenantId": "tenant-id", "organizationId": "organization-id"}`. Keep the reviewed manifest unchanged throughout a run and replay. Source and manifest digests prevent silently reusing a namespace with different data.

## Execute and verify

Inject `DATABASE_URL` into the operator process, then run:

```bash
npm run db:legacy -- preflight --manifest /protected/manifest.json
npm run db:legacy -- dry-run --manifest /protected/manifest.json
npm run db:legacy -- migrate --manifest /protected/manifest.json
npm run db:legacy -- verify --manifest /protected/manifest.json
```

Preflight validates without persisting targets. Dry-run executes the import and verification inside a transaction and rolls back. Migrate commits only after verification. Verify requires an existing import and rolls back its verification transaction. Save the returned before/after counts and digests alongside the backup/freeze receipts. Replaying the same namespace verifies stable mappings and opening balances without creating duplicate postings or historical usage.

Legacy floating-point amounts are read as PostgreSQL decimal text, converted with integer arithmetic to six-decimal micros, rounded half away from zero, and marked estimated where retained as historical usage. Negative balances, unsupported values, bigint overflow and unresolved reservations refuse import. Opening balances use the explicitly mapped organization currency. Historical logs remain a separate archive; absent cached/reasoning tokens, project, key and price provenance remain null. Distinct source request IDs remain distinct even when timestamps and token counts match. Imported keys and channels remain disabled pending a separate activation decision.

Credential-bearing source rows fail closed in the CLI until an independently authorized Secret Plane enrollment adapter is installed. The programmatic adapter must verify an already enrolled encrypted credential and bind tenant, provider and source ciphertext digest; a manifest assertion is insufficient. Do not copy plaintext into Control Plane tables or treat test adapters as production credential migration. Only the supported retention setting is imported; other settings need explicit remediation.

The independent operator `node scripts/migrate-legacy-secrets.mjs migrate` supports explicitly declared `versioned-scrypt-v1` and `local-envelope-v1` source records. Supply protected key files, an encrypt-only Vault identity and the independent registry signer; never run this workload inside Control Plane. Its output contains `signedRegistry`, `proofs` and redacted `receipts`. Preserve the old encrypted source and wrapped DEK until recovery verification succeeds. Versionless ciphertext is refused; no KDF is guessed.

For `relay_channels.secret` (the versioned-scrypt source column), provision the destination opaque `external-registry:v1` credential reference, extract the operator output's `proofs` array and `signedRegistry` object into protected files, and append `--proofs /protected/proofs.json --trust /protected/trust.json --registry /protected/registry.json` to **every** import command above. The trust file maps the independently provisioned operator key ID to its raw Ed25519 public key in base64. Never obtain trust roots from the same untrusted source as a proof. The importer verifies the proof signature, exact restored source identity/ciphertext/version, target tenant/provider/credential/version and recomputed entry/payload digests. JSON `verified` claims cannot authorize import. The proof authorizes the exact archived payload for historical import; Gateway separately validates the registry signature, freshness and rollback floors before live use. A stale migration registry must be freshly published for Gateway, never granted extended validity.

`npm run secrets:verify:fixture` includes encrypted-source backup copy, original-file removal, byte-digest-checked restore, then independent reenrollment of **both** legacy formats through real Vault Transit. The Go test resolves credential versions 1 and 2 with the Gateway identity and compares the restored canary. This is an encrypted-source recovery drill, not Vault server storage/HA recovery or a production signer-custody claim. Private fixture inputs stay under ignored `.test-artifacts/vault-reference`; only redacted receipts belong in evidence.

Names and enabled flags may change through a separately approved activation after import; replay verifies immutable bindings rather than undoing those operational edits. The minimal archive omits source model/name/latency/demo fields; retain original source rows and their digest for lookup. It is not a canonical analytics or rebilling source.

## Recovery and contract phase

An interrupted import rolls back all target rows, mappings and opening postings. Restart with the same manifest after resolving the cause. Do not delete or edit financial postings to undo a committed import. Restore the protected backup into a separate database and verify it before an approved cutover, or use separately reviewed compensating ledger entries. Keep the original legacy tables, backup and mapping records. Dropping legacy tables is a separate contract task after successful verification and retention review.

`scripts/verify-migration-recovery.mjs` is restricted to the local convergence PostgreSQL fixture. It performs an actual dump and restore into a new database and compares every public table's row count and row digest; it is not a production restore command. Its receipt records the fixture scope explicitly.
