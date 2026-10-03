# Refresh current authority before a Connection heartbeat

## Characterization

R56 already covers project-membership removal at the UPDATE boundary and explicitly excludes organization-role refresh. Native disposable round74 repeats unchanged OLD:2 failures/8 controls. During actual highWaterMark0 body consumption, admin→developer still changes another owner's hidden-unbound Connection, and developer→viewer still changes a project-visible Connection. Both return200, replace capabilities/status/timestamps and append one success audit. Actual fresh same-session writes correctly404/403 before reading the body; Connection GET proves resource visibility separately. Nonempty synthetic request history remains unchanged. No inference, credentials or live external environment participates.

## Minimal correction

Retain early credential:create, scoped mode lookup and explicit local_sidecar identity rejection. After the body, repeat existing requireContext with credential:create and use that current context for scoped UPDATE and audit. Keep statement-time project membership, revocation/local mode predicates and existing report/default/capability behavior. The guarantee is authority at the refreshed read after body consumption; this does not serialize later membership/role changes with commit. No new capability, database transaction, migration or Gateway change.

## Verification

Original frozen native10 GREEN/0fail/0skip,2.431 seconds; formal10 and existing R56 regression13 pass,23 total/0fail/0skip with stable nine inputs and zero other fixture clients. Formal promotion changes only the exact named disposable CI15 allowance and current_database comparison to the supplied approved target. Original native SHA256 `4328f16cf208487ad03e31a9dde84a74dd43dcc7094e6a5a07e27c91f386ba52`; formal SHA256 `21749be16d5dce0faf45a4ed09f44d7b307ea3bbbe2d1ee8cc9f915ef88f5c8d`. Full facts and successful audits remain unchanged on denial; healthy admin/developer/owner/defaults, hidden/foreign/revoked, local identity, CSRF and project-member withdrawal controls pass. Fresh nonincremental compiler and scoped lint/format pass; independent read-only actual source/test review approves, including the refreshed-read limitation and unchanged assertions. Ignored heartbeat-authority-round74 retains OLD/OLD-repeat/GREEN/formal/related receipts. The related-runner generator initially rejected a mismatched template string before launching anything; it was corrected using the actual template. Manual documents current authority without adding local execution rights.
