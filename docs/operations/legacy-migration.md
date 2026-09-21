# Canonical schema and explicit legacy import

Schema deployment uses `DATABASE_URL=... npm run db:migrate`. The runner requires an explicitly injected database URL, takes an advisory transaction lock, validates the complete applied journal prefix, and commits all pending DDL and history together. A failure rolls back the batch. It never loads a local environment file implicitly.

Published SQL, timestamps and checksums remain unchanged. Migration 0005 repeats four outbox definitions from 0003: the runner recognizes only its pinned original checksum and skips those four statements only after checking the existing column and index definitions. Any drift refuses deployment. `drizzle/0001_migrate_legacy.sql` is an obsolete, unjournaled historical reference; never run it manually or add it to the journal. The explicit importer below replaces it. Migration 0007 adds provenance and historical usage archive tables.

`DATABASE_URL=... npm run db:migration:verify` checks Drizzle metadata and executes real PostgreSQL migration tests, including schema resets. Supply an isolated disposable test database; this command is not a deployment command.

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
