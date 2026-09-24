# Conversation-aware resource failover

Nexus now supervises explicitly enrolled coding goals through the existing local Observer. The `/tasks` console provides project policies, resource state, execution history, manual switching and recovery. Only tasks launched through Nexus are supervised; bare Codex remains unchanged.

## Set up

1. Apply the additive migrations with the canonical runner: `node --env-file=.env.local scripts/db-migrate.mjs`. Existing subscriptions, usage and ledger data are retained. Re-run workload-role provisioning after schema expansion if using restricted database roles.
2. Create separate Codex subscription connections in the console, bound to the target Project. Create dedicated profile directories **outside the workspace and outside the default/inherited CODEX_HOME**. For each profile, set `CODEX_HOME` in a separate terminal and run the official `codex login`. Nexus does not copy authentication files or accept tokens through the browser. Initialize any compatible provider configuration through Codex itself.
3. Copy `config/nexus-supervisor.example.json` to ignored `config/nexus-supervisor.json`. Replace tenant, organization, project, connection IDs, workspace and profile homes with your actual local values. Each connection/profile/home must be unique. Directories must already exist. Do not put credentials in this file.
4. Set `NEXUS_SUPERVISOR_CONFIG` to the absolute config path in the terminal environment, then start the existing `npm run dev` / `npm run observer:dev` process with the same database environment. The supervisor is disabled when this variable is absent. Configuration changes require restarting that local process.
5. Open `/tasks`, select the project and create a routing policy. Add each connection with the matching `profileRef`, capability/tool/model allowlists, priority and fallback preparation threshold. A declared model restriction requires selecting an explicit model. Availability requires compatible capabilities **and fresh official quota**; unknown never grants permission. The local agent checks each enrolled profile using official read-only account calls before initial selection and activates a pending connection only after a verified observation.

From the registered workspace:

```sh
npm run nexus -- codex --project PROJECT_ID --goal "Complete the current coding task" --persist-context
npm run nexus -- status --project PROJECT_ID
npm run nexus -- switch --project PROJECT_ID --task TASK_ID --target CONNECTION_ID
npm run nexus -- resume --project PROJECT_ID --task TASK_ID
npm run nexus -- continue --project PROJECT_ID --task TASK_ID --instruction "Now finish the remaining acceptance checks"
```

When the workspace is another repository, use the absolute path to this checkout's `scripts/nexus.ts` with Node/tsx and explicitly supply this checkout's database/environment configuration; the current working directory remains the coding workspace. The `--project` flag can be omitted when the current workspace resolves uniquely in local configuration. `--persist-context` consents to storing this task's goal/instructions and bounded continuation state in the tenant database. It does not enable global conversation logging. CLI outputs IDs/status, never the goal or runtime diagnostics.

## Behavior

The first turn starts a Codex conversation. Successful terminal completion completes the Nexus task. A manual switch arriving during a running turn waits for a safe boundary. A provider-confirmed exhaustion or supported unavailability event switches at the failed-turn boundary. A current resource at 80%, 90%, 99% or `near_limit` continues to serve turns; `near_limit` only refreshes fallback observations. Automatic return to a higher-priority resource is disabled while the current resource remains healthy, even if an older policy has `autoReturn` set.

For each transition the local agent tries, in order: an in-place switch if the adapter supports it, restart and resume the **same conversation ID**, then same-tool migration if supported. Codex currently reports in-place and migration unsupported; its isolated target profile is probed with `thread/resume` without starting a turn. Only a matching thread ID authorizes continuation; an unknown probe result pauses the task. A verified missing rollout permits bounded context handoff to a new conversation. Profiles with separately stored history may therefore require handoff. Nexus does not copy `auth.json`, rewrite Codex session metadata or promise that provider-private encrypted reasoning survives a backend change.

Captured Git branch/status, modified-file metadata, diff statistics and harness references accompany the original goal and structured task progress. On continuation, the agent is instructed to verify repository reality and continue unfinished work without replaying successful or uncertain external actions. The first failed request is not replayed across resources.

Fresh structured resource failures are persisted as connection runtime observations. A still-eligible current resource is preferred on explicit continuation/resume. An empty compatible pool pauses and shows the next known reset, keeping the conversation ID. The local supervisor rechecks such paused tasks after 30 seconds and continues when a fresh provider observation proves a compatible resource is available. Interrupted or uncertain tasks still require explicit review; there is no automatic infinite retry.

The local process owns workspace advisory leases, Profile advisory leases and durable session bindings. Different workspaces cannot launch the same local account Profile concurrently; a busy preferred Profile is excluded for that selection and the next compatible candidate is tried. The lock uses the canonical Profile home and is held across the live runtime. A task's current resource and open session also fence another task after a database lease is lost, including after a same-conversation resource switch. Supervisor interruption pauses uncertain tasks for explicit recovery. A recorded live previous runtime PID prevents new execution in that workspace. Protocol uncertainty retains the running state and lease; it does not kill a tool call or start another agent. Stop the old runtime through its normal tool controls before recovery. A blocked or approval-requiring task surfaces in the UI. Initial version denies unsupported interactive approvals and requests user review; it does not silently approve external actions. Normal local file changes use Codex's workspace-write sandbox with network disabled.

Profile telemetry is imported by the existing Observer parser/cursor/lock. Transition history records source/target resource, conversation IDs, switch type (`in_place`, `runtime_restart`, `context_handoff`) and reason. Observer attributes each event to the resource active at that event's timestamp, even when one conversation spans two resources. The task screen aggregates existing observations per resource; unknown token dimensions remain unknown. No subscription observation creates wallet charges, ledger entries or HTTP gateway usage. The Go gateway moves a confirmed exhausted API channel out of selection for **subsequent requests**; it does not replay a request that already reached an upstream. Compatible API/Coding Plan profiles still require supported local configuration and independent authoritative quota data; this version does not fabricate remaining API capacity from an active connection or API key.

## Operational boundaries

- One existing Observer process, at most two concurrent registered workspaces per supervisor. No background daemon is started by the CLI.
- Original goals and task-specific context persist by explicit launch consent. Full conversation history, source contents, full diffs and auth configuration are not copied into snapshots. Sensitive file paths are omitted from capture.
- Real multi-account inference requires independently authenticated profiles and has to be verified in that environment. Automated acceptance uses fake runtime transports and a disposable database; it does not prove provider billing or account entitlement behavior.
- The local agent currently launches Codex profiles and does not modify a user's live `config.toml` or Claude `settings.json`. Consequently it has no live config to restore. Local Proxy Takeover and Claude/other tool adapters remain future work; no official OAuth credential is routed through the HTTP gateway.
- Shutdown drains active turns. If a tool never reaches a safe boundary, manual tool cancellation may be needed. Database failure never authorizes another execution.
- Roll back behavior by removing `NEXUS_SUPERVISOR_CONFIG` and restarting the Observer after safe drain. Keep additive task/history tables and existing data. No destructive down migration is required.
