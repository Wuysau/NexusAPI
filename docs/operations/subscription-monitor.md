# Subscription monitoring through CodexBar

NexusAPI imports the stable **dashboard-v1** display contract, not the unrelated `usage --format json` array. It saves only an explicitly selected provider/account's percentages and reset timestamps. All results are `source=codexbar`, `authority=collector_reported`, organization-scoped monitoring observations. They do not write `quota_snapshots`, affect routing eligibility, or enter billing/ledger totals. Native Codex account synchronization stays separate.

## Server refresh

Run a separately installed CodexBar collector under the account that has authorized provider access. Configure provider credentials on that host, not in NexusAPI's browser. CodexBar platform/provider support and credentials determine which rows and windows are actually available.

Configure these environment variables on the NexusAPI server:

```dotenv
CODEXBAR_DASHBOARD_URL=http://127.0.0.1:8380
CODEXBAR_DASHBOARD_TOKEN=<same strong token configured on CodexBar>
CODEXBAR_DASHBOARD_TENANT_ID=<tenant id>
CODEXBAR_DASHBOARD_ORGANIZATION_ID=<organization id>
```

Start the collector using its `CODEXBAR_DASHBOARD_TOKEN` environment variable and `codexbar serve --port 8380` (NexusAPI's gateway uses port 8080). Keep the token out of command-line arguments and source control. Use loopback HTTP on the same host or a TLS reverse proxy (`https://...`) for remote collectors. NexusAPI rejects non-loopback plain HTTP, URL userinfo/query credentials, and redirects. Requests use bearer authentication, a ten-second deadline and a 1 MiB streamed-body limit. Browser requests cannot choose the server URL or credentials. This deployment supports one configured tenant/organization per collector endpoint.

An organization owner/admin opens a supported connection's **订阅额度监测** panel, selects the collector provider, reads accounts, explicitly selects an account, and saves the binding. **从采集器刷新** requests `GET /dashboard/v1/snapshot?provider=<id>` and updates only that binding. Upstream cached data retains its original timestamps. Refresh is manual; the panel re-reads persisted state every 30 seconds to display staleness without making extra provider requests. No background collector process is installed or started by NexusAPI.

## JSON import

On the collector host run:

```sh
codexbar dashboard > snapshot.json
```

Import this file through the panel, inspect and select the account, then save. The raw file is transient. NexusAPI does not persist emails, plan labels, tokens, cookies, free-form errors, local cost reports, host metadata or raw JSON. Preview shows account email/source ID only to the authorized caller. Stored account keys are SHA-256 hashes; labels for quota windows use bounded kind identifiers. Treat input snapshots as account data and share them only with the intended organization.

Multi-account sources bind the exact stable `accounts[].id` plus a nonredacted email when supplied; changing that known identity requires a new binding. Ambient provider values and the active account are never used as fallbacks. Ordinary single-account rows require a unique nonredacted `identity.accountEmail`; redacted/absent identities cannot be safely bound. A source that lacks an identifiable account cannot currently be imported, even if its provider is mapped. Multi-account IDs are source-local slot identifiers: when no email is supplied, slot reuse cannot be distinguished, so verify the source account before rebinding. Unknown, malformed or missing percentages stay null; they are never treated as zero. Credits and cost fields are not currently projected into this quota-window view.

Snapshot `schemaVersion` must be exactly 1. Missing/duplicate providers, missing/duplicate account bindings and unsupported formats fail closed. Both provider/account `updatedAt` and snapshot `generatedAt` are validated before taking their older timestamp; missing times or times more than 60 seconds in the future stay unknown. Freshness uses `staleAfterSeconds` capped at one hour; a reported window whose reset time has passed makes the observation stale even before that TTL expires. Failed refreshes retain previous windows with an explicit error state. Imported snapshots are user-supplied reports, not independently verified provider balances.

## Access and supported mapping

All API calls use existing session, CSRF, project visibility and tenant isolation checks. Writes require organization owner/admin or the owning developer. Every shared server collector read, including refresh, requires owner/admin; an owning developer may import their own file. This prevents a developer from importing a guessed account identity and then querying that account through the shared collector. The saved observation's organization must match the caller. Revoked and native Codex connections cannot be changed through this endpoint.

Explicit mappings: Claude Code→`claude`, Gemini→`gemini`, Copilot→`copilot`, Cursor→`cursor`, Windsurf→`windsurf`, Kiro→`kiro`, JetBrains AI→`jetbrains`, Kimi→`kimi`, GLM→`zai`, MiniMax→`minimax`, Alibaba→`alibaba`/`alibabatokenplan`, DeepSeek→`deepseek`, Grok/xAI→`grok`/`xai`, Perplexity→`perplexity`. The registry mapping does not claim that all account types expose quota windows, or that subscriptions can execute through the gateway. TRAE, Qwen Code, Volcengine and Tencent currently have no verified mapping in this bridge.

Primary contract references (checked 2026-09-29): [dashboard API](https://github.com/steipete/CodexBar/blob/main/docs/dashboard-api.md), [CLI](https://github.com/steipete/CodexBar/blob/main/docs/cli.md), [provider IDs](https://github.com/steipete/CodexBar/blob/main/docs/provider-ids.md). Upstream main can evolve; schema versions other than 1 require a reviewed adapter update.
