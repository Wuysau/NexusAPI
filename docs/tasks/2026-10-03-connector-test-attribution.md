# Connector test success attribution

## Current evidence and design

The console connector test accepts any attempt matching the Gateway response's request ID, current tenant and target connection. Gateway capacity admission can record a failed attempt on that connection before dispatch, then complete the request through another authorized candidate. An actual private-CA TLS Gateway/two-CLI test confirms that the console reports the target as successful when only the fallback connection executes the test request.

[LiteLLM's per-attempt deployment hooks](https://docs.litellm.ai/docs/observability/custom_callback#per-attempt-deployment-hooks) distinguish individual failures and successes from the logical request's result. NexusAPI should use its existing persisted attempt outcome for this distinction. Its own pre-dispatch capacity records and no-replay rules remain authoritative.

## Minimal change

Require `status='completed'` in the existing tenant/request/connection attempt query. Keep the current `409 different_channel_selected` response when the target did not complete the successful request. Successful completion without reliable token usage still has a completed attempt; unknown counts/prices remain independent accounting facts. Keep project-key authorization, request cancellation and the existing sixty-second test deadline.

## Actual regression plan

Use a separate guarded disposable database on loopback port 55439 (`connector_test_attribution_round49` or existing CI `convergence_ci15`), rejecting URL query overrides before resets. Generate a dedicated private CA, build one real Gateway and two standalone connector CLI processes, and run two approved mock Ollama upstreams.

Give the target Channel priority 0 and the fallback priority 10, both with capacity 1 and zero admission wait. Approve shared/target-only and shared/fallback-only model pairs. Confirm both connector states, the signed two-Channel snapshot and the exact three-model Gateway catalog. Hold one real target-only upstream request open, while spare connector workers retain transport activity. The real console test of the shared model should safely skip the occupied target before dispatch, execute once on the fallback and return 409. Release the holder, then verify a target-completed console test returns 200.

Invoke the actual console route in a small Node child process with `NODE_EXTRA_CA_CERTS` set before startup. Read only synthetic fixture inputs over stdin; use native verified `fetch` to the real TLS Gateway and close the application database pool. This keeps the standard Vitest/CI entry point and Node 24.0 support, without global TLS bypass or a new application dependency.

Check actual upstream execution counts, frozen project/key/channel/connection attribution, three request/terminal/outbox records and four attempts. Preserve reported fixture usage and unpriced BYOK state. Capture old behavior before changing the production query; run TypeScript, relevant contracts, the regression and independent review before committing. No schema, migration, Go runtime, credentials or deployment change is planned.

## Results

- The formal old implementation has exactly one failing regression and one passing target-completed/accounting control (7.59 seconds). Its target records `failed/concurrency_exceeded`, the fallback records `completed`, and only the fallback executes the console test request. The assertion of 409 versus actual 200 is last, after verifying the real attribution and releasing the held target-only request.
- Across both scenarios, three upstream executions, three requests/project facts, four attempts, three terminal/outbox records and three Worker usage anchors are verified. All three missing prices enter reconciliation, with no priced usage record or ledger write. Private keys, pairing material and prompts are absent from durable attribution and child output.
- Initial fixture mismatches in response-envelope/request-ID projection and the project-fact key were corrected before the final behavioral baseline; setup failures are not counted as production evidence. The helper uses native verified TLS via startup CA configuration, never a TLS verification bypass. Every fixture process, listener and application pool is closed after the run.
- The fresh fixed implementation passes both real scenarios (7.12 seconds): the safely routed fallback returns 409 for the target test, and the released target returns 200. All execution, immutable attribution, Worker reconciliation and privacy assertions pass. The focused route/connector/accounting contracts pass thirty-eight tests (2.32 seconds); secret and diff checks pass. Fresh non-incremental TypeScript passes; targeted ESLint passes (2.987 seconds) and Prettier passes (1.238 seconds). Final independent-review results follow before commit.
- No Go source changed in this round. R48's native/vet/full Linux race results remain the Go baseline, and this dedicated TLS test uses that unchanged runtime. Subsequent model-configuration work is kept outside the R49 commit and begins after the real R49 execution completes.
- Final independent read-only review approves the six staged files with no remaining findings. It confirms that completed attempt status remains separate from reliable usage/pricing and that the staged scope excludes subsequent R50 changes. The reviewer did not rerun tests or access private configuration/databases; live deployment/load and inference beyond the reported fixture executions were outside review.
