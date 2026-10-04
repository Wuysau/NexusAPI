# C24 — Reject unsupported audio response history

Starting topic `b4be604`, main `ed56e95`. Chat message decoding currently discards the assistant `audio` envelope because the canonical message has no corresponding field. An accepted request can therefore execute with different history from the caller's supplied conversation.

## Minimal contract

Reject every non-null `messages[i].audio` envelope with the existing fixed HTTP400 `unsupported_parameter` response and indexed field path, before authentication, credential resolution, reservation, idempotency claims or dispatch. Do not echo the supplied value. This deliberately refuses an unsupported history representation instead of implementing a new audio execution capability.

The [OpenAI Chat contract](https://developers.openai.com/api/reference/resources/chat) permits an omitted or null assistant audio envelope; both retain existing behavior. Raw content arrays, including `input_audio`, remain opaque to this check. Refusal, reasoning, tool-call and tool-result history retain their existing serialization. No general message-field allowlist, provider retry, accounting change or new execution plane is introduced.

## Characterization and verification

Frozen OLD:16 expected failures and4 compatibility controls,204 Go/module inputs unchanged. The unchanged20 tests pass after the minimal envelope-only guard. Cases cover ten non-null shapes, managed/BYOK buffered/SSE preflight, rejection before authentication, zero execution/accounting/idempotency/breaker effects, corrected-request sole ownership of its idempotency key, private data exclusion, and actual local upstream wire equality for absent/null compatible history.

Only local mock providers and in-memory execution fixtures are used. OLD/GREEN and subsequent gate receipts are retained under ignored `.test-artifacts/audio-history-round88/`. Supported Go regression and independent review results are recorded after completion. Latest C23 hosted CI37183185305 failed Integration; its failure is investigated separately and is not accepted as a green baseline.

Independent review is clear. Full supported Go gate2410PASS/0fail/0skip includes Linux race, vet, format, lint0issues, actual storage recovery and Budget/Worker accounting replay; native Gateway build also passes. All948 public inputs stayed unchanged throughout the349-second gate. Scoped document formatting, secret scan and diff checks pass. Native Windows race remains unverified because its cgo toolchain is unavailable. Only evidence/status prose and the separately reviewed integration-fixture correction follow this checkpoint; no Go or runtime service changes are required by that correction.

After the separate C23a fixture correction, full Integration806 and E2E15 also pass with zero failures/skips;949 public inputs remain unchanged during that interval. The Gateway code and test file match the accepted Go checkpoint. Owned services are closed. This is local acceptance; new hosted CI is checked separately after submission.
