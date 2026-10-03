# Current authority for connection project changes

## Characterization

Native PostgreSQL/session/CSRF/route OLD:2 failures / 7 controls passed. The test waits for the actual route to consume a delayed ReadableStream body, commits organization administrator demotion or membership removal, then completes projectId:null. OLD still returns200, removes another user's private-project binding and records one success audit. The non-null destination already rejects the same state change; unchanged admin, fresh-request and CSRF controls pass. Historical observation/session facts remain unchanged.

The independently guarded round68 fixture uses all28 canonical migrations and a credential-free subscription observation with valid plane-specific capabilities. Earlier setup failures (invalid connection mode/capabilities and wrong pairing ordering column) are preserved separately and excluded from OLD evidence. Pending request bodies and clients are closed even on assertion failure. No production resources or accounts are used.

## Minimal design

Keep connection-first transaction locking. Lock the tenant connection, resolve current organization role with shared membership/organization locks, verify existing project management visibility plus ownership/admin policy using that current role, then authorize a non-null destination through the existing locked quota helper. Reuse the workspace actor query rather than duplicate its validation. Preserve management access for recovering archived source projects; a destination must remain quota eligible. Hold authority locks until the binding transaction commits. No schema, Gateway or credential changes.

This slice closes stale organization authority on connection binding/unbinding. It does not claim all in-flight requests are cancelled on every user/session change, or revise unrelated Task Supervisor authority. Keep historical usage immutable and success auditing unchanged.

## Verification

The original9 native cases pass unchanged after the fix. Three additional compatibility cases pass for live developer ownership, archived source recovery and archived destination rejection:12 passed / 0 failed / 0 skipped, 1.85 seconds, zero remaining clients. Independent review finds no blocker. Existing unit mocks now provide a live role for the real helper query, retaining all original assertions; the two initial mock failures are fixture failures, not accepted GREEN evidence.

Compiler and scoped lint/format pass. Periodic full checkpoint:unit754/64files, contract391/29files, security49/5files, Integration610/56files (255 seconds), all zero failed/skipped. This includes existing real workspace/project/quota and Key-scope regressions, so no redundant individual rerun is needed. Independent review confirms live-role and source/destination compatibility. The manual documents current membership/ownership enforcement, archived recovery and immutable historical attribution. Submit independently, update the concise maintenance state and continue re-auditing the next boundary.
