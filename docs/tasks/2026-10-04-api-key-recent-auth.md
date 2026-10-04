# Recheck recent authentication before Key revocation

## Characterization

Exact disposable round81 OLD twice:1RED/2controls,20531/20815ms,55 actual import/migration inputs stable, canonical28/clients0. Native DELETE enters while the session is recent, then waits on a real Key row. Real time crosses the existing15-minute window. The same still-valid session reads its Project200 and fresh DELETE401 forbidden without effects, but the waiting DELETE200 changes Key/audit/outbox/cache. Healthy recent DELETE and naturally aged ordinary PATCH succeed. No clock mocks, production accounts or inference.

## Correction

The existing locked session lookup also returns its creation time. Only the HTTP DELETE authorization callback opts into recent authentication; after current Key/resource authority locks, the existing `requireRecentAuth` receives age recomputed from that locked row and current time. Existing entry checks, error code/window, transaction ownership and lock order stay intact. Creation and PATCH retain their ordinary valid-session requirement. No additional SQL round trip, Gateway, schema, credential or immutable history change. Time passage through a delayed COMMIT is not claimed to stop.

## Verification

Same frozen native3 GREEN:20314ms,55 inputs stable, canonical28/clients0. Formal4 adds the same real-clock crossing while the actual project authority guard waits. Healthy/recent and aged PATCH preserve exact lifecycle/audit/outbox/history; both aged DELETE waits401 forbidden with complete facts/cache unchanged. Each slow real-clock test declares its own20-second timeout; the ignored related config no longer overrides the repository default5 seconds. Compiler, scoped lint/format/secrets/contracts3 PASS; primary source review, not independent acceptance.

Formal SHA256 `bfedccd9e5fbc9f84ba5143c9f4de0dfa0a4e83aea402a8f62acd7f5b63bb19b`. Related formal4/session18/actor14/creation21/mutation24/lifecycle17/body-authority8/atomic4/project7/auth32:149PASS/0fail/0skip,425 inputs unchanged across all stages, canonical28 restored/clients0. Tests run serially using actual formal tests. Accepted aggregate: `.test-artifacts/key-recent-auth-formal-round81/related-summary.json`. Before this slice, complete C17a checkpoint:unit754/contract391/Integration778/security49, zero fail/skip with932 unchanged Git inputs. Earlier C17 full/hosted timeout failures remain preserved and explicitly classified as the fixture defect; no rerun-until-green claim.

## Next candidates

Audit bounded Control Plane lock waiting after the newly retained actor/session locks; inspect actual timeout defaults and characterize before changing behavior. Anthropic unknown-stop mapping remains an already-characterized separate P2 backlog item. Continue after commit.
