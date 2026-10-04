# Retain current Key authority through lifecycle commit

## Characterization

C12 and C13 explicitly guaranteed refreshed/read-time authority without commit serialization. Exact disposable round77 OLD twice:4 failures/6 controls,2831/2932 ms. `pg_blocking_pids` proves actual Key disable/revoke statements wait on the fixture Key row. Project membership removal or developer→viewer commits before releasing that row; pending routes still return200, mutate Key/success audit/cache epoch, and revoke adds outbox. Fresh ungated requests correctly return404/403. Synthetic hashes only, actual sessions/CSRF/routes, canonical28 migrations,356 stable source inputs and zero remaining clients.

## Minimal correction

Shared management guard locks Key first, then a bound Project, active Organization, current actor organization membership and required ordinary actor Project membership, using separate ordered queries. Current `apikey:revoke` is required; unbound developer must be the creator. Project management preserves archived/inactive visibility. Project-first and organization-before-member order matches existing supported writers; Key binding/creator and authority remain locked through mutation commit.

PATCH uses one client/transaction for guard and exact tenant/organization/Key update, retaining nonrevoked/nondeleted conditions. DELETE retains preliminary visibility and recent-auth checks and passes the guard to an optional trusted internal revoke authorization callback. That callback and existing repository revoke share one client/transaction; callers omitting it keep their original trusted-service behavior. Cache invalidation, revocation outbox and success audit retain their existing post-commit order and semantics. No Gateway, migration, billing, credential or inference change.

## Verification

Frozen native SHA256 `f441707c8055abae33f36b7df5f728adb180aa30b87bd2a0ebbdea7d4026abfa`: final-source10 GREEN,3095 ms,357 source inputs unchanged/clients0. Formal SHA256 `4710c7b974e05656e23373cf33d04ea699ae32a2395e5a6054650d7d1f0c8ee9`:24 pass,4700 ms. Original cases retain desired ordering with CI15 portability; appended controls prove archived/inactive and unbound management, revoked PATCH denial, existing repeated DELETE/idempotent outbox behavior, and current admin promotion while Key waits.

Actual deferred COMMIT gates prove both operations keep mutations/audit/outbox/cache invisible until commit, block both authority writers through commit, then accept lawful earlier mutations before withdrawal. Injected deferred COMMIT rejection returns generic500 and leaves complete business facts and epoch unchanged. Related lifecycle17/issuance-authority8/atomic4/auth32/project7 plus formal24:92 pass/0fail/0skip,365 relevant inputs unchanged across stages, all children/pools closed and fixture clients0. Existing auth32 deliberately uses its legacy0000–0002 schema; following Project suite restores canonical28. Fresh nonincremental compiler, scoped lint/format/secrets, contract13 and independent applied-source review pass. Ignored `key-mutation-authority-round77` retains OLD/native/formal/related safe receipts. Manual updated.

## Boundaries

This orders current Key resource scope/capability with durable lifecycle mutation. Existing session verification/recent-auth is retained; no new session/user-status lock or revalidation after prolonged waits is claimed. A missing current actor membership in the guard returns403; a completely fresh unaffiliated request remains401. Audit/outbox remain post-commit best effort; this slice does not change their delivery atomicity or repeated-revoke semantics. Previously dispatched inference is not canceled or replayed. Issuance authority through its separate creation transaction remains the next independent characterization.
