# Open-source delta review — 2026-10-04

This review follows the current capability map and restored baseline in [task evidence](../tasks/2026-10-04-delta-control-plane.md). Fifty-one distinct repositories were scanned across dynamic Gateway/router, observability, Agent/DX and MCP queries. Ten received pinned source/test/license review: AxonHub, Plano, GPT-Load, Langfuse, OpenLLMetry, Helicone, Hermes, OpenCode, LoongSuite Pilot and Agent Sessions. No upstream tests were run and no third-party source or dependency was copied.

The selected implementation is two complete Control Plane slices: recorded Request/Attempt metadata detail and project-authorized browser Playground. The ADRs define authority and failure semantics before feature code. Existing capabilities are not counted as new features.

The records below include rejected/deferred behaviors to prevent later repetitions. License metadata is preliminary for scan-only repositories; actual LICENSE files were read for all ten deep reviews. License conclusions describe observed files and usage boundaries, not relicensing.

## Dynamic Gateway/router scan

Queries: `llm gateway stars:>1000 pushed:>2026-04-01` (12 results) and `model router stars:>1000 pushed:>2026-04-01` (8 results), ordered by stars. These dated counts are discovery evidence, not quality scores. Previously studied projects were scanned for changes, not selected again merely because they are popular.

| Repository | Stars | Language | License metadata | Last pushed (UTC) | Archived |
| --- | ---: | --- | --- | --- | --- |

| [bytedance/deer-flow](https://github.com/bytedance/deer-flow) | 83353 | Python | MIT | 2026-10-03T15:11:48Z | No |
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | 60086 | Python | NOASSERTION | 2026-10-03T19:20:57Z | No |
| [QuantumNous/new-api](https://github.com/QuantumNous/new-api) | 49232 | Go | AGPL-3.0 | 2026-10-01T11:52:16Z | No |
| [casdoor/casdoor](https://github.com/casdoor/casdoor) | 14505 | Go | Apache-2.0 | 2026-10-03T18:56:37Z | No |
| [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | 13123 | TypeScript | MIT | 2026-05-25T13:54:51Z | No |
| [tensorzero/tensorzero](https://github.com/tensorzero/tensorzero) | 11715 | Rust | Apache-2.0 | 2026-06-11T01:48:44Z | Yes |
| [TykTechnologies/tyk](https://github.com/TykTechnologies/tyk) | 10845 | Go | NOASSERTION | 2026-10-02T21:35:30Z | No |
| [maximhq/bifrost](https://github.com/maximhq/bifrost) | 8536 | Go | Apache-2.0 | 2026-10-03T19:03:08Z | No |
| [mnfst/llm-gateway](https://github.com/mnfst/llm-gateway) | 7551 | TypeScript | MIT | 2026-10-03T06:45:28Z | No |
| [katanemo/plano](https://github.com/katanemo/plano) | 7079 | Rust | Apache-2.0 | 2026-09-28T22:51:16Z | No |
| [tbphp/gpt-load](https://github.com/tbphp/gpt-load) | 7039 | Go | MIT | 2026-10-02T17:41:04Z | No |
| [looplj/axonhub](https://github.com/looplj/axonhub) | 5332 | Go | Apache-2.0 | 2026-10-02T14:44:07Z | No |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | 37524 | TypeScript | MIT | 2026-09-26T15:00:04Z | No |
| [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi) | 30361 | TypeScript | MIT | 2026-10-03T12:27:23Z | No |
| [BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter) | 6613 | TypeScript | MIT | 2026-10-03T09:43:24Z | No |
| [vllm-project/semantic-router](https://github.com/vllm-project/semantic-router) | 6016 | Go | Apache-2.0 | 2026-10-03T19:21:16Z | No |
| [weave-os/router](https://github.com/weave-os/router) | 5556 | Go | Apache-2.0 | 2026-10-03T18:59:41Z | No |
| [duolahypercho/codex-router](https://github.com/duolahypercho/codex-router) | 3912 | JavaScript | MIT | 2026-10-02T06:34:26Z | No |
| [edison7009/EchoBird](https://github.com/edison7009/EchoBird) | 3285 | Rust | MIT | 2026-10-02T16:05:50Z | No |
| [NVIDIA-NeMo/Switchyard](https://github.com/NVIDIA-NeMo/Switchyard) | 3270 | Rust | Apache-2.0 | 2026-10-02T23:12:57Z | No |

# Gateway, routing, account pool and control-plane UX delta research

Date: 2026-10-04 Asia/Shanghai. Dynamic GitHub API searches used `llm gateway stars:>1000 pushed:>2026-04-01` (12 results) and `model router stars:>1000 pushed:>2026-04-01` (8 results), stars descending. These scans include already reviewed projects to detect new deltas, not authorize repeat implementation. Snapshot metadata is retained under ignored `gateway-scan-0/1.json`. Archived status was inspected: TensorZero is archived at this observation despite 11,715 stars; do not call it currently maintained. Portkey last pushed May25, lower freshness than October candidates. Source/tests/license were read for the three deep reviews, not executed upstream.

## AxonHub — Adapt project selection and actual orchestrated Playground; reject alternate execution authority

Repository: [looplj/axonhub](https://github.com/looplj/axonhub). Stars5,332; Apache-2.0 actual LICENSE read; pushed2026-10-02 14:44:07UTC; Go. Positioning: multi-provider AI Gateway with project traces and browser debugging. Exact revision `89d36d610dc2ebf6d258e56bd1d051572a8c8449` (default branch unstable).

Read [internal/server/api/playground.go](https://github.com/looplj/axonhub/blob/89d36d610dc2ebf6d258e56bd1d051572a8c8449/internal/server/api/playground.go), [frontend/src/features/playground/index.tsx](https://github.com/looplj/axonhub/blob/89d36d610dc2ebf6d258e56bd1d051572a8c8449/frontend/src/features/playground/index.tsx), [selection.ts](https://github.com/looplj/axonhub/blob/89d36d610dc2ebf6d258e56bd1d051572a8c8449/frontend/src/features/playground/selection.ts), [selection.test.mjs](https://github.com/looplj/axonhub/blob/89d36d610dc2ebf6d258e56bd1d051572a8c8449/frontend/src/features/playground/selection.test.mjs), [trace-flow-timeline.tsx](https://github.com/looplj/axonhub/blob/89d36d610dc2ebf6d258e56bd1d051572a8c8449/frontend/src/features/traces/components/trace-flow-timeline.tsx) and LICENSE.

Key modules/functions: `NewPlaygroundHandlers`, `ChatCompletion`, `HandleError`, `readSelection`, `resolveSelection`, `computeSubtreeWidth`, `positionNodes`. Playground calls its ordinary ChatCompletionOrchestrator; a project-keyed selection is reset synchronously when the project changes. Selection tests exercise isolation and corrupted/unavailable storage. UI `useChat` sends selected project headers, supports stop and captures current auth context. Trace flow lays out request/response segments and model/token metadata.

Why valuable: test actual project routes inside the console and correlate to recorded execution. Nexus currently has only a canned connector test and static Playground; stored request/attempt facts lack all-attempt navigation. Implementation: original bounded buffered browser chat via existing Go Gateway, exact Nexus project Key; content-free request/attempt detail. Ownership: Control Plane owns console authorization; Gateway owns execution and request/attempt/outbox; Worker owns metering/ledger. No new inference orchestrator or backend graph store.

Risk decisions: **Security** reject direct Channel override, raw upstream error messages and debug request-body logging seen in source. **Credential** use only transient Nexus project Key, no provider/browser token extraction. **Tenant isolation** require session/project visibility and exact tenant/org/project Key; never accept project header as attribution authority. **Accounting** no separate calculator, direct provider call or fabricated known-zero usage. **Concurrency** one UI owner, cancellation, no regenerate/retry on uncertainty. **Migration** additive route/UI, no schema or historical facts rewrite. **License** Apache-2.0 checked; independent implementation, no copied source/dependency. Modify contract/service/API/UI/tests/docs only; Gateway hot path remains unchanged. Final decision: **Adapt**.

## Plano — Research only tenant-scoped stickiness and cost-aware routing

Repository: [katanemo/plano](https://github.com/katanemo/plano). Stars7,079; Apache-2.0 LICENSE read; pushed2026-09-28 22:51:16UTC; Rust. Positioning: AI-native proxy and agent routing data plane. Revision `72002a62d90ad13dd246cf3ef8d99d8c98b075ff`.

Read [session_router.rs](https://github.com/katanemo/plano/blob/72002a62d90ad13dd246cf3ef8d99d8c98b075ff/crates/brightstaff/src/handlers/llm/session_router.rs), [model_metrics.rs](https://github.com/katanemo/plano/blob/72002a62d90ad13dd246cf3ef8d99d8c98b075ff/crates/brightstaff/src/router/model_metrics.rs), their inline tests and LICENSE. Key functions: `resolve_session`, `is_user_turn`, `should_reuse_prior_decision`, `reuse_prior_decision`, `route`, `rank_models`, `rank_by_ascending_metric`, `ModelRates::request_cost_usd`.

Mechanism: tenant-scoped explicit/implicit session identity, warm model anchor, lane/prompt-prefix checks and switch-spend budget; cost/latency ranking appends missing metrics rather than using fake zero. Tests cover empty/no-data ordering, partial metrics, OpenAI/Anthropic cache pricing conventions and model-lane collision. Novelty: Nexus already pins Codex tasks, validates fresh quota and has API weighted routing; it has no observed cache-warmth/switch-cost model or authoritative cross-model quality router. Adding one now would exceed proven pricing/capability facts.

Ownership/SoT/write authority: such future API routing belongs to Gateway signed policy + Gateway-owned runtime health/load; local conversation continuity stays Local Agent. Worker price evidence remains billing authority. Risk decisions: **Security** prompt-derived affinity/heuristics must not grant execution permissions. **Credential** no alternate proxy subscription auth. **Tenant isolation** any sticky key must include tenant/project and authorized model lane. **Accounting** reject inferred cache warmth and missing-price switch permission as budget/charge evidence; no imported unofficial prices. **Concurrency** tenant-scoped bindings and durable capacity need a single owner; don't merge Profile leases with HTTP sessions. **Migration** signed policy/schema/compatibility rollouts required for future adoption. **License** Apache checked, no source copy. Estimated range Gateway/router/snapshot/contracts/Worker provenance benchmarks, too broad this cycle. Final decision: **Research only**, not a second proxy dependency.

## GPT-Load — Research only fair account selection; reject replay and subscription conflation

Repository: [tbphp/gpt-load](https://github.com/tbphp/gpt-load). Stars7,039; MIT LICENSE read; pushed2026-10-02 17:41:04UTC; Go. Positioning: multi-channel/credential gateway with account scheduling. Revision `82115ac676216bdcafde921e610cc03ce67118ad`.

Read [scheduler.go](https://github.com/tbphp/gpt-load/blob/82115ac676216bdcafde921e610cc03ce67118ad/internal/scheduler/scheduler.go), [fair.go](https://github.com/tbphp/gpt-load/blob/82115ac676216bdcafde921e610cc03ce67118ad/internal/scheduler/fair.go), [model_cooldown.go](https://github.com/tbphp/gpt-load/blob/82115ac676216bdcafde921e610cc03ce67118ad/internal/scheduler/model_cooldown.go), [inspect.go](https://github.com/tbphp/gpt-load/blob/82115ac676216bdcafde921e610cc03ce67118ad/internal/scheduler/inspect.go), [fairness_test.go](https://github.com/tbphp/gpt-load/blob/82115ac676216bdcafde921e610cc03ce67118ad/internal/scheduler/fairness_test.go), [affinity/key.go](https://github.com/tbphp/gpt-load/blob/82115ac676216bdcafde921e610cc03ce67118ad/internal/affinity/key.go) and LICENSE.

Key functions: `New`, `Iterator.selectCredential`, `ChargeReplay`, `CooldownUntil`, `Inspect`. Mechanism: snapshot candidates and credential identity generation, in-memory lock-protected weighted progress ledger, join watermark for new members, preferred affinity and bounded consecutive allocations, per-model cooldown reason inspection. Tests verify shared progress across independent requests/candidate sets, starvation bounds and model rotation. Good separation between no-I/O scheduler and mutable registry.

Nexus already has API hard filters/weights/model cooldown, official quota observations and one-runtime-per-Profile lease. General durable account-capacity/fairness and a decision explanation are still gaps, but copying an in-memory selection ledger would not establish durable multi-Gateway capacity or official subscription quota. SoT/write authority must be Gateway for API scheduling and Local Agent for authenticated Profile usage; collectors remain observational.

Risk decisions: **Security** preserve pre-dispatch-only failover; `ChargeReplay` is not permission to replay Nexus uncertain inference. **Credential** reject automatic subscription/API credential interchange and account secret export. **Tenant isolation** isolate signed project/account candidates, sticky identity and fairness ledger by scope. **Accounting** allocation count/cooldown is neither billed tokens nor fresh quota. **Concurrency** process-local fairness cannot replace Redis admission or PostgreSQL Profile fencing. **Migration** future durable generations/load facts require additive schema, ownership and upgrade protocol. **License** MIT checked, no copied code/dependency. Estimated range resource policy/compiler, Gateway/Local Agent runtime, durable state/tests/benchmarks, deferred. Final decision: **Research only**; **Reject** automatic uncertain replay/account-auth blending.

# Observability research and gateway capability map

Read-only product audit and GitHub research, 2026-10-04 (Asia/Shanghai). Product code and databases were not changed. The GitHub repository search, main-branch SHAs, source modules, license files and test source were fetched live through authenticated `gh api`. Upstream tests were inspected, not executed. An initial web search corroborated primary repository identities; implementation claims below come from pinned source, not search snippets.

## Current Nexus capability map

| Capability | Implemented source | Test / fixture evidence | Actual provider evidence / limitation |
|---|---|---|---|
| Standalone signed-snapshot Go gateway, independent credential and budget boundaries | `services/gateway/snapshot.go`, `auth.go`, `credential_vault.go`, `reserve.go`, `routes.go`; `services/budget/authorize.ts` | Cross-language signing vectors and snapshot freshness/admission tests; `tests/contract/secret-registry.test.ts`, `budget-boundary.test.ts`; gateway credential/budget integration suites | Production configuration is implemented and fail-closed. This audit does not verify current production topology or workload grants. Local desktop credentials are explicitly development-only; CP never supplies production secret plaintext. |
| Chat, streaming and Responses subset | `services/gateway/proxy.go`, `responses.go`, `canonical_request.go`, `provider/{adapter,openai,anthropic,gemini}.go` | Provider SSE fragmentation/usage/preflight tests; `responses*_test.go`; stream cancellation/deadline/refusal/stop/sampling tests | Sept29 acceptance proves three real Kingstar Coding Plan compatible models and one real usage stream. It does not prove every native Anthropic/Gemini/model operation. Responses is opt-in; embeddings are 501. |
| Routing and safe switching | `services/gateway/router.go:87`, `proxy.go:557`, `proxy.go:905`, `breaker.go`, `admission.go`, `rate_admission.go` | Admission Redis suites, resource failover, upstream timeout, cooldown, breaker and weighted router fixtures | Already has model licensing, tenant/project/region/mode constraints, priority/weight scoring, per-channel/model health and shared Redis capacity. A socket-assigned ambiguous failure never grants retry. Do not propose generic failover/rate limits/cooldowns as new features. |
| Model discovery | `services/gateway/connector_models.go:64`, `proxy.go` Models; `src/lib/catalog/{registry,sync,lifecycle}.ts`; `/api/models` | Connector model authorization batches, model discovery unit tests and catalog PostgreSQL integration | Direct-provider models preserve snapshot catalog behavior. Connector-backed models are live-authorized, scoped and batched: 5-second shared deadline, 64 requested IDs, four workers, no cross-request cache. Listing is not later inference authorization. |
| Durable logical request, immutable attempt identity and usage event | `services/gateway/outbox.go:41`, `attribution.go`; `packages/contracts/usage-event-v2.generated.ts`; `drizzle/0008`, `0010`, `0019`, `0026` | Gateway real PostgreSQL identity/attribution/provider-ID tests are env-gated; `tests/integration/project-attempt-attribution.test.ts` verifies immutable identities and actual Gateway role | Sept29 real calls produced completed attributed requests and published outbox events. Provider IDs are diagnostic metadata and may repeat; do not reuse them as unique financial identities. |
| Independent authorization and final billing | `services/budget/authorize.ts:21`; `services/worker/{consumer,processor}.ts`; `src/lib/billing/` | Real disposable PostgreSQL budget serialization/pin/expiry tests; worker savepoint/crash/idempotency/frozen pricing/v2/role tests; schema generation contract tests | Sept29 real calls lacked approved prices and opened missing-price reconciliation, with no ledger posting. Real managed wallet settlement and Stripe charges are not live-proven by that acceptance. Unknown price/usage is never free. |
| Request logging and analytics | `src/app/api/logs/route.ts:20`; `src/lib/billing/analytics.ts:91`; `analytics-access.ts`; `src/components/LogTable.tsx` | SQL-backed analytics and contract tests, live desktop/mobile logs browsing Sept29 | Existing logs are a flat read-only activity list and select the highest attempt only (`analytics.ts:108`). Row detail is just ID/source/resolved model/key. No request-detail fetch, all-attempt view or trace/provider ID search is present. |
| OTel and metrics | `services/gateway/telemetry.go`, `proxy.go:223`, `metrics_http.go` | Metrics authentication/redaction tests; trace support utility unit coverage | Actual production `.go` search finds only one `Tracer().Start` call, the request span. `telemetry.go` comments describing routing/attempt/persist spans overstate wired instrumentation. SDK samples 5%, uses bounded queue 2048 and debug summaries. No OTel span store/export collector or detailed subphase timing is implemented. |
| Canonical migrations and financial guards | `scripts/db-migrate.mjs`, `drizzle/meta/_journal.json`; guards `0008/0009/0010/0011/0019` and provider-ID metadata `0026` | Canonical prefix/hash/order/transaction rollback tests; explicit disposable DB required. Health recovery harness requires exactly 28 canonical migrations. | SQL files alone do not prove deployed migrations. Never run integration suites with an owner's live DB. Current note claims implementation/test availability only; baseline execution is parent-controlled. |

Documents read: `docs/operations/gateway-limits.md`, `open-source-research.md`, `unified-resource-control-plane.md`, `live-acceptance-2026-09-29.md` and actual `docs/provider-coverage.md` (there is no operations/provider-coverage file). Provider coverage distinguishes registration, native/collector observation and independently authorized API channels; most vendor products were not live-tested.

## Novel vertical slices grounded in existing facts

1. **Read-only Request / Attempt explorer** (recommended). Add a fixed typed detail contract and scoped GET for one recorded gateway request, expose request identity/trace ID, historical project attribution, ordered attempt IDs/outcomes/timing, nonsecret channel/connection/provider/model identifiers, pinned catalog/policy/price IDs and safe static error codes. Link existing LogTable ID to the detail. Reuse current `request:read` and `resolveAnalyticsAccess` inside repeatable-read read-only transaction. Bind tenant+organization+frozen project and request together before fetching children. Return same 404 for missing/hidden/foreign requests. No schema change, retry action, exporter, provider request, or ledger mutation is needed.
   - Historical scope matters: archived projects, removed users, moved/revoked keys and connections must follow the existing analytics policy, not current resource labels. Avoid inner-joining current keys/channels so deletion does not erase a user's visible history.
   - Fixed no-content whitelist excludes credential IDs unless needed as opaque authorized facts, raw event payloads, error messages, metadata, headers, prompt/output/tool arguments, and provider URL. Provider request IDs are bounded opaque diagnostic strings, not links or operations.
   - Request canonical nullable usage may be reused; per-attempt legacy integer columns default to zero and are not proof of an observed zero. Without matching authoritative usage-v2 evidence, show unknown rather than copying request tokens or presenting defaults as measurements.
   - Present recorded attempt start/end intervals only. No detailed admission/reservation/first-token/persistence spans exist. Ingress failures before persistence need an honest absent-record state.
   - Proof needed: actual PostgreSQL scope cases + historical IDs/multiple attempts + null/zero differentiation + safe-field output + no query mutations/upstream dispatch; actual browser detail/race/mobile verification. Existing tests are not acceptance for the new slice.
2. **Capability / operation evidence view** (secondary). `/api/models` already exposes catalog capabilities, availability, source kind and approved price evidence. A new read-only view can distinguish catalog-confirmed capability, current Go adapter translation, and configured Channel restrictions with provenance and unknown state. Preserve existing APIs and use adapter-supported intersections rather than hardcoding current model claims. No new model table, model inference, price approval or routing authority.
   - `src/lib/providers/openai-compatible.ts` and native Anthropic discovery record unknown capabilities `[]`. Source registry defaults text/streaming and reports no per-model capability provenance. Gemini discovery uses advertised supported methods. Go OpenAI capabilities still use name substrings (`openai.go:49`); native Anthropic defaults vision/tools/cache and uses model substrings for reasoning (`anthropic.go:44`). These are adapter hints, not current account/provider/model attestations.
   - Router presently asks only for baseline text (`proxy.go:564`, `RequiredCapabilitiesForChat`) and treats empty Channel capabilities as unrestricted. Adapter `ValidateRequest` handles request-fidelity preflight separately. A registry must not claim Channel routing success merely from catalog flags or a model name, nor silently alter dispatch policy.
3. **Read-only settlement pipeline evidence attached to detail** (optional extension to #1). Current facts can distinguish terminal persisted/outbox pending/published/dead letter/reconciliation/authoritative settlement. A completed HTTP request is not proof of charge. Show unknown/absent distinctly; never expose outbox payload/last_error or offer replay/reset/reconciliation mutations. Keep wallet and money visibility compatible with current analytics financial scope. Scope this after the attempt explorer rather than inventing a second ledger/status authority.

## Dynamic search and scan

Repository Search API queries (not a static curated list):

- `llm observability in:name,description archived:false pushed:>=2025-10-04`, stars descending, first 12.
- `llm tracing in:name,description archived:false pushed:>=2025-10-04`, updated descending, first 10 (mostly tiny project demos, not chosen for adoption).
- `mcp observability in:name,description archived:false pushed:>=2025-10-04`, stars descending, first 8.

Recentness below is the returned `pushed_at` UTC date compared with requested 2026-10-04, not `updated_at` or an assumed release date. Stars are discovery context, not correctness/security evidence. GitHub search may omit relevant projects; a 12-repo scan does not establish an exhaustive ecosystem census.

| Repository | Returned pushed_at UTC | Stars | GitHub license metadata | Scan disposition |
|---|---|---:|---|---|
| [Langfuse](https://github.com/langfuse/langfuse) | 2026-10-03 13:05:48 | 35,340 | NOASSERTION; actual LICENSE split MIT / enterprise dirs | Deep read; borrow project-scoped typed detail and timeline concepts. No hosted backend/SDK/dependency. |
| [OpenObserve](https://github.com/openobserve/openobserve) | 2026-10-03 18:45:26 | 22,239 | AGPL-3.0 | Broad log backend would duplicate operational platform and create licensing/storage footprint; reject for this slice. |
| [RagaAI-Catalyst](https://github.com/raga-ai-hub/RagaAI-Catalyst) | 2026-02-11 14:43:33 | 16,170 | Apache-2.0 | Python agent instrumentation/evals; mismatch to authoritative Gateway request facts. Defer. |
| [Bisheng](https://github.com/dataelement/bisheng) | 2026-09-30 18:17:23 | 12,022 | Apache-2.0 | Full LLM application platform; duplicates application/model/task plane. Reject wholesale. |
| [Evidently](https://github.com/evidentlyai/evidently) | 2026-09-29 08:32:43 | 7,966 | Apache-2.0 | Evals/quality metrics require separate user-authorized datasets/content. Defer, no content collection. |
| [OpenLLMetry](https://github.com/traceloop/openllmetry) | 2026-09-29 10:41:17 | 7,467 | Apache-2.0; fetched LICENSE | Deep read; useful content-free lifecycle principle, SDK default content behavior unsuitable. |
| [Plano](https://github.com/katanemo/plano) | 2026-09-28 22:51:16 | 7,079 | Apache-2.0 | Data plane/routing proxy overlaps existing Go Gateway. No second proxy. |
| [Helicone](https://github.com/Helicone/helicone) | 2026-09-16 19:29:27 | 6,199 | Apache-2.0; fetched LICENSE | Deep read; tenant-scoped request retrieval and query safety lessons. No proxy/body capture/HQL integration. |
| [Latitude](https://github.com/latitude-dev/latitude-llm) | 2026-10-03 18:02:17 | 4,701 | MIT | Agent failure/evaluation loop potentially useful later; adds content/dataset authority outside present scope. Defer. |
| [Logfire](https://github.com/pydantic/logfire) | 2026-10-03 00:23:28 | 4,507 | MIT | Python instrumentation/cloud-oriented runtime vs Go/TS stack. No SDK adoption for request detail. |
| [Trench](https://github.com/FrigadeHQ/trench) | 2026-04-06 23:11:33 | 1,664 | MIT | ClickHouse/Kafka event stack unnecessarily duplicates immutable Postgres facts and worker. Reject. |
| [Pensieve](https://github.com/DrJonaC/Pensieve) | 2026-09-16 21:25:38 | 1,386 | MIT | Model memory visualization is unrelated to current Gateway operation facts. Reject. |

Only license metadata was inspected for non-deep scan entries; licenses must be opened before any code/package reuse. No source was copied.

The MCP-oriented scan surfaced [PostHog](https://github.com/PostHog/posthog) (Oct3, NOASSERTION), [SigNoz](https://github.com/SigNoz/signoz) (Oct3, NOASSERTION), [Kubeshark](https://github.com/kubeshark/kubeshark) (Sep30, Apache-2.0), [Jarvis Registry](https://github.com/ascending-llc/jarvis-registry) (Oct1, Apache-2.0), [tRPC Agent Go](https://github.com/trpc-group/trpc-agent-go) (Oct3, Apache-2.0), [Zilla](https://github.com/aklivity/zilla) (Oct3, NOASSERTION) and [Golf MCP](https://github.com/golf-mcp/golf) (Sep9, Apache-2.0). MCP adoption is deferred: adding an AI-readable gateway expands credential/object-scope authority and is not needed for a typed console detail. These are scan results, not deep MCP protocol/security verification.

## Deep source reads at immutable SHAs

### Langfuse

SHA `f75c661dbe8c6b85523c81486b39e8403ac2c141`; main commit timestamp 2026-10-02 21:15:58 UTC. Main commit and repository pushed time differ because pushed time is repository activity, not main author date.

- [LICENSE](https://github.com/langfuse/langfuse/blob/f75c661dbe8c6b85523c81486b39e8403ac2c141/LICENSE): content outside `ee/`, `web/src/ee/` and `worker/src/ee/` uses MIT; enterprise paths have a separate license. No code copying planned.
- [Authorized trace detail](https://github.com/langfuse/langfuse/blob/f75c661dbe8c6b85523c81486b39e8403ac2c141/web/src/pages/api/public/traces/%5BtraceId%5D.ts#L36): read action is required, selected field groups control IO/metadata and observations. Retrieval supplies authorized project and read-only backing service; missing/foreign trace raises project-scoped not-found. Nexus delta: fixed content-free contract and existing multi-org historical analytics scope, no share/public trace support.
- [Shared API auth wrapper](https://github.com/langfuse/langfuse/blob/f75c661dbe8c6b85523c81486b39e8403ac2c141/web/src/features/public-api/server/createAuthedProjectAPIRoute.ts#L77): each route declares a project action, authenticated scope is delivered to handler, and rate/error handling is centralized. Nexus should reuse `requireContext` and existing scope resolver, not copy this new auth pipeline.
- [Project + trace keyed detail hook](https://github.com/langfuse/langfuse/blob/f75c661dbe8c6b85523c81486b39e8403ac2c141/web/src/features/traces/hooks/useTraceDetailData.ts#L39): query inputs bind project, trace ID and timestamp; gating avoids queries until identity/source is known. Nexus already has URL-keyed `useApiData`; detail must change URL on ID changes and clear stale results.
- [Timeline origin and duration](https://github.com/langfuse/langfuse/blob/f75c661dbe8c6b85523c81486b39e8403ac2c141/web/src/features/traces/fns/timelineCalculations.ts#L26): earliest start across descendants avoids misleading negative offsets; missing end can use supplied latency and empty inputs remain null. Nexus has a flat ordered attempt list and should calculate only available intervals, no fabricated timing.
- Inspected [timeline tests](https://github.com/langfuse/langfuse/blob/f75c661dbe8c6b85523c81486b39e8403ac2c141/web/src/features/traces/fns/timelineCalculations.clienttest.ts) and [API auth error tests](https://github.com/langfuse/langfuse/blob/f75c661dbe8c6b85523c81486b39e8403ac2c141/web/src/__tests__/server/unit/create-authed-project-api-route-auth-errors.servertest.ts). Upstream tests are implementation evidence only, not proof of Nexus scope isolation.

Decision: independently implement the small read-only fact explorer. Do not install Langfuse, emit prompt/output, create a new trace store, enable public sharing, or adopt enterprise modules. Risk axes: tenant/project IDs mandatory; no billing source replacement; no provider credentials/exporter secret; cheap bounded fact queries; no new concurrent inference; license segmented.

### OpenLLMetry

SHA `be498301c40c55155e6d0678b63943093cda14d1`; main commit timestamp 2026-09-29 10:41:07 UTC, version bump 0.62.3 to 0.62.4. [LICENSE](https://github.com/traceloop/openllmetry/blob/be498301c40c55155e6d0678b63943093cda14d1/LICENSE) is Apache-2.0.

- [Content setting utility](https://github.com/traceloop/openllmetry/blob/be498301c40c55155e6d0678b63943093cda14d1/packages/opentelemetry-instrumentation-openai/opentelemetry/instrumentation/openai/utils.py#L181): content means prompts and responses; default environment value is true, and contextual enable override can also activate collection. This violates Nexus's unconditional content-redaction goal if blindly adopted.
- [Chat wrapper lifecycle](https://github.com/traceloop/openllmetry/blob/be498301c40c55155e6d0678b63943093cda14d1/packages/opentelemetry-instrumentation-openai/opentelemetry/instrumentation/openai/shared/chat_wrappers.py#L107): exceptions mark error and end span, streams retain span until generator consumption. It records raw exceptions/status messages; usage and reasoning details are extracted only when present. Useful lifecycle concept but no SDK adoption or arbitrary exception propagation.
- [Association-based content allowlist](https://github.com/traceloop/openllmetry/blob/be498301c40c55155e6d0678b63943093cda14d1/packages/traceloop-sdk/traceloop/sdk/tracing/content_allow_list.py#L11): contextual association matches permit content capture. Nexus's invariant requires no allowlist that can turn content on.
- Inspected [chat tests](https://github.com/traceloop/openllmetry/blob/be498301c40c55155e6d0678b63943093cda14d1/packages/opentelemetry-instrumentation-openai/tests/traces/test_chat.py#L122) with no-content modes, streaming, context propagation and unconsumed stream cases. Tests often use VCR or mocks; they do not establish live provider acceptance.

Decision: reference lifecycle boundaries and metadata-only context, retain existing Go instrumentation and immutable facts. Risk axes: Python SDK does not fit execution plane; content defaults/context overrides unsafe; exporter can leak provider responses/exceptions; sampled spans cannot become accounting; trace context from a user cannot grant tenant access; added queue/process export must never block inference; Apache notice requirements if code were reused (none planned).

### Helicone

SHA `067d9290acb4f1fc9320e902fc67b4b399b50363`; main commit timestamp 2026-09-16 19:28:17 UTC. [LICENSE](https://github.com/Helicone/helicone/blob/067d9290acb4f1fc9320e902fc67b4b399b50363/LICENSE) is Apache-2.0. The retrieved tip [commit](https://github.com/Helicone/helicone/commit/067d9290acb4f1fc9320e902fc67b4b399b50363) fixes platform admin auth confusion and HQL cross-tenant read paths; read actual fix rather than assume all auth or SQL helpers are safe.

- [Typed request controller](https://github.com/Helicone/helicone/blob/067d9290acb4f1fc9320e902fc67b4b399b50363/valhalla/jawn/src/controllers/public/requestController.ts): uses authenticated request context to create RequestManager for detail/list operations. Nexus delta: use its own permission and historical scopes, no extra logging proxy.
- [Scoped RequestManager](https://github.com/Helicone/helicone/blob/067d9290acb4f1fc9320e902fc67b4b399b50363/valhalla/jawn/src/managers/request/RequestManager.ts#L76): organization is included in cache identity and detail lookup; signed body assets are also org-scoped. Nexus must not add body assets, IO storage, S3 or unscoped caches.
- [Read-only query wrapper defenses](https://github.com/Helicone/helicone/blob/067d9290acb4f1fc9320e902fc67b4b399b50363/valhalla/jawn/src/lib/db/ClickhouseWrapper.ts#L115): user SQL cannot name/override the tenant session setting or inject SETTINGS/backticks; context sets read-only, disallows DDL and bounds rows/time. Its error logging includes query context. Nexus should avoid a query-language endpoint entirely; typed parameterized GET sidesteps this class and fixed errors protect diagnostics.
- [Saved-query organization checks](https://github.com/Helicone/helicone/blob/067d9290acb4f1fc9320e902fc67b4b399b50363/valhalla/jawn/src/managers/HqlQueryManager.ts#L14): organization filtering is part of query retrieval. No saved SQL or dashboard query engine is needed in Nexus.
- Inspected [HQL security test suite](https://github.com/Helicone/helicone/blob/067d9290acb4f1fc9320e902fc67b4b399b50363/valhalla/jawn/src/lib/db/test/hqlSecurityTests.test.ts) and [mocked request controller tests](https://github.com/Helicone/helicone/blob/067d9290acb4f1fc9320e902fc67b4b399b50363/valhalla/jawn/src/controllers/public/__tests__/requestController.test.ts). Security suite covers tenant-setting overrides, multi-statements and current evasion payloads. It uses a mock wrapper and is not proof of Nexus SQL security.

Decision: borrow organization-bound detail retrieval as a design reference and take the recent HQL incident as evidence to keep the API typed. Risk axes: tenant-auth confusion must not be copied; no charge estimation replacement; no proxy key/export credentials; no request/response bodies; no language that can override a tenant context; query bounds/cancellation and no data cache; Apache license if copying (none).

## Integration decision matrix

| Candidate | Decision | Exact Nexus delta | Validation boundary |
|---|---|---|---|
| Langfuse trace UI / scoped detail | Adopt idea through original code | Add detail contract, scoped SQL fact reader, route and accessible request/attempt UI | Native PostgreSQL hidden/foreign/historical fixtures and actual browser interaction; no upstream dispatch during reads |
| OpenLLMetry instrumentation | No dependency; retain lifecycle idea | No new exporter/SDK; use existing request trace ID as correlation | Content sentinel never in response, safe-field allowlist and unknown timing states |
| Helicone logging/HQL | Reject backend/query engine; adopt scope principle | Parameterized request ID only; no raw SQL/body assets | Same 404 for hidden/missing; inject hostile IDs, removed project membership and stale client switching |
| Model capability view | Defer unless another selected feature needs it | Explain catalog vs adapter vs Channel evidence | Must not infer vendor entitlement/available execution from model names; cross-language contract and provider operation fixtures needed |
| MCP-facing observability endpoint | Defer | No MCP server for this round | Requires distinct scoped read-only tool identity, transport/version/auth work and tests first |

At the time these research notes were written, only audit/research was complete and the required baseline gates were running before product changes. Final implementation and acceptance are recorded in [the implementation report](delta-implementation-2026-10-04.md).

# Runtime, resources and Agent observation research

Research date: 2026-10-04 Asia/Shanghai. Read-only audit; no product changes or tests run here. Public GitHub repository metadata, recursive trees and pinned source files were fetched. `.test-artifacts/research/agents.md` is ignored by Git. Repository `pushed_at` and default-branch commit dates are reported separately: pushing another branch can make the former newer. Stars are observations, not quality or production verification.

## Existing Nexus capability map

| Capability | Authoritative implementation | Existing validation and limitation |
|---|---|---|
| Explicit local Codex task enrollment, persistent goal consent, CLI continue/resume/switch/status | `scripts/nexus.ts`; `src/lib/task-runtime/store.ts:createTask`, `requestTaskAction`, `requestContinuation`; `configuration.ts` | `tests/integration/task-runtime.test.ts` uses actual disposable PostgreSQL; route tests actual DB/sessions/CSRF. No HTTP process launch. |
| Capability/model/tool policy gates, fresh official quota, priority selection, current-resource pinning | `src/lib/task-runtime/router.ts:validatePolicy`, `selectResource`, `readResources`; `quota.ts` | `router.test.ts` covers unsupported capabilities, explicit models, untrusted quota, stale/reset windows, restrictive weekly windows, runtime failure recovery. Unit DB doubles. Declaration is not live model discovery. |
| Safe-boundary failover, profile/workspace fencing, same-conversation probe/resume, context handoff, delayed recovery | `src/lib/task-runtime/supervisor.ts`; `boundary.ts`; `src/lib/local-agent/{adapter,codex-adapter,capture}.ts` | `codex-adapter.test.ts` uses an actual fake child-process protocol; `tests/integration/task-supervisor.test.ts` combines actual PostgreSQL, disposable Git workspace and fake runtime transports. `tests/e2e/task-runtime.mjs` mocks API responses. No live independently authenticated multi-account inference proof. |
| Task API and UI: saved policy, resources, task status, sessions, transitions, handoffs, per-resource observed tokens, manual switch/recovery | `src/app/api/task-runtime/{route.ts,_shared.ts,policy/route.ts,[id]/switch/route.ts,[id]/resume/route.ts}`; `src/app/(dashboard)/tasks/page.tsx`; schema tables `resource_routing_policies`, `nexus_tasks`, `task_sessions`, `task_handoff_snapshots`, `task_resource_transitions` in `src/db/schema.ts` | Actual route/DB tests in `tests/integration/task-runtime-routes.test.ts`; mocked browser tests in `tests/e2e/task-runtime.mjs`. No web continuation endpoint/action, and `readTasks` does not return checkpoint facts. |
| Unified connection/API resource inventory, restrictive quota-window freshness, separate health/configuration, subscription pools measured in accounts | `src/lib/resources/{catalog,pool}.ts`; `src/app/api/resources/route.ts`; resources page; `src/components/workspace/SubscriptionPools.tsx` | Catalog/pool unit tests. Local connector readiness uses authoritative `connectorStates`; collector reports never grant scheduling capacity. |
| Background Observer, cursor/lock import, workspace attribution, metadata-only token evidence and unknown preservation | `services/observer/index.ts`; `src/lib/observer/{service,importer,configuration,workspace}.ts`; `src/lib/task-runtime/observe.ts` | Actual DB integration fixtures: `agent-observer`, `claude-observer`, `subscription-observer`; unit parser/stream/sources tests. Samples and real filesystem replays do not prove every vendor's live current client. |
| 42 Agent identities: 11 native, 3 exports, 5 hooks, 7 bridges, 16 unadapted | `src/lib/observer/{agent-tools,agent-sources,agent-reader}.ts`; `adapters/*`; `src/app/api/local/agent-observer/route.ts`; `src/components/workspace/AgentObserverPanel.tsx` | Hook/native adapters and canonical ID/semantics fixtures; actual PostgreSQL import/de-dup/enrichment checks. Registry presence does not mean support. Hermes remains unadapted; OpenCode is explicit export only. |
| Native Codex account synchronization, exact account/organization-bound official quota batches | `src/lib/subscriptions/codex/{client,mapper,sync,read,refresh}.ts` | Unit fake protocol and DB integration/route tests. Client methods currently account/read, rateLimits/read, usage/read; no model/list. |
| CodexBar dashboard-v1 monitoring, exact provider/account binding, server refresh and JSON import | `src/lib/subscriptions/{collector,collector-fetch,collector-providers}.ts`; connection subscription-monitor routes/panel | Unit parser/fetch tests; actual DB membership/locks with mocked collector in `tests/integration/subscription-monitor.test.ts`. Manual refresh; organization monitoring only; no quota_snapshots, wallet, ledger or routing authority. |
| TLS outbound local connector, model authorization, health preflight, bounded concurrency/timeouts, no replay | `docs/operations/local-connector.md`; `src/lib/connectors/control.ts`; Gateway connector package/CLI | Existing actual Go HTTP/TLS and PostgreSQL fixture checks described in docs; real project-key inference remains an operator/environment check. Do not reclassify it as missing functionality. |

Reviewed operating docs: task-resource-handoff, local-connector, agent-observer, agent-tool-coverage, subscription-monitor, open-source-research under `docs/operations`.

## Dynamic discovery and metadata

GitHub search API queries, sort=updated, order=desc, per_page=10:

- `coding agent usage telemetry pushed:>=2026-09-01 stars:>50`: 1 result.
- `ai agent session resume pushed:>=2026-09-01 stars:>50`: 6 results.
- `llm playground observability pushed:>=2026-09-01 stars:>50`: 2 results.

All repositories below were unarchived when read. Popular upstreams were then checked explicitly to avoid letting tiny newly discovered projects dominate selection. All metadata-only entries are feasibility leads, not source-confirmed feature claims.

| Repository | Stars | License metadata | Pushed UTC | Default-branch SHA | Disposition |
|---|---:|---|---|---|---|
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 250952 | MIT | 2026-10-03 18:59:41 | `343500b3547e12530457c2fda60ec687e25118b4` | Deep source: defer normalized token import; possible future activity-only hooks |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | 211615 | MIT | 2026-10-03 19:09:40 | `907b3bc518fa48e90e8ec24dd327d13eee71c36c` (dev) | Deep source: adapt pure event/UI separation principles; defer new runtime |
| [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | 107226 | Apache-2.0 | 2026-10-03 01:29:14 | `fb972b2f87fe7d5b06d37eac711490162d98de2c` | Metadata scan: existing native observation; adding runtime broadens authorization/continuity scope |
| [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | 28286 | Apache-2.0 | 2026-10-03 19:02:30 | `2c591ecc08a6fa080342f9b1b9f7f43215178cbb` | Metadata scan: existing native observation; no reason to duplicate parser |
| [langgenius/dify](https://github.com/langgenius/dify) | 157774 | NOASSERTION | 2026-10-03 15:55:10 | `1cbb6dc385878c950e2252f17f1954211fd1e763` | Metadata scan: broad workflow platform; license/architecture review needed, defer |
| [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | 89892 | MIT | 2026-10-03 14:30:52 | `a6bba78ffd5a8b31620770f52383b1a2c0477fcd` | Metadata scan: remote/runtime platform, defer sandbox/identity expansion |
| [alibaba/loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot) | 198 | Apache-2.0 | 2026-09-29 09:03:55 | `abd8388222c8f76a3429c78368554898cd615859` | Deep source new discovery: metadata capture controls/reference tests, no dependency |
| [jazzyalex/agent-sessions](https://github.com/jazzyalex/agent-sessions) | 889 | MIT | 2026-10-02 22:14:50 | `b7893c772b0014918211f1c45a5ab58add229703` | Deep source new discovery: defer transcript/SQLite and terminal launch authority |
| [rexleimo/aios](https://github.com/rexleimo/aios) | 54 | MIT | 2026-10-01 17:14:47 | `47f8a2223ed077f4e5dd306418eeea4c57afcf23` | Metadata scan: cross-session memory overlaps existing bounded handoff; defer external memory store |
| [Kc1t/alethe-agents](https://github.com/Kc1t/alethe-agents) | 800 | AGPL-3.0 | 2026-10-03 11:40:44 | `915ae20e282a76de6fdbf78718b93c30a8417c1f` | Metadata scan: desktop PTY ownership and license broader than this slice |
| [coding-by-feng/ai-agent-session-center](https://github.com/coding-by-feng/ai-agent-session-center) | 82 | MIT | 2026-10-01 00:02:11 | `86c9e9391ae3b2ed71cb953a06f8d43040703b64` | Metadata scan: dashboards already overlap tasks; defer extra terminals/live control |
| [UNLINEARITY/CLI-WeChat-Bridge](https://github.com/UNLINEARITY/CLI-WeChat-Bridge) | 523 | AGPL-3.0 | 2026-09-29 08:24:33 | `2c256c1bfaf7f4c507bb25d4ff81d325ae911975` | Metadata scan: messaging/outbound side effects and shared terminals outside current goal |
| [Dicklesworthstone/cross_agent_session_resumer](https://github.com/Dicklesworthstone/cross_agent_session_resumer) | 122 | NOASSERTION | 2026-09-22 17:21:15 | `3b934034d49b612229d6247f176ce7013c5daf6c` | Metadata scan: cross-provider transcript migration conflicts with explicit same-tool continuity boundary |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | 35340 | NOASSERTION | 2026-10-03 13:05:48 | `f75c661dbe8c6b85523c81486b39e8403ac2c141` | Metadata/tree scan only here; separate gateway research owns source/EE license review |
| [Helicone/helicone](https://github.com/Helicone/helicone) | 6199 | Apache-2.0 | 2026-09-16 19:29:27 | `067d9290acb4f1fc9320e902fc67b4b399b50363` | Metadata scan only here; separate gateway research owns source review |

Branch commit dates for the four deep reviews: Hermes 2026-10-03 18:40:54Z, OpenCode 2026-10-03 04:55:40Z, Pilot 2026-09-29 09:03:54Z, Agent Sessions 2026-10-02 22:14:44Z. All source links below pin these SHAs. Main/dev can evolve.

## Deep source findings and risk decisions

### Hermes Agent: normalized Hook values cannot preserve missing-counter evidence

Source inspected: [agent/api_request_hooks.py](https://github.com/NousResearch/hermes-agent/blob/343500b3547e12530457c2fda60ec687e25118b4/agent/api_request_hooks.py#L35), [agent/usage_pricing.py](https://github.com/NousResearch/hermes-agent/blob/343500b3547e12530457c2fda60ec687e25118b4/agent/usage_pricing.py#L358), [model_selection_guards.py](https://github.com/NousResearch/hermes-agent/blob/343500b3547e12530457c2fda60ec687e25118b4/hermes_cli/model_selection_guards.py#L37), [session_persistence.py](https://github.com/NousResearch/hermes-agent/blob/343500b3547e12530457c2fda60ec687e25118b4/agent/session_persistence.py), [tests/hermes_cli/test_model_selection_guards.py](https://github.com/NousResearch/hermes-agent/blob/343500b3547e12530457c2fda60ec687e25118b4/tests/hermes_cli/test_model_selection_guards.py#L12). MIT LICENSE read.

`_usage_summary_for_api_request_hook` removes `raw_usage` after normalization. `_usage_field` maps absent/invalid counters to zero; CanonicalUsage defaults zero. Stable request/session/timing fields are suitable future activity evidence, but the normalized hook cannot establish original counter presence. `selection_context_for_agent` stays silent without measured live context. Guard registry tests include exceptional guard handling. Persisted transcript/retry behavior belongs to Hermes, not Nexus.

Ownership/SoT: Hermes owns live execution; Nexus can own an explicit sanitized observation projection only. No hook can authorize capacity or wallet entries. Decision: defer a native token adapter; an activity-only adapter is a future narrow slice, requiring actual official post_api_request payload/version acceptance tests.

| Risk | Nexus treatment |
|---|---|
| Security | Allowlist exact metadata; never import raw response/request or inferred transcript identifiers. |
| Credential | No OAuth/config reads, upstream URL or payload credentials; plugin installation explicit. |
| Tenant isolation | Existing configured Observer scope/workspace matching remains mandatory. |
| Accounting | Missing values cannot become reliable zero; normalized hook alone is insufficient. Local observations never bill. |
| Concurrency | Observer lock/cursor only; never adopt Hermes dispatcher retries or terminal control. |
| Migration | No provider history rewrite or cross-tool reasoning transfer; version-pinned payload contract needed. |
| License | MIT checked; original implementation, no upstream code copied. |

### OpenCode: model discovery and pure UI event reduction

Source inspected: [models.ts](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/cli/cmd/models.ts#L8), [session-data.ts](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/cli/cmd/run/session-data.ts#L646), [session-data.test.ts](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/test/cli/run/session-data.test.ts#L113), provider/provider.ts, session/schema.ts and HTTP session handler. MIT LICENSE read.

ModelsCommand reads configured Provider.list and supports explicit cache refresh/filter; it is discovery, not a proof that a selected model can execute. `reduceSessionData` separates UI commits from external effects, filters events to session ID, queues permission/question state and de-duplicates commits. Tests cover delayed role identification, suppressed user/reasoning text, blockers and interruption. Its display aggregation defaults missing token dimensions to zero: do not transfer that accounting rule.

Nexus delta: eventual profile model discovery can replace declared-only model metadata; Playground should keep rendering effects separate from the one authorized Gateway call. Decision: adapt design principles in original code; defer OpenCode runtime, current native export already exists.

| Risk | Nexus treatment |
|---|---|
| Security | Fixed Gateway transport; no arbitrary provider browser URL/tool execution. |
| Credential | Only existing project key supplied in-memory; no provider login/config import. |
| Tenant isolation | Existing session/project authorization and Gateway key ownership decide access. |
| Accounting | Gateway remains sole usage/settlement authority; absent counters stay unknown. |
| Concurrency | Single request UI/controller, explicit cancellation; no automatic retry. |
| Migration | No schema/runtime migration needed for rendering principle; new model discovery needs pinned protocol review. |
| License | MIT read; no code copied or dependency added. |

### LoongSuite Pilot: explicit capture controls and real-derived fixtures

Source inspected: [Hermes plugin](https://github.com/alibaba/loongsuite-pilot/blob/abd8388222c8f76a3429c78368554898cd615859/assets/plugins/hermes-agent/loongsuite-pilot/__init__.py#L640), [HermesLogInput](https://github.com/alibaba/loongsuite-pilot/blob/abd8388222c8f76a3429c78368554898cd615859/src/inputs/hermes-log/hermes-log-input.ts#L25), [plugin tests](https://github.com/alibaba/loongsuite-pilot/blob/abd8388222c8f76a3429c78368554898cd615859/tests/unit/hooks/hermes-agent-plugin.test.mjs#L615), [integration flow](https://github.com/alibaba/loongsuite-pilot/blob/abd8388222c8f76a3429c78368554898cd615859/tests/integration/hermes-agent-event-log-flow.test.ts#L39), [fixture provenance](https://github.com/alibaba/loongsuite-pilot/blob/abd8388222c8f76a3429c78368554898cd615859/tests/fixtures/hermes-agent/README.md). Apache-2.0 LICENSE read.

Plugin `_usage_fields` prefers prompt total and adds cache as dimensions; correlation uses official api_request_id when available and a generated fallback otherwise. Capture-off tests remove tool definitions, system text and error content. Input reads explicit plugin JSONL. The integration fixture originates from sanitized Hermes 0.9 callbacks, augmented with later request shape; it is not a live 0.19 validation. Nexus must reject identifier fallbacks and normalized missing-zero semantics that do not satisfy its event contract.

Nexus delta: useful evidence for metadata-only Hermes future hook, plus honest fixture labels. Decision: reference testing/capture separation; do not install Pilot, exporters, deployment injection or adopt telemetry as financial evidence.

| Risk | Nexus treatment |
|---|---|
| Security | Fixed metadata allowlist, no content or arbitrary exporter access. |
| Credential | No provider/collector credential import; no auto-hook/config edits. |
| Tenant isolation | Existing explicit tenant/organization and workspace mapping only. |
| Accounting | Tool-reported evidence never enters ledger; missing IDs/counters fail closed. |
| Concurrency | Existing cross-process Observer lock/cursor and bounded files; no new daemon. |
| Migration | Explicit known version/shape, no silent auto-detect migration or third-party event history rewrite. |
| License | Apache-2.0 read; reference only, original code and no copied implementation. |

### Agent Sessions: read-only SQLite does not meet Nexus content boundary

Source inspected: [HermesSessionParser.swift](https://github.com/jazzyalex/agent-sessions/blob/b7893c772b0014918211f1c45a5ab58add229703/AgentSessions/Services/HermesSessionParser.swift#L439), [OpenCodeSqliteReader.swift](https://github.com/jazzyalex/agent-sessions/blob/b7893c772b0014918211f1c45a5ab58add229703/AgentSessions/OpenCode/OpenCodeSqliteReader.swift), [HermesResumeCommandBuilder.swift](https://github.com/jazzyalex/agent-sessions/blob/b7893c772b0014918211f1c45a5ab58add229703/AgentSessions/HermesResume/HermesResumeCommandBuilder.swift#L18). MIT LICENSE read. Test tree includes resume command/coordinator tests for several tools, but Hermes parser tests were not inspected here.

`listSessionsIfReadable` distinguishes query failure from an empty table and opens SQLite read-only. `loadFullSession` loads content, reasoning and raw JSON. Resume command builder quotes explicit ID/workspace and launches native CLI. These are legitimate local product choices but do not provide Nexus tenant attribution, metadata-only collection or supervised lease authority. Decision: defer SQLite/transcript adapters and new resume launchers; adopt only explicit unavailable-vs-empty state distinction in future diagnostic design.

| Risk | Nexus treatment |
|---|---|
| Security | Full transcripts/reasoning exceed current allowlist; no import. |
| Credential | Do not adopt OAuth/status collectors or local credential discovery. |
| Tenant isolation | Single-user desktop sources cannot substitute Nexus tenant/organization scope. |
| Accounting | Session aggregate fields cannot identify independent reported calls; no inferred usage. |
| Concurrency | Terminal launcher would bypass existing workspace/Profile/runtime leases. |
| Migration | Private SQLite schemas and upstream changes require reviewed adapters; no native-history rewriting. |
| License | MIT read; reference only, no copied code. |

## True independent Nexus gaps

1. Web task continuation: store and CLI support explicit continuation, but no continuation API/UI. A scoped POST + completed/paused/failed task dialog can reuse command sequencing without launching a process in HTTP.
2. Task checkpoint review: stored bounded progress/decisions/failures and workspace snapshots are omitted from API/UI. A scoped read model can help the user recover uncertain execution; it must label incompleteness and never expose PID/raw history/secret paths.
3. Profile model discovery: live account/quota exists but model allowlists are declarations. Add only a reviewed read-only local model/list projection; discovered identity/capability is not execution permission or quota.
4. Per-tool capture completeness: Observer status lists sessions/events/time only. Existing analytics already counts unknown dimensions, so a status completeness view must reuse explicit null evidence rather than invent a second token total.

For this development cycle, root's actual project-authorized Playground and stored request/attempt trace explorer are stronger complete user-facing slices. Runtime registry additions alone are not comparable value, and the Hermes missing-vs-zero evidence blocks safe native token claims. No requested architectural invariant needs to change: project/session/key authorization, Vault credential authority, Gateway request execution, budget/ledger settlement, no replay and separate external observations all remain existing owners.

## Deep-review ownership and migration boundaries

The language of the ten reviewed repositories is Go (AxonHub, GPT-Load), Rust (Plano), TypeScript (Langfuse, Helicone, OpenCode, LoongSuite Pilot), Python (OpenLLMetry, Hermes) and Swift (Agent Sessions). Exact revisions, dated activity, source paths, tests and license files are recorded in their entries above. All selected behavior is implemented independently in Nexus; no upstream code is copied.

| Deep review | Authoritative owner in Nexus | Estimated modification range | Migration decision |
| --- | --- | --- | --- |
| AxonHub | Control Plane session/project authorization; Gateway execution; Worker accounting | New bounded contract/API/service/UI/tests/docs for Playground and request detail | Additive; no schema or historical rewrite |
| Plano | Gateway signed routing policy and runtime health; Local Agent conversation continuity | Snapshot/contracts/router and measured quality/cache evidence | Defer; versioned policy and provenance rollout would be required |
| GPT-Load | Gateway API scheduling; Local Agent Profile lease and official quota | Durable scheduling state, policy/compiler and runtime tests | Defer; in-memory fairness is not a durable migration strategy |
| Langfuse | Gateway Request/Attempt facts; Worker frozen usage and settlement evidence | Read-only SQL projection, typed contract, API and console detail | Additive; no event-store ingestion, backfill, body persistence or new infrastructure |
| OpenLLMetry | Existing Gateway OpenTelemetry owner; persisted facts remain independent | Future explicitly bounded native spans and redaction tests | Research only; no SDK/default content capture or telemetry schema migration |
| Helicone | Typed Control Plane read authorization; existing Gateway/Worker facts | Read-only request-detail projection and whitelist rendering | Adapt metadata UX only; no HQL, body assets, collectors or alternate usage store |
| Hermes | Local Agent process/profile/task owner; hooks observation only | Agent catalog, authenticated hook schema/parser and unknown-usage tests | Defer; a genuine adapter needs its own versioned intake/identity rollout |
| OpenCode | Local Agent runtime authorization; capability observations | Future official discovery adapter plus runtime-mode evidence | Defer; model names/catalog entries cannot enable execution modes |
| LoongSuite Pilot | Local Agent auth and process; Reader evidence collector | Future redacted deterministic session/usage intake | Research only; checkpoint/hook observation cannot become task authority |
| Agent Sessions | Local Agent task/conversation identity and profile lease | Future authorized resume UI/service and sandbox tests | Research only; no copied macOS storage paths or writable third-party sessions |

For the observability adaptations, the seven risk boundaries are explicit: **security** uses whitelist-only metadata rather than query-language or payload ingestion; **credentials** never enter persisted traces or browser storage; **tenant isolation** is the existing analytics/request-read boundary and exact project Key; **accounting** uses frozen Worker facts and preserves unknown values; **concurrency** reads a consistent transaction and introduces no replay; **migration** is additive with no schema/backfill and no historical rewrite; **license** follows the inspected mixed MIT/enterprise boundary for Langfuse and Apache files for OpenLLMetry/Helicone, without copying source or installing dependencies. These decisions also reject default prompt capture, raw upstream errors, cross-tenant HQL and competing accounting authority.

## Selected decisions

- **Adapt:** [recorded request detail ADR](../adr/2026-10-04-recorded-request-traces.md), a content-free projection of existing immutable Request/Attempt/Worker facts.
- **Adapt:** [project Playground ADR](../adr/2026-10-04-project-playground.md), explicit buffered calls through the current Go Gateway with session authorization and an exact project API Key.
- **Research only / defer:** durable account fairness, model capability policy, extra Agent adapters and MCP governance until their authoritative ownership, provenance and migration contracts are complete.
- **Reject:** uncertain inference replay, subscription/API credential interchange, body capture by default, unrestricted query languages, unofficial pricing as billing evidence and hooks/checkpoints as execution authority.
