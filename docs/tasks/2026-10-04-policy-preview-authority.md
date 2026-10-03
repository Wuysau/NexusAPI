# Current role for project policy preview

## Characterization

Native round72 OLD twice:4 failures/10 controls. Policy preview authenticates before body consumption, refreshes project visibility afterward, but uses the initial cached admin role for Connection visibility. Delayed admin→viewer/developer still has legitimate selected-project membership, yet receives another owner's unbound/private-project connection plus decision and success audit. Fresh project GET200 and hidden Connection list prove the capability/resource-scope distinction. Nonempty synthetic request/observed history remains unchanged; no execution or billing exploit is claimed.

## Minimal correction

Capture currentRole returned by existing resolveManagedProject. Construct only connection-query parameters from a context copy with that role; retain original authentication/audit context, project archive check, helper definitions, status/error and response contracts. No new query or lock, Gateway read, migration or execution change. This fixes cached-role reuse after body consumption; changes after the refreshed read are not additionally serialized.

## Verification

Unchanged native GREEN:14 passed/0 failed/0 skipped,2.46 seconds, stable six input hashes and no other fixture clients. Four hidden targets now404/no facts/no success audit; legitimate developer own/bound and billing privileged read controls remain200. Test SHA256 matches OLD `806f7b305cf6cbe48dc55b0ad16c4a799c11e703c9452a565fdc50ce0a896a5f`. Independent final read-only review approves. Broad checkpoint on this working tree:unit754/contract391/Integration658 (60 files,267 seconds)/security49, all zero fail/skip; all915 Git source files unchanged during verification. The coordinator initially used an unsupported security stage label before executing tests; the corrected security-only continuation preserves the three prior passing gates and original source digest. Fresh nonincremental compiler and scoped lint/format pass. Evidence remains ignored in policy-preview-authority-round72 and continuous-maintenance/periodic-task-authority. Manual updated; re-audit the next mutation boundary afterward.
