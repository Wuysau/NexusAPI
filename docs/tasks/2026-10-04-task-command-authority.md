# Current project authority for HTTP task commands

## Candidate and scope

Before this fix, HTTP resume/switch authenticate and resolve active project scope before reading the body. After body validation, requestTaskAction uses the pool to update the command from that cached scope; it checks Task scope/status/CAS, but not current requester membership/project eligibility. Native OLD in a guarded independent round69 PostgreSQL database:8 failures / 10 controls passed / 0 skipped. The actual delayed-body routes still return202 and mutate Task/command sequence with one success audit after organization demotion/removal, project archiving or developer project membership removal.

Only these two HTTP commands are this slice. There is no HTTP Task creation/continuation endpoint: scripts/nexus.ts owns local configuration and explicit persistence consent. Preserve the query-only store signatures, Observer execution authority and supervisor state machine. Never launch a runtime while testing command authorization.

## Minimal design

After strict body validation, reuse one Control Plane transaction wrapper: BEGIN, resolveQuotaProject with the existing current organization/member/active project/project-member shared locks, requestTaskAction using the same client, then COMMIT. The existing atomic UPDATE remains the command-state/CAS gate; no extra Task or resource lock is needed. Both routes share the wrapper, release the client on every path and keep current HTTP errors/success audit. No Gateway read, migration, credential or inference replay change.

This guarantees current project authority through command submission. Concurrent routing-policy/resource changes and mandatory audit semantics require separate characterization; do not claim them solved by this wrapper.

## Verification

Unchanged native GREEN:18 passed / 0 failed / 0 skipped, 2.755 seconds. Actual delayed-body authority changes now return404, leave full Task/command sequence/domain facts unchanged and add no success audit; ordinary202, duplicate409, fresh viewer and CSRF controls pass. Test hash matches OLD, six relevant input hashes remain stable during GREEN, no runtime launches occur and all fixture clients close. Evidence remains ignored in `.test-artifacts/task-command-authority-round69`.

Compiler, scoped lint/format and independent review pass. Existing real Task route/store/supervisor regressions pass:11 routes,2 store,28 supervisor including lease termination/recovery. Combined:59 passed / 0 failed / 0 skipped across four files, with stable scoped source hashes and no other fixture clients before/after each stage. Manual explains submission-time eligibility and distinguishes queued acceptance from execution result. The separate main-CI acknowledgment fixture correction is committed after full Go acceptance; submit this command slice independently, then the verified policy-commit concurrency slice.
