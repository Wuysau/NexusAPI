# Refresh current APIKey issuance authority after body consumption

## Characterization

R62 project visibility and C03 atomic binding/audit intentionally left current apikey:create refresh separate. Exact disposable round75 native OLD twice:2 failures/6 controls,3.536/3.454 seconds. During actual body wait, admin becomes viewer while retaining project membership and ProjectGET200. Pending bound and omitted-project requests still return201, issue one Key/success audit and publish it in the actual HMAC-verified directory. Fresh same-session requests correctly403 with complete facts/directory unchanged. Healthy/Viewer/CSRF controls pass. Only synthetic sessions/signing and the fixture database participate; no Gateway execution or real credential. Initial fixture HMAC key derivation mismatch is retained as a setup failure, corrected before valid OLD, not treated as a production defect.

## Minimal correction

Keep initial apikey:create/CSRF guard. After readJsonBody, obtain the current context through the same capability guard and use it for existing project resolution and issuance. Preserve validation, exact metadata, one-time plaintext response, legacy omitted-project behavior and C03 transaction. This guarantees authorization at the refreshed read; subsequent membership/role/project changes are not serialized by this slice. No repository/service, migration, Gateway hot-path or execution change.

## Verification

Frozen native8 GREEN/0fail/0skip,3.682 seconds;356 inputs stable and zero other fixture clients, canonical28/current_database verified. Denied requests return403/no token/no Key/success audit/directory change; prior history stays immutable. Original native SHA256 `9c0086dd1ddab09d28987e6a170e23115c05f3ece9330bcf6da842b0d5512005`; formal promotion receives whitespace-only Prettier formatting with SHA256 `960a3f1238fe73a089b78613824d6e7b9fcf0d051271026d61e0fbef75d68f09`. Fresh nonincremental compiler and scoped lint/format pass. Actual formal8/atomic4/project7 pass:19 total/0fail/0skip,361 inputs stable, closed fixture pools. Independent actual source/test review approves. Periodic full unit754/contract391/Integration684 (63files,276.631 seconds)/security49 pass with zero fail/skip; all921 Git source files unchanged. Ignored api-key-authority-round75 and continuous-maintenance/periodic-key-authority retain evidence. Manual and project diagnostics guide updated.
