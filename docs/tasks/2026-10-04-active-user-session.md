# Require an active user when authenticating an existing session

## Problem and boundary

Login already refuses users whose status is not active or whose deleted_at is set. Before this fix, verifySession reads only sessions; an existing token can still resolve to a live organization role after its user is suspended, invited or soft-deleted. The native characterization uses actual PostgreSQL, sessions, CSRF and Control Plane routes in an independently guarded round66 database. OLD: 5 failures / 7 controls passed / 0 skipped. Inactive accounts still read projects and create one with a success audit; suspended/invited users also rotate their session through reauthentication. Fresh login already rejects all three inactive states.

## Minimal design

Join users in verifySession's existing token-hash lookup and require u.status='active' plus u.deleted_at IS NULL. Preserve one query, constant-time hash comparison, expiry/revocation checks, null result for unavailable identity and existing anonymous/401 response behavior. No schema migration, additional Gateway lookup, account credential extraction or session-row deletion. Existing shared Gateway Keys retain their separate credential lifecycle.

The guarantee is active-user eligibility at each authentication read. It does not introduce a transaction covering every later Control Plane write or permanent session revocation on reversible status changes; those require distinct characterization and policy. Normal explicit revoke/expiry remains terminal for the token.

## Verification

Unchanged native GREEN: 12 passed / 0 failed / 0 skipped, 1.87 seconds. User status/deletion, read/write/reauth denial, ACTIVE compatibility, removed membership, expired/revoked/deleted session and CSRF controls all pass. Inactive calls leave protected domain, Key and session facts unchanged, with zero success-audit delta. Full fact comparisons and tokens stay in memory. Both OLD/GREEN close all fixture clients; receipts remain in ignored `.test-artifacts/continuous-maintenance/cp-scope-audit`.

Related existing auth/RBAC, threat-model, owned-access Control Plane contract and secret containment: 57 tests / 4 files passed, 8.71 seconds, zero skipped; fixture clients closed. Compiler and scoped ESLint/Prettier pass. Independent read-only review found no blocker and confirmed legacy user/CI entry compatibility. The public manual now states that an inactive account's existing session cannot authorize protected Control Plane features. Continue the next independent security issue after submission.
