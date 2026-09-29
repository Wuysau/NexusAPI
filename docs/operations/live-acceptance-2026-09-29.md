# Configured-project acceptance — 2026-09-29

This is an acceptance record, not the usage manual. Tests used the owner's existing Nexus project, Codex subscription and three-model Kingstar Coding Plan channel. No live database reset, reseed, price approval, recharge or ledger rewrite was performed. Private root-worktree changes were preserved.

## Findings and fixes

| Finding | Cause and correction | Verification |
| --- | --- | --- |
| Listed secondary models returned `503 no_healthy_upstream` before reaching the provider | Legacy local encrypted credentials authenticated only the first model. New v2 credentials authenticate the saved model allowlist; v1 stays single-model. The existing channel was upgraded from credential version 1 to 2 under row locks and version checks, retaining its key and configuration. | All three real models return 200 with two-character responses and stop completion; TS/Go cross-language authenticated-envelope tests and rollback/conflict tests pass. |
| `stream_options.include_usage` returned 400 | Added strict support for the documented boolean option; explicit null acts like omission. Usage-only final chunks have empty choices, missing counters remain null, and completion still depends on durable persistence. | Real stream returns 200 with 19 SSE events and final `[DONE]`; option/partial-usage/interruption/persistence regressions pass. |
| Invalid `max_completion_tokens` could reach the upstream | Added the same positive bounded-range validation already used for `max_tokens`. | Negative, zero and over-limit fixtures return 400 without upstream calls, budget holds or terminal requests. |
| Unrelated currency dimensions and BYOK margin showed false zeroes | Empty money buckets now mark absent facts separately from unknown or known-zero facts. The UI renders absent dimensions as an em dash. No stored money changes. | Contract, SQL-backed analytics, rendering tests and real gateway analysis all distinguish zero, unknown and absent. |
| API connections suggested an unavailable subscription refresh; all subscriptions were labelled Codex | Project quota presentation uses the registered subscription product and gives API-specific guidance. | UI regression and actual custom-channel project page checked. |

The narrow-screen sidebar initially appeared to cover content in a screenshot captured during its resize animation. Fresh mobile navigation and screenshots verified correct behavior; no layout change was needed.

## Real and simulated coverage

| Area | Result and scope |
| --- | --- |
| Console | 18 primary routes returned 200 with no page exceptions or failed page API calls: overview, resources, routing, channels, connections, models, pricing, keys, projects, tasks, logs, billing, reconciliation, members, audit, settings, playground and docs. |
| Projects and connections | Live temporary project creation/editing/archive, stale-version rejection, two connections bound to one project, unbind/rebind and revoke passed. Existing user connections were not reassigned. |
| Model configurations | Temporary display configuration creation, update, stale-version conflict and removal passed. No price/catalog publication. |
| Channel lifecycle | A temporary local mock upstream verified channel creation with two models, diagnostic, weight/priority edits, pause/re-enable, key replacement and revoke. Paused diagnostics returned 404. It made no real supplier request or financial event. |
| Access control | Live viewer mutations returned 403; missing-CSRF mutation returned 403. Temporary gateway keys were created with a project, then revoked; revoked keys returned 401. Tenant/role isolation also has disposable-database coverage. |
| Codex subscription | Official account refresh returned 200/connected. Quota read returned a provider-reported weekly window; freshness expires as designed when the page is not refreshing. No independent account switching was attempted. |
| Claude Code observation | A real one-turn, tools-disabled Claude Code invocation returned `OK`. Observer imported the new session as `claude_code_local`, attributed it to Nexus, and recorded model `glm-5.2`, 1,549 input and 19 output tokens from the session file. CLI summary totals differed; the observer used the actual assistant record. |
| Gateway | Model listing includes all three configured models; all three non-streaming calls and a GLM streaming call passed after the credential fix. Unknown-model requests are rejected. |
| Metering and Worker | All four successful retest requests are completed and attributed to Nexus; their outbox events are published. Missing approved prices create `missing_price_version` reconciliation cases. No wallet ledger postings were created. Missing provider token components remain unknown. |
| Analytics and mobile | Source filters, empty filters, session detail and grouping totals checked. Desktop and 390px mobile views and mobile menu navigation passed. |
| Tasks | User confirmed there is no independent logged-in Profile and requested simulated tests only. Supervisor/runtime/route/isolation/failover tests run against the disposable database. No live supervised task or cross-account handoff is claimed. |
| Payments | Stripe is unconfigured and no purchasable plans exist. Checkout, webhook verification, duplicate processing and entitlement behavior were verified with isolated fixtures; no real checkout/charge/refund was made. |
| Price approval/member administration | Existing pages read successfully; destructive role changes and real commercial price activation were tested only with fixtures, not against the owner's configuration. |
| Online playground | The current page explicitly directs users to a compatible client; an interactive browser chat is not implemented. Actual gateway testing used the API. |
| Additional Agent tools | Only installed/configured Codex and Claude were verified live. The adapter regression suite covers other supported formats; this is not a claim of live testing every vendor tool. |

## Real gateway retest

The prompt requested only `OK`, with a 512-token maximum. Initial GLM testing at 64 tokens exhausted the output limit on reasoning; this was a test-budget limit, not a routing failure. Latencies below are single observed calls, not a benchmark or SLA.

| Model | Mode | HTTP | Elapsed | Result |
| --- | --- | --- | --- | --- |
| `aliyun/glm-5.2` | Non-streaming | 200 | 2.110 s | 2 response characters, stop, 117 output tokens |
| `aliyun/qwen3.7-max` | Non-streaming | 200 | 3.315 s | 2 response characters, stop, 132 output tokens |
| `deepseek/deepseek-v4-pro` | Non-streaming | 200 | 1.504 s | 2 response characters, stop, 29 output tokens |
| `aliyun/glm-5.2` | Streaming with usage | 200 | 5.626 s | Deltas, 19 SSE events, final `[DONE]`, 70 output tokens |

Provider responses did not establish every input/cache component required for inclusive totals. Those dimensions remain null instead of being invented or silently treated as free usage.

## Test resources and limits

Temporary keys and connections were revoked; temporary project/model configuration were archived through normal APIs. The mock channel was disabled and its local credential files removed. Their labelled audit/history records remain by design. The original channel key was reused without being printed; encrypted rollback material stays only in ignored local artifacts. Existing immutable request, usage and reconciliation evidence remains intact.

Current missing production inputs are an independently authenticated Profile/task policy and Stripe merchant credentials/published plans. Neither gap can be proven working by simulated data. No runtime configuration for those missing services was fabricated.

Final automated gate receipts are recorded in the [task record](../tasks/2026-09-29-live-functional-acceptance.md).
