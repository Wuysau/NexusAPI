# Connector configuration preconditions

## Evidence and scope

An isolated PostgreSQL fixture with all twenty-eight canonical migrations reproduces the real administrative operation sequence: delete the connector Channel, then configure the same connection. DELETE disables both the Channel and its credential. Configuration returns HTTP 200 and a new pairing token, enables the Channel and revokes the old connector identity/lease, while leaving the credential disabled. New pairing, renewal and transport authorization succeed, but `readyModels` and the connector snapshot projection remain empty. The configured model list itself remains present.

The guarded probe has one expected failure and one passing temporary-pause control (1.91 seconds). It uses real application routes and database transactions, without Gateway/CLI listeners or inference. The existing Channel enable endpoint already rejects disabled credentials with `409 credential_disabled`. Connector configuration should enforce the same prerequisite before rotating identity or pairing state.

[LiteLLM's effective key policy](https://docs.litellm.ai/docs/proxy/virtual_keys#custom-key-policy-one-hook-for-every-key-operation) checks the merged persisted state across key mutations. Apply that principle to NexusAPI's existing connector mutation rather than introducing a separate authorization mechanism.

## Minimal change

- Keep the existing connection/project/provider checks and creation path.
- When reusing a Channel, verify it belongs to the selected Ollama provider. Lock its referenced credential with `FOR SHARE` and require the current tenant, provider and organization binding.
- Return `409 credential_reference_conflict` for an empty or mismatched reference, and `409 credential_disabled` for a disabled credential. Use fixed messages without foreign resource or credential details.
- Perform these checks before enabling the Channel, revoking connector identity/lease or replacing the pairing token. Transaction rollback preserves existing domain facts on failure.
- Preserve temporary Channel pause recovery and healthy identity rotation. Credentials can be shared by several Channels, so configuration preserves their existing enabled state and reference.

There is no schema, migration, credential format, snapshot protocol, pricing or deployment-mode change. Local upstream credentials remain solely on the connector computer.

## Verification

Add a guarded PostgreSQL integration suite using the independent disposable `connector_test_configure_round47` database on loopback port 55439. The existing CI's explicitly configured `convergence_ci15` database on that same port is also permitted. Capture formal old failures before production changes. Exercise the real DELETE/configure sequence, disabled shared credentials, NULL references, tenant/provider/organization mismatches, healthy rotation and temporary pause recovery. Compare complete connection, Channel, credential, identity, lease and pairing facts; failed configuration must create no successful audit or accounting event.

Verify that the credential row lock waits for a concurrent disable and then rejects the disabled state without rotating anything. Keep all private fixture configuration out of logs. Run non-incremental TypeScript, targeted lint/style, relevant contracts, real connector TLS regression and independent review before committing. The existing published migration history remains immutable.

## Results

- The formal old implementation produced eight expected failures and two passing controls (7.68 seconds). The initial fixture setup's organization uniqueness failure was corrected before this behavioral run and is not counted as production evidence.
- `node .test-artifacts/connector-config-audit/run-formal.mjs formal-green.txt` passed all ten cases (8.81 seconds). The concurrency case observes an actual PostgreSQL blocking PID, commits the disabling writer, then verifies the fixed `409 credential_disabled` response and preserved domain facts. The comparisons include eighteen domain/audit/accounting tables and use fixed assertion messages that do not print credentials.
- The focused twelve-file TypeScript unit/contract selection passed 142 tests (6.12 seconds). `node .test-artifacts/resilience/verify-connector.mjs` passed all nineteen independent-process, private-CA TLS connector scenarios (29.39 seconds), including normal configuration/rotation and real model inference/accounting. Both PostgreSQL runs apply all twenty-eight canonical migrations.
- The first compiler run identified the two new conflict codes missing from `AuthzErrorCode`; the explicit union now declares both codes. Fresh `npx tsc --noEmit --incremental false` passed (11.198 seconds), targeted ESLint passed (2.670 seconds), targeted Prettier passed (1.043 seconds), and diff/secret checks passed. Independent review is recorded below before commit.
- No Go, schema or migration file changed. R46's full native Go tests, vet and Linux race checks remain the unchanged Go baseline; the real TLS regression exercises this round's Control Plane change. The single-Gateway deployment constraint and unknown/unpriced usage rules remain in force.
- Independent review identified that `pg-connection-string` permits query parameters to override URL authority host/port. The destructive test guard now rejects all query parameters before any reset. The actual runner constructs an exact query-free fixture URL; prior behavioral evidence remains valid. The operations document also explicitly distinguishes the route/PostgreSQL configuration suite from the separate Gateway/CLI end-to-end suite.
- Fresh guard probes reject both effective host and port overrides before fixtures (1.346 and 1.392 seconds). The final guarded PostgreSQL suite passes ten cases again (9.10 seconds); targeted lint/style and the final non-incremental compiler pass.
- Final independent read-only review approves the six-file change with no remaining findings, including the corrected fixture guard, row-lock ordering and fixed conflict privacy. Live deployments and unrelated transaction paths were outside that review; the reviewer did not rerun tests or access databases/private configuration.
