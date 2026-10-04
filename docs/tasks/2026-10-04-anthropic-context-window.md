# C28 — Report Anthropic context exhaustion as truncated output

Starting topic `acd715a`, main `a1acb06`. Anthropic's recognized `model_context_window_exceeded` reason previously became ordinary `stop`. Buffered and streaming Chat therefore reported natural completion, Responses reported completed output, and Playground allowed continuation with truncated history.

[Anthropic's stop-reason contract](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons#model_context_window_exceeded) describes valid but truncated content. [OpenAI's JSON-mode guide](https://developers.openai.com/api/docs/guides/structured-outputs#json-mode) explicitly uses `length` for context-window exhaustion. Move only this reason into the existing `length` mapping and advance the Anthropic adapter1.0.9→1.0.10. Preserve the other known mappings, absent compatibility and unknown-reason rejection; Gemini remains1.0.6.

Existing Chat/Responses/Playground logic now recognizes truncation without a new wire enum or continuation mechanism. Request, Attempt and usage accounting still record completed execution; retain partial text and observed nullable usage without retries, fallback or channel-health penalties. Responses' existing `incomplete_details.reason=max_output_tokens` is a coarse truncation category: it does not retain the native distinction between context capacity and the requested output cap.

## Characterization and verification

Ignored local characterization exercised actual Chat and Responses handlers plus the real Playground projection:8 cases pass with206 stable inputs. Context exhaustion yielded stop/continuation allowed, while max_tokens yielded length/continuation denied and ordinary end_turn remained compatible. No external provider or database was used.

Formal ignored overlay:5 expected RED/21 controls,206 stable scoped inputs. Published native OLD repeats5RED/21controls/0skip with208 stable Go/module inputs. The provider row and four actual buffered/SSE Chat/Responses cases fail only at truncation assertions after checking completed accounting, observed input5/output7, nullable total, BYOK zero money, one dispatch/no eligible fallback, authoritative request identity, privacy and healthy breaker state.

The same26 leaves plus two adapter-registry checks pass after the minimal fix. Full native provider672PASS and related Linux race436PASS have zero failures/skips; native vet/build and pinned golangci-lint0issues pass. All958 public inputs remain unchanged during those stages. Playground46PASS, TypeScript compiler, Go/document format, secret scan, diff check and independent source/test review pass. Only evidence/status prose changes afterward. The preceding C26 full local checkpoint remains separate evidence; no new full database or whole-service acceptance is claimed here.

Receipts: ignored `.test-artifacts/anthropic-context-window-round92/`; characterization: `.test-artifacts/anthropic-context-window-audit/`.
