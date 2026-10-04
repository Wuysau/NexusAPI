# C21 — Preserve the process after idle database connection loss

Starting topic HEAD: `923e161`. User resumed continuous maintenance on 2026-10-04. The old Observer platform path and Connector CI database failures are already fixed. Exact C20 main `cf10bb7` hosted CI `37180625494` passed through Integration/security/build/services/Compose and is still running later gates; no complete result claimed here.

## Characterization and design

The shared `src/db` pool had no error listener. Actual `pg_terminate_backend` on an owned idle child connection exits that process with code 1, although its prior write committed exactly once. A synthetic diagnostic control also shows the unhandled Error can expose private Error/client fields. Ordinary SQL failure still rejects normally. The earlier ignored prototype failed before this characterization because its generated JavaScript contained an unescaped newline; that failed evidence is retained separately.

Register a fixed structured diagnostic only on construction of a new pool, using the existing allowlisted Logger with service `database`. The installed pg-pool removes a failed idle client before emitting the event. Do not consume raw Error/client values, restart a transaction, retry SQL, or attach additional listeners when reusing the development global pool. Shared CP/Worker imports gain this handling; Gateway and Budget independent pools are unchanged. Existing instances require restart. Reference: [node-postgres pooling](https://node-postgres.com/features/pooling); implementation based on the locally installed pg-pool event ordering.

## Verification

- Frozen native OLD: 2 failures, 1 passing SQL-error control, zero skips. Same frozen fixture GREEN: 3 passes, zero failures/skips. Actual lost idle backend, next explicit query on replacement backend, exactly one prior committed write, one static error record, no private diagnostics.
- Root Vitest configuration formal regression: 5 passes, zero failures/skips. Adds actual in-flight query termination (57P01, no implicit retry/write, subsequent query works) and three module reloads retaining one listener on the same cached pool.
- Both runs validate exact loopback PostgreSQL port55439, named disposable database, `current_database()`, advisory ownership, no preexisting clients, canonical28 migrations, scoped child application name/PID before termination, stable source hashes and zero remaining other clients. No production database, paid provider or user credential operation.
- Ignored receipts: `.test-artifacts/control-idle-recovery-round84/`. Compiler, related acquisition5 regression, scoped style/lint/secrets/diff checks and CP/Worker/Budget builds pass. Independent review is clear after restricting fixture cleanup to its successfully created table. Build retains existing middleware/dynamic-tracing warnings.

This is an idle-connection recovery guarantee. Checked-out client errors and active operations retain their existing failure semantics; total query/request cancellation, automatic replay and database outage availability are not promised.
