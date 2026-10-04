# C30 — Preserve Anthropic classifier refusal as filtered output

Starting topic `a990b0f`, main `2f372a2`. A recognized Anthropic `refusal` terminal previously became ordinary `stop`, so Chat lost its policy-filter classification, Responses reported completed output and Playground allowed continued history.

[Anthropic's streaming-refusal contract](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/handle-streaming-refusals) distinguishes classifier intervention from ordinary model-generated refusal text. Together with [OpenAI's finish-reason contract](https://developers.openai.com/api/reference/resources/chat), this supports the inferred cross-provider mapping to `content_filter`. Change only this reason and advance Anthropic1.0.10→1.0.11; preserve Gemini1.0.6 and all other mappings, including context exhaustion as length and unknown-reason rejection.

Keep observed partial text and nullable usage. Do not synthesize a refusal field or forward native stop-details explanations. Existing Responses logic marks filtered output incomplete and Playground disallows continuation, while Request/Attempt/accounting remain completed executions. There is no retry, fallback, rewritten content or channel-health penalty. Plain model-written refusal wording with end_turn remains ordinary text/stop. Pause/server-tool continuation is separate and unchanged.

## Characterization and verification

Prior actual-wire local characterization and real Playground projection establish the lost filter signal. The formal tests reuse the C28 four-path Chat/Responses buffered/SSE assertion body; two thin cases add classifier refusal and ordinary refusal text. The existing native fixture gets an optional text argument with its original default preserved. A private synthetic stop-details explanation is checked against output, headers, durable facts and logs.

Ignored overlay OLD:5RED/29controls/0skip,212 stable inputs. Published tests are byte-identical to the frozen draft. Native OLD on the C29 commit repeats exactly5RED/29controls/0skip,213 stable inputs including208 public Go/module files and ignored drafts/runner. Only the provider refusal row and four HTTP classifier-projection paths fail. Accounting, actual observed usage, one dispatch/no eligible fallback, zero BYOK money, identity, privacy, prefix and channel health remain valid before the failing assertions.

The same34 leaves plus two registry-version checks pass after the minimal production fix. Full native provider672PASS and related Linux race446PASS have zero failures/skips; vet/build and pinned golangci-lint0issues pass. All960 public inputs remain unchanged during final scoped verification. Playground46PASS, TypeScript compiler, format, secret scan, diff checks and independent source/test review pass. The first scoped gate's test-style lint failure is retained; the equivalent tagged switch passes the final gate without suppressions. Only evidence/status prose changes afterward.

Latest complete hosted acceptance is now C29 CI37188618900 and Pages37188618594 on main `2f372a2`; this local slice does not claim another full hosted or paid-provider acceptance. The user requested ending the maintenance task after C30, so later drafts remain unpublished.

Receipts: ignored `.test-artifacts/anthropic-classifier-refusal-round94/`, preserving both overlay and native OLD plus GREEN output. No databases, production accounts or paid providers are used by these tests.
