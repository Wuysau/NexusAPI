# C25 — Bound the Control Plane health query read

Starting topic `316c587`, main `b60c911`. The shared pool already bounds connection acquisition/startup, but `/api/health` awaits a database response without a query read deadline. A completed SQL response lost in transport can retain a checked-out connection and leave health unresolved.

## Characterization and contract

An owned transparent TCP proxy against a new guarded disposable PostgreSQL database warms the actual route, forwards its next unchanged `select 1`, then withholds only the returned bytes. OLD remains pending after3429ms with pool total1/idle0/waiting0 while the scoped backend has already completed the query. Releasing the same bytes returns200; the next explicit request also returns200. Exactly three explicit queries and one connection occur, with no replay.

Give only this fixed probe a native node-postgres `query_timeout: 2000` through `pool.query`. Timeout follows existing `500 {"ok":false}` handling. The pool releases the failed query with its error and removes/closes that connection; only a later explicit request obtains a replacement. Preserve `200 {"ok":true}` and dynamic routing. No global SQL timeout, inference retry, Promise.race, transaction behavior change or new pool is introduced.

The query timer starts after connection acquisition. Existing acquisition/startup and new response-read limits are separate two-second phases, potentially approximately four seconds combined, not a two-second whole-HTTP deadline. This is a local client read timeout and socket cleanup; it does not promise PostgreSQL CancelRequest or cancellation of other callers' SQL.

## Verification

New formal tests exercise the actual child-imported route and shared pool through real PostgreSQL: stalled health failure/removal/new explicit recovery, promptly released health200 on the same backend, and an ordinary read retained beyond2.4s then successfully released. The last case protects the absence of a global query timeout. Fixture setup verifies exact disposable URL/current database/exclusion/no-other-client checks before canonical reset, and cleanup checks natural child exits, sockets and scoped database backends.

Initial native probe keeps45 executable/driver/migration inputs stable. Ignored draft execution has1 expected RED/2 controls with46 stable inputs; its JSON-only reporter suppressed safe console observations, so wrapper aggregation failed after the test run. Preserve that report and the separate post-run reconciliation; no test rerun was used to hide it. The subsequently published test under the repository config again yields1 expected RED/2 controls in8823ms, with verbose+JSON evidence for all three normal child exits, sockets0/backends0, canonical28 and clients0.

No production server signals, accounts, credentials or paid providers are used. Raw wire/auth bytes are forwarded in memory and never stored in evidence. Receipts: ignored `.test-artifacts/control-health-query-round89/`. GREEN, related regression, compiler/build and independent review results are recorded after completion.

Formal root-config GREEN3PASS/0skip in8070ms; the public test is unchanged from OLD and all46 inputs remain stable during GREEN. All three children exit normally with no forced cleanup, sockets0/backends0, canonical28 and clients0. Existing acquisition5 and recovery5 tests pass on their separate named fixtures, each with43 stable inputs and canonical28/clients0; no new global timeout, queued replay, ordinary-error suppression or cached listener regression appears.

Compiler, scoped lint/format, secret scan, diff check and independent final review pass. Production Control Plane build passes in18737ms, retaining the existing dynamic tracing warnings; build-artifact isolation contracts35PASS. The immediately preceding C23a/C24 checkpoint (Integration806/E2E15 and Go2410/Linux race) is separate prior evidence, not a claim that the entire suite was rerun for this health-only change. New hosted acceptance remains revision-specific after submission.
