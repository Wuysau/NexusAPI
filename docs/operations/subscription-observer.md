# Subscription Observer

Observer imports **client-observed activity** from local Codex rollout files into existing Project Analytics. It does not proxy subscription requests or manage subscription credentials. Observed tokens are not an official bill, quota percentage or Coding Plan consumption unit. Gateway accounting remains independent.

Supported parser: `codex-rollout-v1`, verified against metadata shapes from Codex CLI 0.149.1 and 0.154.0. Session metadata supplies session ID, cwd and provider identifier; turn context supplies model/turn; `event_msg/token_count` supplies cumulative and last usage. The alternate `token_usage_record` is deliberately ignored. Events are observations, not a promise of exact HTTP request counts. Cached input and reasoning are subsets of input/output. Total is copied from telemetry, not recomputed by adding subsets. Missing dimensions remain null.

## Privacy

**Official Quota in connection details** refreshes automatically on open and return to the foreground. Following [upstream Codex](https://github.com/openai/codex/blob/5c5308fc9a9ee789049d646ef11e5400384b9c6f/codex-rs/tui/src/chatwidget/rate_limits.rs), visible-panel polling waits60/30/15/5 seconds after completion at ordinary Codex usage thresholds0/75/90/99%. Unknown usage uses60s; this panel has no selected inference model. Automatic POST uses `?refresh=quota`: account identity plus official rateLimits/read, without reloading account usage history. The explicit refresh button still updates all three account sections. Local administrator, CSRF, Origin/Host and current connection/identity checks apply. Hidden/closed panels pause; failed reads retain prior snapshots. The UI displays current cadence and second-resolution observation time. This is independent of the60-second local session Observer. Upstream rolling notifications originate from turns and are delivered to subscribed thread clients; this account-only connector does not subscribe to conversations or claim desktop push delivery.

The parser reads JSONL one line at a time, extracts an allowlist and discards the rest. It never reads `auth.json`, browser cookies or secrets configuration. It does not copy source files, raw JSONL, prompts, assistant messages, tool arguments/results, environment values or credentials into NexusAPI. Only IDs, cwd, provider/product/model, timestamps, nullable counts and parser version are stored. Cursor JSON contains only the same metadata context and a cumulative-counter fingerprint. Lines larger than 8 MiB are safely skipped with a counted warning; incomplete final lines remain pending. No raw diagnostics are printed on failure.

The CLI is an **operator tool**, using an explicitly configured database connection and tenant/organization scope. Keep its database credentials outside the nonsecret mapping file. It is not an unauthenticated HTTP ingestion endpoint. Existing authenticated Analytics permissions still govern viewing. Protect local workspace paths as tenant-private metadata.

## Configure

### Everyday automatic synchronization

Apply additive migration 0018 with the canonical migration runner before using background synchronization. Existing observations and file cursors are retained.

1. Start `npm run dev` (infrastructure + migrations + Web + Observer), or `npm run dev:local -- --port 3000` on Windows with infrastructure and migrations already prepared.
2. Configure workspace directories in Projects, then open the active Codex connection's details.
3. Confirm the local sessions path and click **应用 Observer 配置**. The default path is your local user's `.codex/sessions`; the configuration is saved atomically to the server-owned location.
4. Use Codex normally. Open or refresh Project Analytics for the latest stored observations. **立即同步** queues an immediate background run; it never invokes a shell or a scan inside HTTP.

```dotenv
CODEX_OBSERVER_ENABLED=true
CODEX_OBSERVER_INTERVAL_SECONDS=60
# Relative paths resolve from the NexusAPI working directory.
CODEX_OBSERVER_CONFIG_PATH=config/nexus-observer.json
```

The interval must be an integer from 1 to 86400 seconds. Config file changes are detected by the worker without restarting Web; workspace roots are read from the database during import. Environment changes require a service restart. Download remains available for backup/debug/other machines. Applying a connection replaces the same provider identifier's active mapping and retains other explicitly configured identifiers. Existing historical attribution/connection IDs never move. UI apply does not run `configure` or overwrite database roots.

Both bundled processes inherit the **same DATABASE_URL**. The bundled Observer deliberately does not load `.env.observer.local` independently. The standalone diagnostic CLI retains its previous `.env.observer.local` override; that does not change the app or bundled worker configuration.

States are `running`, `syncing`, `idle`, `not_configured`, `source_unavailable`, `error`, `stopped`, independent of Codex account status. The generic `observer_runtime` row stores heartbeat, sync start/completion/success timestamps, safe error code, next run, summary counts and queued request. A heartbeat older than 20 seconds is displayed as stopped; graceful exit marks stopped. The panel polls state every three seconds while open and refreshes observed connection data after completion. Analytics itself never triggers collection.

Automatic scans default on. `CODEX_OBSERVER_ENABLED=false` leaves the service available for manual requests with auto sync off. Missing configuration or sources never stop Web. Fixed error categories are shown; incomplete tails wait for the next run and malformed complete records retain the existing warning/skip policy. Each file's failed transaction rolls back both events and cursor; progress already committed for earlier files stays durable. Retry resumes those offsets. Unchanged files are stat/cursor checked without reading their content. A whole-scan advisory lock excludes simultaneous CLI/worker scans, and an instance lease excludes duplicate workers. A killed process releases its DB locks automatically.

For a separately managed **local** worker: `npm run observer:dev`, or `npm run observer:build` then `node dist/observer.cjs` with the same database environment and working directory. This task does not add a production container or remote upload protocol. A VPS cannot read a Windows desktop's telemetry; keep this worker on the machine with the source. The parser/core boundary remains usable by a future agent.

Config apply and manual sync require owner/admin, CSRF and the exact local desktop Origin/Host. Web only writes its fixed config path, never a browser-selected destination. A config belonging to another tenant/organization cannot be replaced through the UI. Runtime errors never expose raw exceptions or telemetry. Stop the launcher with Ctrl+C to shut down both processes; Windows worker shutdown uses IPC.

### Local source selection and operator CLI

On a Windows desktop, `npm run dev:local -- --port 3000` starts the local console at `http://127.0.0.1:3000` with native file/folder selection enabled. Initialize the database using the normal setup steps first; this launcher does not start/reset databases. Owner/admin users can open **Connection details → Select folder / Select JSONL file**, which fills a real absolute path without reading or uploading file content. Cancel preserves the old input. Dialogs time out after two minutes and close when the request is aborted. Manual input remains available.

This mode sets `NEXUS_DESKTOP_ORIGIN` to the exact loopback origin and binds the server locally. Windows `npm run dev` now uses the same local boundary. Do not expose it through a proxy/tunnel. Remote/production deployments, non-Windows hosts and nonadmin users retain manual entry with an availability explanation. The fixed PowerShell script uses a process-scoped execution policy only; it does not change the machine policy.

The console supports **Projects → Create/Edit → workspace directories** and **My Connections → Add → OpenAI Codex local observation**. Registration alone does not enable collection: apply the active Observer configuration as above. For operator use, download nonsecret `nexus-observer.json`; with `DATABASE_URL` targeting the same workspace database, run `scan --dry-run` and then `scan`. Omit `--config` to use the active default/environment path. Do **not** run `configure` for the UI flow: project mappings already exist and scanning reads them from the database. Pending and active subscription mappings accept observed events; revoked, blocked and expired ones do not.

Project directory edits affect future attribution. Archiving releases its directory mappings for reuse without deleting historical observations or automatically revoking connections. Existing CLI-only configuration below remains supported.

Apply the canonical migration first: `npm run db:migrate` with the target `DATABASE_URL`. Never run integration/fixture-reset scripts against your own database.

Create Projects in the console, note their IDs, then create a local nonsecret JSON file:

```json
{
  "tenantId": "your-tenant-id",
  "organizationId": "your-organization-id",
  "sources": ["C:/Users/you/.codex/sessions"],
  "roots": [
    { "root": "D:/Projects/NexusAPI", "projectId": "your-nexus-project-id" },
    { "root": "/home/you/projects/NexusAPI", "projectId": "your-nexus-project-id" }
  ],
  "providers": [
    { "identifier": "openai", "provider": "openai", "product": "openai_codex", "connectionId": "your-codex-observer-connection" }
  ]
}
```

`sources` may list exact JSONL files for a small acceptance run, or session directories for incremental scanning. Sources must be absolute; symbolic links are rejected. Do not select credentials/configuration directories. Only configure `openai_codex` for sources you know use your subscription: the `openai` provider identifier alone cannot distinguish subscription login from a paid API key. If both use the same telemetry identifier, scan selected files separately with explicit connection mapping; do not label an entire mixed archive as a subscription.

```powershell
npm run observer:codex -- configure --config C:/path/observer.json
npm run observer:codex -- scan --config C:/path/observer.json --dry-run
npm run observer:codex -- scan --config C:/path/observer.json
```

The npm command loads `.env.local`, then optional `.env.observer.local`; an explicitly injected shell `DATABASE_URL` wins over both. If the browser preview uses a separate database, put its matching `DATABASE_URL` in the ignored `.env.observer.local` file in the repository root. The downloaded JSON deliberately contains no database credentials. Do not change your main database configuration or seed another database just to make the exported IDs exist.

CLI errors now include safe categories such as `database_unreachable`, `database_auth_failed`, `migration_required`, `config_not_found`, `organization_unavailable`, and `connection_unavailable`, with remediation but no raw exceptions or input. Connections time out after five seconds. A database-unreachable error happens before telemetry parsing and is not a JSON configuration error.

`configure` validates scope, replaces this organization's workspace root list, and creates credential-free `subscription_interactive` connections. Existing connection identity conflicts fail; it never repurposes an API connection. Subscription connections cannot hold credentials, change to a routable mode, or enter Gateway snapshots.

For Coding Plan, use a distinct **nonsecret model_provider identifier actually present in the rollout**, mapped explicitly to `provider: "alibaba"`, `product: "alibaba_coding_plan"`, and its own connection ID. No key-prefix detection or credential import exists. If telemetry provides no distinguishing identifier, leave product unknown instead of guessing. Current-machine acceptance did not exercise Coding Plan because it was not configured; the user selected Codex-only verification.

## Project attribution

Roots use longest matching path **segments**, not project names. Windows drive/UNC paths are case-insensitive, Linux/WSL paths case-sensitive. Normalize separators, trailing slashes and lexical `..`; reject relative roots. Relative/missing cwd is Unassigned. WSL `/mnt/d/...` is not automatically equated to `D:/...`; configure both aliases. Do not resolve symlinks from untrusted telemetry; explicitly configure known workspace aliases. Conflicting equal roots fail.

Events capture project ID, historical name and matched root when imported. Root edits affect new observations only. To explicitly fill previously Unassigned observations after configuring roots:

```powershell
npm run observer:codex -- reattribute --config C:/path/observer.json
```

Already-attributed facts and token counts cannot be changed by this operation. No query dynamically remaps historical usage.

## View

**运行会话 / Sessions** counts distinct telemetry session IDs with observed usage in the selected project/date range. Desktop conversations, spawned subagent sessions and CLI exec sessions have their own IDs, so this is not a count of visible Codex desktop conversation windows. Repeated scan events are deduplicated; grouping by model can place the same session in multiple rows, so row session counts are not additive.

Click a row's session number to expand a query/group-scoped conversation tree. A parent row shows itself plus its loaded descendants; expanding it separates the parent session's own usage from each child. Sessions use IDs/dates/models for identification, without reading conversation titles or bodies. CLI sessions without explicit parent metadata remain standalone; individual shell commands do not have independent token observations.

Each token dimension shows an exact percentage of the **current authorized query's subscription same-dimension token total**, before narrowing to the clicked group. This is observed subscription token composition, not official quota. Null or zero denominator gives unknown. Cached input is part of input; reasoning output is part of output, so the columns cannot be summed. Details load only when opened, with stable asOf and pagination.

After additive migration 0016, regular scans extract known session kind/parent ID from a bounded first session_meta header while leaving the token parser version and cursor format unchanged. To enrich already imported records without importing new events or moving cursors:

```powershell
npm run observer:codex -- enrich-sessions --config nexus-observer.json
```

The operation only fills missing session metadata. It can enrich historical revoked connections without moving their usage to a new connection. Re-running an unchanged metadata fill updates zero rows; known metadata and all original token/attribution fields remain immutable.

Project Analytics uses workspace-styled filters and project-name selection. Its **关联连接额度** panel displays the latest saved quotas for accessible active connections bound to the project or linked by subscription observations. A historical link does not grant connection access. Official percent used/remaining is shared account usage, independent of the analytics date/model filters; no project quota percentage is inferred. Refresh observation rereads DB; use the connection page to sync fresh provider observations.

Open **Projects → NexusAPI → Analytics**, or the existing Billing page's Project Analytics panel. Select **All Usage**, **Gateway**, or **Subscriptions · Observed**. Filter project/provider/model/dates; group by model, provider, subscription, source or daily UTC trend. The Unassigned button selects the explicit unassigned bucket. Sessions and Observed usage events are separate from Gateway API requests. Provenance is displayed with authority. Empty ranges show no usage; null remains `unknown`.

API: `GET /api/billing?usageSource=codex_local&authority=client_observed&groupBy=model&projectId=...` with an authenticated session. Other source values: `gateway`, `all`. Omitted source remains Gateway for old consumers. Existing tenant/project authorization applies. Observer rows contribute no money buckets and cannot feed Budget, Wallet, Ledger, financial outbox or settlement.

Quota remains in existing `GET/POST /api/connections/{id}/quota`, with manual snapshot validation, source, confidence, observed/reset/stale timestamps. This observer does not promote local rate-limit notifications into official quota. No quota available means unknown; never allocate a shared subscription percentage from project tokens.

## Codex account connector

After applying canonical migration 0015, open **Connections → OpenAI Codex → 配置与详情** in the local workspace. Official Quota reads automatically while visible. **刷新账户** additionally refreshes official usage history. Official `account/read`, `account/rateLimits/read`, and `account/usage/read` are documented in the [Codex App Server protocol](https://developers.openai.com/codex/app-server/). GET reads stored observations; protected automatic quota POST and explicit full refresh POST invoke the provider.

Start with `npm run dev:local` after configuring the existing database. Refresh requires local owner/admin access, an explicit loopback `NEXUS_DESKTOP_ORIGIN`, matching Host/Origin, and CSRF. It is intentionally unavailable in production/remote deployments. Default executable discovery uses Codex on PATH (including npm's Windows native executable). Optional server-side `NEXUS_CODEX_EXECUTABLE` must be an absolute path to the official executable, never a browser-supplied command. The connector tries `codex app-server proxy` first, then a short-lived `codex app-server --stdio`; it does not start or manage a daemon. Authentication remains in Codex.

The connection shows account/auth type/plan, last attempt/success, all returned quota windows, percent used/remaining, reset/duration/credits and official summary/daily buckets. Percent remaining is the complement of the reported used percentage, floored at zero. Today matches the UTC calendar date against provider-returned dates (the protocol does not specify bucket timezone). Missing metrics stay unknown; token integers preserve exact precision. Official observations carry source `codex_app_server`, authority `provider_reported`, scope `account`. Existing quota vocabulary is `sourceKind=official`, `confidence=reported`, `scope=account`, `attributionMode=shared`; metadata carries `unit=percent` and dynamic provider bucket information.

Sync errors retain previously successful sections with timestamps. Account logout and App Server unavailability are separate states. A known different account requires a new connection, avoiding mixed account history. Subscription mapping status and account sync status are distinct: account synchronization never enables routing or changes Observer ingestion eligibility. Connection project activity uses existing authorized observer rows; old revoked connection history is not reassigned to a new connection.

GET `/api/connections/{id}/account` returns `{observation,quotas,activity,syncAvailable}`; POST triggers sync and returns `{status,lastSyncError}`. Both are authenticated and no-store. POST has no user-configurable transport or provider parameters. Unknown provider response fields are discarded; no raw payload, credential, prompt or conversation is persisted/logged. Existing quota ingestion remains manual-only for public callers. There are no Budget/Wallet/Ledger writes.

## Incremental recovery and removal (Observer)

File identity plus byte offset and allowlisted parser state are committed transactionally with events. Repeated unchanged files read zero bytes and increment `unchangedFiles`; thus `skippedDuplicates` can be zero on a successful no-op scan. Replayed files use a stable metadata fingerprint and report duplicate skips. Incomplete tails are retried. Truncation/replacement replays from zero; unsupported/malformed usage produces safe warning counts. No timestamp-only identity is used.

Reset only this scope's scanner cursors (events retained, replay deduplicated):

```powershell
npm run observer:codex -- reset-cursors --config C:/path/observer.json --confirm-scope your-tenant-id/your-organization-id
```

Explicitly remove only this scope's Codex observer events and cursors:

```powershell
npm run observer:codex -- delete-observations --config C:/path/observer.json --confirm-scope your-tenant-id/your-organization-id
```

Neither command deletes original Codex files, roots, connections, quota history or financial data. Stop scans before code rollback; keep additive tables and migration history. Resume with the compatible parser or reset cursors deliberately. No daemon or scheduled background service is installed.

Codex's supported noninteractive execution and resume flags are documented in [official OpenAI documentation](https://developers.openai.com/zh-Hans/docs/non-interactive-mode); local rollout structure was independently inspected, since CLI stdout JSONL and persisted rollout JSONL are different formats.

Claude Code 本地日志现可通过独立 `claudeSources` 配置导入，见 [配置与统计口径](claude-code-observer.md)。原 `sources` 保持 Codex 语义。
