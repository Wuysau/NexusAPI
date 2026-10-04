# C22 — Reject unknown Anthropic stop reasons

Starting topic `be06e3d`, main `a3033ad`. Native messages SSE currently maps every unrecognized nonempty stop reason to `stop`. A later message_stop then certifies completed Request/Attempt/UsageEventV2 facts even though the provider reported an unknown terminal condition. The existing adapter is also used for buffered Chat responses.

## Minimal contract

Reject an unrecognized nonempty reason at its message_delta using a static protocol error and the usage already observed, including counters validly supplied in that same event. Do not emit a successful finish chunk, continue consuming a later replacement ending, retry inference or select another provider after dispatch. Existing Gateway failure handling owns the unknown outcome, safe response and accounting.

Keep all seven [documented Anthropic stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) recognized: end_turn, stop_sequence, max_tokens, tool_use, pause_turn, refusal and model_context_window_exceeded. Existing mappings remain in this small compatibility correction; fuller projection of the newer known reasons is a separate backlog item. Existing missing/null/empty reason and message_stop-only compatibility also remains.

## Characterization and verification

Two retained unknown markers reproduce OLD failures in provider and real Gateway HTTP buffered/SSE tests, with an eligible fallback and valid later ending. Tests check one dispatch/no fallback, preserved counters and nullable accounting, unknown terminal records, bounded static errors, authoritative request identity and no private reason in public output/stored facts/logs. Known/absent reasons and ordinary HTTP completion serve as controls.

Local mock provider only; no paid or production provider. Detailed OLD/GREEN/gate receipts are ignored under `.test-artifacts/anthropic-stop-reason-round86/`. Verification results are added after implementation.

Native OLD: provider4RED/12controls and HTTP4RED/2controls. First GREEN exposed two incorrect new legacy-counter expectations; existing message_start records authoritative observed output but does not update the legacy output field. Corrected assertion (legacy0 without delta,7 with delta) retains the observed2/7 assertions. Corrected OLD replay through a Go source overlay again has4RED/12controls; GREEN provider16/HTTP6 all pass. The original evidence is retained. Independent behavioral review is clear; adapter version advances to1.0.9 with existing registry expectations, for startup/diagnostic attribution (no new historical per-request version column).

Final checkpoint: unit754/contract391/Integration804/security49 and isolated E2E15 all PASS, zero failures/skips. Full supported Go gate2386PASS/0skip, Linux race/vet/format/lint0issues, actual storage recovery and Budget/Worker accounting replay pass; native Gateway build also passes. All944 public inputs remained unchanged from checkpoint start through the end of Go/E2E. Owned3311/3320 listeners are closed. Native Windows race still requires an unavailable cgo toolchain; the supported Linux race result is distinct.

Exact prior C21 main a3033ad CI37181344385 is fully SUCCESS (including images/Vault/E2E/SBOM). New C22 hosted acceptance must be checked separately after normal submission. Only evidence/status prose changes follow the frozen local checkpoint. Full receipts: `.test-artifacts/continuous-maintenance/periodic-pool-anthropic-stop/` and the round86 folder above.
