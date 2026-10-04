# C23a — Initialize canonical pool fixtures independently

Hosted C23 CI37183185305 failed Integration on exact main `ed56e95`: the canonical migration suite intentionally removed `outbox_events_claim_idx`, then Budget recovery setup correctly refused that inherited drift. Its two tests never executed.803 individual tests passed,2 skipped, suite failed; later CI gates were skipped. No production migration-validator defect was found.

## Characterization and minimal correction

On the guarded disposable `workspace_budget_idle_recovery_round87`, unchanged canonical16PASS followed by Budget reproduces the same missing-index setup failure. An independent unchanged catalog21PASS followed by Budget also fails: catalog leaves only schema0000–0002 alongside a full28 migration journal, so `next_attempt_at` is missing. Each ordered OLD keeps478 relevant inputs unchanged. Both receipts, redacted hosted logs and cleanup evidence are retained under ignored `.test-artifacts/hosted-ci-37183185305/`.

Fix the three connection-pool fixtures at their existing setup boundary. After exact loopback URL/name, actual database, advisory ownership and no-other-client checks, reset only their disposable public/drizzle schemas and apply all28 unchanged canonical migrations. This prevents either predecessor from controlling their schema without relaxing production validation or depending on test-file ordering.

Budget setup then commits explicit nonempty history: one completed request, one ledger transaction with two balanced nonzero postings, and one published outbox event. Assert those counts before retaining whole-row count/digest comparisons around each fault/control scenario. C20 teardown drops its marker table only after this run creates it and independently releases the advisory lock even if drop fails.

No production source, migration, deployment configuration or ordinary database is changed by this correction.

Final ordered GREEN: canonical16→Budget2, catalog21→Budget2, catalog21→Control Plane deadline5, catalog21→Control Plane recovery5, all PASS. Each sequence verifies actual inherited drift,481 unchanged relevant inputs, canonical28/applied0 after the consumer, and no remaining clients. Both Budget runs preserve1/1/2/1 historical rows with balanced nonzero postings. A preliminary Budget pass overlapped the full Integration window and shared its build-output location, so it remains provisional; the two accepted Budget runs were explicitly serialized after Integration closed.

Full Integration73files/806tests PASS, zero failures/skips,949 public inputs unchanged throughout449886ms. Concurrent E2E15PASS uses its separate browser database; owned services close. Compiler, scoped lint/format, diff checks and independent review pass. C24's prior Go2410/Linux race/vet/lint/native build checkpoint remains separate; only these fixture tests and documentation changed afterward. Receipts retain both OLD failures and all final accepted results. A new exact-revision hosted CI result must be checked after normal submission.
