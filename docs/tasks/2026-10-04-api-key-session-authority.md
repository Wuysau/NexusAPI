# Retain current session authority during Key operations

## Characterization

Frozen disposable round80 OLD twice:4RED/2controls,2849/2497ms,55 import/migration inputs unchanged, canonical28/clients0. Native session/CSRF disable/revoke waits on a real Key row; session revocation or expiry update commits first. Fresh actual requests401 while waiting operations200 and append Key/audit/cache changes and revocation outbox. User stays active, with developer role and project membership. This proves a session boundary separate from actor and resource authority, without real inference or external accounts.

## Correction

Existing callbacks lock active user then the current session (ID and same user, non-revoked) on their original transaction client before resource locks. Revocation-first is denied; an earlier legal operation pins revocation until COMMIT. Current expiry is checked both on session acquisition and after resource permission locks immediately before mutation, covering natural time passage while waiting. Time itself is not lockable; no claim that a session remains unexpired throughout a delayed COMMIT. Current recent-auth window remains checked at the existing high-risk entry and is the next separate characterization. No Gateway/migration/accounting/credential/automatic existing-Key revocation changes.

## Verification

Same frozen native6 GREEN:2765ms,55 stable inputs, canonical28/clients0. Formal18 includes those six, six actual session-guard waits (revocation/expiry × create/disable/revoke), three actual deferred COMMIT gates and three real-clock natural expiry cases while the project guard waits. Denied operation preserves all business facts, sessions, audit, outbox and cache; legal earlier operation keeps exact Key/audit/outbox and issuance hash/scope, then fresh withdrawn session401. Pending actual COMMIT keeps Key/audit and user/session effects invisible while the session writer blocks. Canonical28 and no-other-client/advisory/current_database/strict-loopback guards remain mandatory.

Formal SHA256 `20bbbcc3714ee48915d641631b8dec205e266b79e277df78a54ef454046466bf`. Related formal18/actor14/creation21/mutation24/lifecycle17/body-authority8/atomic4/project7/auth32:145PASS/0fail/0skip,424 inputs unchanged within/across all stages; canonical28 restored, clients0 and all children/pools closed. Tests run serially; compiler/scoped lint/format/contracts3/secrets pass. Accepted evidence is `.test-artifacts/key-session-authority-formal-round80/related-summary.json`. Primary maintainer reviews SQL bindings, callback ownership and user→session→existing resource lock order; no independent source review is claimed. Read-only manual review identified billing visibility and archived-project management omissions, corrected in this slice. Exact C16 mainf6e28a3 CI37167974480 and Pages37167973990 SUCCESS; C15's hosted run was normally superseded/cancelled. That is prior-revision acceptance until the next hosted run/checkpoint.

## Next action

Run a fresh broad checkpoint after C15–C17, maintaining source stability during verification. Characterize recent authentication crossing its window during a locked Key DELETE using a real clock, with regular PATCH and fresh DELETE controls. Continue after commit.

## C17a — Actual CI timeout correction

The full committed C17 checkpoint had932 unchanged Git inputs, unit754/contract391 PASS, Integration775PASS/3FAIL/0skip; security was not reached. Exact main33b5b57 CI37175128988 failed the same three natural expiry cases (Linux774PASS/3FAIL). Their required8-second clock wait exceeded the repository's default5-second test timeout; the ignored related config's20-second override had masked this fixture defect. Production behavior and assertions are unchanged. Only these three tests now explicitly declare20 seconds. Actual unmodified `vitest.config.mjs` regression18 PASS/0skip in28.919s,932 Git hashes unchanged, canonical28/clients0; receipt `key-session-timeout-round80/regression.json`. Failed full receipts are preserved. Do not claim the C17 repository baseline healthy until the fresh complete checkpoint and exact new hosted revision pass.
