# Retain active actor eligibility through Key commit

## Characterization

Disposable round79 actual session/CSRF/PATCH waits on a fixture-held Key row. User suspension commits while organization role and project membership remain valid. Fresh Project/Key requests correctly return401; the waiting PATCH still returns200 and changes Key, successful audit and cache epoch. Original OLD twice:1RED/1control,2140/2228ms. A separate frozen ordering-aware fixture reproduced twice:1RED/1control,2208/2231ms,55 import/migration inputs unchanged, canonical28/clients0. It accepts a lawful earlier operation only when actual `pg_blocking_pids` proves the user writer is blocked by that operation. Original receipts are preserved; no inference or production system is involved.

## Correction

The existing creation and lifecycle authorization callbacks first acquire `FOR SHARE` on the current user with active/not-deleted predicates using the same transaction client. An unavailable user returns the existing401 unauthenticated error. The lock stays through COMMIT; existing Key/project/organization/member ordering then proceeds unchanged. No Gateway, schema, credential, historical-accounting or automatic existing-Key revocation change. Session revocation/expiry and recent authentication remain existing read-point checks and require separate characterization.

## Verification

Frozen ordered native2 GREEN:2084ms,55 inputs unchanged, canonical28/clients0; SHA256 `940af3ec4fb7af60e96f7466e8cd6cc6f959370d6eb2b37e13c3ea9c3a283e80`. Formal14 cases include the original two, nine actual user-guard waits (suspended/invited/deleted × disable/revoke/create) and three deferred actual COMMIT waits. Withdrawal-first always returns401 with every business fact and cache unchanged. Legal earlier operation holds its actor lock until COMMIT; suspension then finishes and fresh operations401. Existing Keys, history, exact redacted audit, revocation outbox and issuance hash/scope remain checked. The fixture verifies exact loopback URL/current_database/advisory ownership/no other clients before reset and applies canonical28.

Formal SHA256 `cd1971e6298a6925fa7d646eb6eb26524fa042f804e093fccf8179d7a05fa259`. Related formal14/creation21/mutation24/lifecycle17/body-authority8/atomic4/project7/auth32:127PASS/0fail/0skip,423 inputs unchanged within/across all stages. Tests run serially against disposable CI15; accepted aggregate is `.test-artifacts/key-actor-authority-formal-round79/related-summary.json`. Compiler, scoped lint/format/secrets and related contract3 checks pass. Primary maintainer reviewed actual source and lock order; no independent code-review acceptance is claimed for this slice. Full checkpoint725 Integration and exact C14 hosted acceptance remain prior evidence until the next checkpoint/new revision acceptance.

## Next action

Characterize session revocation after current context resolution and before Key mutation/issuance. Keep separate user, session, scope and execution authorities; never replay previously dispatched inference. Continue autonomous maintenance after commit.
