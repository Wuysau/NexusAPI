# Hold project authority through Task policy commit

## Characterization

Policy PUT reads body before resolving current session/project scope, so body-wait revocation is already denied. Its remaining gap is an unlocked authorization read followed by pool candidate lookup and UPSERT. Native round70 OLD:3 failures / 5 controls passed, 1.96 seconds. A real policy-row gate proves UPSERT is pending while organization demotion, developer project membership removal or project archiving commits first; releasing the gate then saves the policy and records a success audit. No Task/runtime, historical, credential or accounting facts change.

## Minimal design

After existing body validation and projectScope, call savePolicy through the C05 withProjectWrite wrapper with the same client. Current membership/project authority stays locked until the policy commit. Store validation, candidate lookup/UPSERT, body errors, audit fields and CLI policy path remain unchanged. No Gateway or runtime execution changes.

The correct ordering is an already-authorized policy transaction commits before a concurrent authority change can finish. It is not an assertion that every overlapping operation must fail: the native GREEN test must observe the writer waiting on authorization locks, then both operations completing in that order. Candidate connection changes and full audit atomicity remain distinct boundaries.

## Verification

Unchanged native GREEN:8 passed/0 failed/0 skipped,2.05 seconds. All three gate cases observe the authority writer waiting until policy commit, then both legitimate operations finish in order; normal admin/developer saves and body-wait denial controls pass. All fixture clients close. Related actual Task routes11, store2 and policy/resource projection unit39 pass:60 total, zero fail/skip. Related input hashes remain stable; exact round70 database and no other owners verified before/after. Compiler, scoped lint/format and independent final production review pass. Receipts remain ignored in continuous-maintenance/cp-scope-audit and task-policy-related-round70. Submit independently after completed C05 and P0 correction; continue the independently characterized resource-owner boundary next.
