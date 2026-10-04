# C26 — Reject unsupported legacy function-call history

Starting topic `30b3a4e`, main `9f91583`. Assistant `messages[i].function_call` is a documented deprecated input object, but the canonical Message has no corresponding field. Typed decoding discards the function name and arguments before provider validation; existing top-level legacy-option and function-role rejection does not cover this nested field.

## Minimal contract

Extend the existing envelope inspection to reject every non-null `messages[i].function_call` with fixed HTTP400 `unsupported_parameter` and the indexed path, before authentication, credentials, reservation, idempotency or dispatch. Do not echo supplied content. Preserve omitted/null compatibility and modern `tool_calls`, tool results and the separate Responses function-call item mapping. No general field allowlist, new legacy execution support or accounting changes.

The [OpenAI Chat reference](https://developers.openai.com/api/reference/resources/chat) documents the optional object/null envelope. Only loopback mock providers and in-memory Gateway fixtures are used; no database or real provider is used for this characterization.

## Verification

Ignored actual HTTP probes first show buffered/SSE HTTP200, one dispatch, lost call history and completed facts. An ignored formal Go overlay yields12 expected RED and7 controls; the initial helper stopped at unexpected SSE decoding, so its evidence is retained and a diagnostic-only refinement records the remaining execution/accounting assertions in a second draft run. No production change occurred between them.

Published unchanged draft under native Go on `30b3a4e`:12 expected RED/7 controls,205 Go/module inputs unchanged. Seven parser variants, managed/BYOK buffered/SSE side-effect checks and pre-auth rejection fail; absent/null modern wire and existing Responses controls pass. After the minimal guard, C26/C24 audio/Responses targeted regression39 leaves all pass. Corrected modern history owns its original idempotency key exactly once; private history stays out of errors, logs and terminal facts.

Receipts remain under ignored `.test-artifacts/legacy-function-history-round90/`; earlier characterization is in `.test-artifacts/legacy-function-history-audit/`. Full supported Go, periodic cross-service checkpoint and independent review results are recorded after completion. Prior C25 health-only acceptance remains separately documented.

Final independent source/test/document review is clear. Full supported Go2429PASS/0skip, Linux race/vet/format/lint0issues, actual storage fault/recovery and Budget/Worker accounting replay pass; native Gateway build also passes. Periodic unit754/contract391/Integration809/security49 and E2E15 all PASS with zero failures/skips. All953 public inputs remain identical from both checkpoint starts through final E2E; owned3311/3320 listeners close and only the original test PostgreSQL/Redis containers remain running. Scoped format, secret scan and diff checks pass.

Full receipts: `.test-artifacts/continuous-maintenance/periodic-health-legacy-history/` and round90 `checkpoint-summary.json`. Only evidence/status prose changes afterward. Native Windows race remains unverified without cgo; the accepted race environment is Linux. Exact C25 main9f91583 hosted CI37185223037 passed Integration and was still in Go at the last check, so no new full hosted success is claimed.
