# Atomic project Key issuance

## Characterization

The route currently creates and commits an enabled, unbound Key, writes its mandatory audit outside that transaction, then binds the requested project through another pool query. Native OLD in an independently guarded round65 PostgreSQL database: 3 failures / 1 compatibility control passed. Blocking the actual audit INSERT proves the Key is already visible in the signed Gateway directory before issuance finishes. Injected project-binding and audit failures leave an orphan Key; binding failure also leaves a success audit. No provider execution or billing exploit is claimed.

## Minimal design

Pass optional projectId from the already-authorized API route into createDownstreamKey. Persist that binding and expiry using the existing transaction's PoolClient, then write the existing mandatory redacted audit with that client before COMMIT. Remove the post-commit binding update. A failure rolls back Key and success audit together; return plaintext only after success. Preserve existing explicit no-project issuance, audit metadata, historical facts and snapshot protocol. This reuses the existing thin repository rather than expanding its contract; uncommitted writes never publish a temporary unbound Key. No migration, new Gateway lookup or credential-plane change.

The invariant concerns publication of a fully scoped, audited Key. Initial project visibility authorization remains separate; this slice does not claim transaction-wide protection against every concurrent role/lifecycle change. Subsequent concurrency work requires its own native evidence and bounded design.

## Verification

Unchanged native GREEN:4 passed / 0 failed / 0 skipped. Held real advisory audit gate while inspecting actual signed directory, injected binding/audit storage failures and compared all persisted Key/audit facts, then confirmed unbound compatibility. Related real regression:82 passed / 5 files / 0 failed / 0 skipped (project Key scope7, project snapshot12, disabled-credential snapshot11, auth/RBAC32, threat-model20). Independent round62/64 database checks show zero remaining clients; relevant source/test hashes match before/after every stage. Compiler, scoped lint/format and independent review pass. Evidence stays in ignored continuous-maintenance and c03-related-verification receipts with no plaintext credentials in logs. Submit independently and immediately re-audit.
