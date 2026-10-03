# Unified resource control plane: current convergence

The product is project-centric. An API request goes through the Go Gateway; an official coding subscription remains in the local tool's credential boundary. A resource switch should preserve the Nexus Task and tool Conversation whenever the tool can resume the exact conversation. Observed subscription tokens are analytics, not wallet charges.

## Existing facts and ownership

| Product concept | Current authoritative source | Constraint |
|---|---|---|
| Connection | `owned_connections` | Ownership, provider/mode, project link and local observer identity. Not a second gateway channel. |
| API ExecutionResource | `channels` + versioned gateway snapshot | A channel is the actual upstream API route. Local channels link to one Connection through `metadata.connection_id`. A configured channel is not proof of publication. |
| Subscription ExecutionResource and ResourceAccount | `owned_connections` + isolated local profile | One Connection currently represents one local subscription account. Do not copy OAuth files to the server. |
| API ResourceAccount | `provider_credentials` reference | An account may be shared by channels; the resource view exposes only an opaque ID. |
| Quota | `quota_snapshots` | Only fresh official account/connection observations can assert capacity. Near-limit prepares; exhaustion can trigger a safe switch. |
| Project / Task / Conversation | `projects`, `nexus_tasks`, `task_sessions`, `task_resource_transitions` | Resource history can change within one conversation; external observed usage remains time-attributed. |
| Gateway routing | Signed snapshots and Go Router | Hard policy and protocol compatibility stay in the data plane. The task router manages local tool profiles. Neither retries official subscription authorization through HTTP. |
| Settlement | Worker + immutable ledger | Unknown provider price/usage is not free. Local observed subscription usage never creates wallet charges. |

`GET /api/resources` and `/resources` are read-only projections over these facts. They do not create `execution_resources` or `resource_accounts` tables, since doing so before migration would duplicate live identities. The view distinguishes `resourceType`, `executionMode`, quota and health, account reference, channel, project and routing configuration. A local API channel linked to a Connection is shown once; an unlinked direct-provider Connection remains visible as pending. Any unattested capability, model, priority, health or quota remains unknown. Recent runtime failures are separate from official quota observations. The `/routing` page combines existing project task-policy previews with visible API channel configuration, but does not claim that a configured channel is published or that the UI preview is an actual dispatch decision.

When the selected project changes, `/routing` clears the previous project's policy and shows loading until the new result arrives. A failure cannot leave the old policy labeled as the new project's result. Refreshing the same query can retain its last successful data and timestamp alongside an error; disabling a query clears them.

After installing repository dependencies and Playwright Chromium, run `node tests/e2e/api-data-scope.mjs` to check this browser behavior. The test imports the actual React hook, providers and routing page against loopback HTTP fixtures; it requires no database and does not test server authorization or model execution.

The legacy `POST /api/projects/:id/policy-preview` requires the existing project read capability and access to both the selected project and connection. Ordinary members need project membership or ownership of an unbound connection; owner/admin/billing retain their current organization management visibility. Archived projects are refused. A visible revoked connection returns its existing denied advisory decision. Hidden objects return 404 without connection facts or successful preview audit. The result checks only the existing reported operations and revocation state; actual model availability, Channel publication, API key permissions and Gateway dispatch remain separate authorities.

Connection and resource lists read local connector state in sequential batches of at most 32 requested scopes. The shared scalar/batch helper applies the existing visibility, lease, project/organization and Channel approval rules, then maps rows back to their input positions. Connection-level readiness keeps the approval union; each Channel resource retains its own scope, including repeated connection IDs. Expiry is observed after each read and no state persists across requests. Real PostgreSQL checks reduce 32-connection list round trips from 35/37 to 4/6 while retaining resource identities and facts. The Gateway still performs its own live call authorization.

## Reference review, 2026-09-24

- [New API channel model](https://github.com/QuantumNous/new-api/blob/main/model/channel.go) and [channel administration](https://github.com/QuantumNous/new-api-docs-v1/blob/main/content/docs/en/guide/feature-guide/admin/channel.mdx): priority, weight, model mapping, per-channel health and keys are useful gateway-plane patterns. Nexus already has channels, versioned model aliases, signed snapshots, health scoring and isolated billing; they remain authoritative.
- [Sub2API gateway scheduling](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/gateway_scheduling.go) and [OpenAI account scheduler](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/openai_account_scheduler.go): sticky sessions, exclusions, cooldown and load awareness belong at the account selection boundary. Nexus pins a healthy task connection, excludes failed connections within a transition and separates quota from breaker state. The existing Supervisor now holds one advisory lease per local Profile and checks open task/current-resource bindings after lease loss; this enforces a conservative one-runtime-per-Profile limit. General per-account concurrency values, rate-limit cooldown and multi-account scheduling under one Resource still need durable facts and a single owner; they must not be simulated from a UI projection.
- [CC Switch provider router](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/provider_router.rs), [failover switch](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/failover_switch.rs), [config service](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/config.rs) and [Codex configuration](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/codex_config.rs): local proxy and reversible config takeover are local-agent responsibilities. Nexus currently supervises an opt-in Codex profile without taking over original user config. Other tool adapters and reversible config takeover remain outside this implementation.

The sources are design references, not runtime dependencies. No source-project domain names enter Nexus's resource model.

## Next architecture steps

1. Extend the current one-runtime-per-local-Profile lease into a durable account scheduling state only after defining one writer per plane: Gateway for API request load/cooldown and Local Agent for subscription profile observations. Keep quota, health, rate limit and concurrency distinct. Do not grant capacity from elapsed cooldown alone without fresh evidence.
2. Migrate the existing `resource_routing_policies` local-task policy and signed gateway policy into a shared policy definition with plane-specific compiled outputs. Retain both dispatch implementations because execution and credential boundaries differ; remove redundant policy authoring paths after migration.
3. Add account/profile enrollment for additional tools behind the existing `ToolAdapter` contract, preserving configuration backup/restore and exact-conversation checks before enabling automatic switching.
4. Join resource view to project analytics and signed snapshot publication status using historical IDs and provenance; do not infer a project from current membership or substitute zero for unknown usage.

This document describes current code and unimplemented convergence work. It is not a production acceptance claim.
