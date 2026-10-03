# Scope project policy previews to visible resources

## Source and concrete defect

[Grafana's action and scope model](https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/access-control/custom-role-actions-scopes/) combines permission to perform an action with permission to access its resource. Its [pinned API source](https://github.com/grafana/grafana/blob/v11.6.0/pkg/api/api.go#L360-L373) applies read actions to resource scopes. NexusAPI already has the corresponding project membership and connection visibility rules; a preview endpoint must reuse them.

`POST /api/projects/:id/policy-preview` currently checks `project:read` but selects both project and connection only by tenant. Viewer/developer members can therefore supply a private project or connection ID hidden by the existing project, connection and resource GET endpoints. The result includes provider, mode, status and an advisory decision and appends a successful `policy.previewed` audit. This is a direct API issue; no UI caller was found.

## Minimum implementation

Resolve the target through `resolveManagedProject`, retaining this endpoint's current rejection of archived projects. Select the supplied connection with `connectionVisibility` and `workspaceParams`. Complete both access checks before returning connection facts or appending successful preview audit. Keep the existing operation/revocation decision and organization management roles. A preview does not perform inference, authorize an API key, prove model availability or require a visible connection to be bound to the selected project.

## Native proof and ownership

Use only the explicit query/fragment-free loopback `55439` database `workspace_access_policy_preview_round58`, with `current_database()` proof before any reset, all twenty-eight canonical migrations and real sessions/CSRF/native route calls. Respect the canonical one-organization-per-tenant constraint. Confirm hidden objects through existing actual GET routes before invoking the preview. Compare durable state and successful audit counts in memory without printing private values.

Characterize hidden-project/visible-connection, visible-project/hidden-project-connection and visible-project/other-owner-unbound cases before changing production. Retain positive member/viewer, owner/admin/billing and own-unbound controls, revoked/unsupported advisory decisions, archived and foreign-tenant refusal and actual CSRF protection. Denied previews must return no connection facts and append no successful preview audit. No Gateway execution, budget authorization or financial settlement is claimed. The test agent owns only its new integration test and ignored audit fixture; root owns route, docs, validation and Git.

## Actual OLD evidence

`node .test-artifacts/project-policy-preview-access-audit/run-formal.mjs formal-old-red-corrected.txt` produces exactly three intended RED and six passing groups in 8.18s (runner 8.55s). Each target is already hidden by the actual project/connection/resource GET routes, yet native preview returns 200, connection facts and allowed=true, and appends one successful audit. Domain and accounting facts remain unchanged. Seventeen OLD successful previews include the three unauthorized targets; five existing refusals and one actual CSRF rejection retain their behavior. All pools/processes close, and final other-session count is zero.

The initial fixture attempt sorted `project_workspace_roots` by a nonexistent id. It reached no preview calls; the composite-key sorting was corrected before capturing the stable OLD evidence. That initial log is preserved and excluded from production defect evidence. Tests use one organization per tenant and in-memory equality with fixed failure messages; no credential or complete private row is printed.

## Implemented result and checks

- The route now resolves project visibility through the shared managed-project helper and keeps its existing active/archive lookup. Its aliased connection query uses the same four workspace arguments and ID `$5` as other management endpoints. Existing read capability, CSRF protection and advisory decisions remain.
- The exact formal GREEN command, `node .test-artifacts/project-policy-preview-access-audit/run-formal.mjs formal-green.txt`, passes all nine groups in 9.74s (runner 10.16s). All 23 native preview observations match the intended contract: fourteen visible successes with exact audit attribution, eight resource denials with no facts or successful audit changes, and one CSRF rejection with only its legitimate rejection audit. Final other-session count is zero, with all processes/pools closed.
- To reproduce without the ignored audit runner, explicitly inject the dedicated `DATABASE_URL` and run `npx vitest run tests/integration/project-policy-preview-access.test.ts --no-file-parallelism`. The test itself verifies the named disposable target, resets it and applies all 28 migrations. It also permits only the already-verified serial CI database `convergence_ci15` on the same loopback port; no ordinary application database is accepted.
- Fresh `npx tsc --noEmit --incremental false` passes. The twelve related TypeScript unit/contract files pass all 141 tests in 3.25s. Scoped ESLint/Prettier, secret scan and diff checks pass.

No UI, Go, Channel routing, pricing or migration changed. Round57's nineteen real private-TLS connector forwarding tests, full native/race Go checks and scoped minimum-version checks remain applicable; they are not claimed as new Round58 executions. The independently prepared next-round singleton test and task document remain outside this commit.

Independent five-file read-only review is clear: access ordering, SQL bindings, archive/error/role semantics, native assertions, fixture safety and primary-source attribution are consistent. All verification commands and clients are closed. Git integration uses the repository's explicit-path commit and separate-main-worktree automatic sync.
