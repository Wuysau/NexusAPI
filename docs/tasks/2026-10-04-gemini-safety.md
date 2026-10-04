# C27 — Preserve Gemini safety-filtered completion semantics

Starting topic `2f92586`, main `8a8836e`. Gemini's known `SAFETY` finish reason currently becomes ordinary `stop`. Clients lose the filtered-output distinction; nonempty partial text becomes eligible for Playground continuation, and Responses reports a completed output.

[Google's finish-reason contract](https://ai.google.dev/api/generate-content#FinishReason) identifies SAFETY as flagged output. [OpenAI Chat's contract](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) uses content_filter for filtered output. Map only SAFETY to that existing canonical reason. Preserve text and observed nullable usage; do not synthesize refusal text. Other known projections and existing unknown-reason errors remain unchanged.

Chat buffered/SSE retains successful HTTP/protocol termination with `finish_reason: content_filter`. Existing Responses mapping reports `incomplete` with content_filter details, and existing Playground behavior refuses continued history. A recognized terminal still represents a completed provider execution: Request, Attempt and usage accounting remain completed, with no retry, fallback or breaker penalty. Response completeness and execution accounting are distinct facts.

Gemini adapter version advances1.0.5→1.0.6 for existing registry/startup diagnostics; no new historical per-request version field is implied.

## Characterization and verification

Ignored overlay OLD:6 expected RED/10 controls,209 stable inputs. Published native OLD again has6RED/10controls,215 stable Go/supporting inputs. Failures concern only SAFETY finish/projection; completed accounting, observed input5/output2/reasoning0, absent cache/total, preserved text, one primary/no eligible fallback, one terminal/outbox and private-content exclusion are checked before the failing assertions. STOP/MAX, selected unchanged known reasons and unknown-reason rejection are controls.

After the minimal map, those16 leaves plus two registry-version checks pass. Playground contract46PASS includes a new explicit content_filter continuation control; its behavior already existed before the adapter fix. Only local mock providers/in-memory stores are used, with no database or paid upstream calls.

Receipts: ignored `.test-artifacts/gemini-safety-round91/`. Scoped Linux race, full provider/native compilation, lint and independent review follow. The immediately preceding C26 full Go2429 and unit754/contract391/Integration809/security49/E2E15 checkpoint remains distinct prior evidence.

Final acceptance: full native provider672PASS/0skip; related Linux race141PASS/0skip across Gemini, Responses, unknown-finish rejection and native Gemini history; native vet/build and pinned golangci-lint0issues pass. All956 public inputs remain unchanged through these stages. Playground46PASS, TypeScript compiler, scoped ESLint/format, Go format, secret scan, diff check and independent source/test/document review pass. Only evidence/status prose changes afterward. Scoped race is intentionally distinct from the prior full C26 checkpoint; no new full database, paid-provider or whole-service CI acceptance is claimed here.
