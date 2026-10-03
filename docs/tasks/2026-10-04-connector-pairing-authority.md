# Current administrative authority for Connector pairing

## Characterization

Native disposable round73 repeats unchanged OLD:2 failures/6 controls. Actual recent-auth/session/CSRF POST waits on a native highWaterMark0 body, then an administrator becomes a developer while retaining legitimate project membership and ProjectGET200. First issuance still returns a pairing token and adds Channel/credential/pairing plus success audit. Rotation replaces the token hash, revokes synthetic identity/lease and changes Connection/Channel plus success audit. Fresh developer requests are403 and healthy administrative/CSRF controls pass. No real connector, Gateway inference or production credential participates. An initial fixture facts-order setup error is retained separately and is not counted as defect reproduction.

## Minimal correction

Retain early administrative check, validation and Connection-first FOR UPDATE order. Before any mutation, use existing resolveWorkspaceRole on the same transaction client with membership/organization FOR SHARE locks, then require current owner/admin. Hold authority through existing COMMIT. Existing project eligibility, provider/credential boundaries, recent-auth, CSRF, rotation semantics and redacted audit metadata remain. No migration, execution change or Gateway hot-path read. Post-commit audit atomicity and session revalidation are separate unchanged boundaries.

## Verification

Same frozen native8 GREEN/0fail/0skip,2.367 seconds, stable source hashes and zero other fixture clients; denied issuance/rotation preserve complete domain facts and successful audit count. Formal test copied byte-for-byte with SHA256 `c27b0d06678f33f4cc90cb560f6683010e0740a1b49f6570a5a017849dccd970`. Fresh nonincremental compiler, scoped lint/format/secrets scan and independent read-only source/test review pass. Existing configuration10, formal regression8 and actual private-TLS Gateway/standalone CLI local Connector19 all pass:37 total/0fail/0skip. Related local verification takes32.402 seconds;565 source/migration/test inputs remain unchanged, canonical28 migrations, zero other fixture clients and zero owned executable processes. The first local launch omitted Windows LOCALAPPDATA in the new runner and never reached test execution; retain its failed/skipped receipt separately. Correct only that ignored runner environment, then run actual verification once. Evidence remains ignored in connector-pairing-authority-round73. Manual and operations guide document current administrative authority and the commit ordering boundary.
