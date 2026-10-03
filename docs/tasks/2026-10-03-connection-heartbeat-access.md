# Capability and visibility for generic connection heartbeat

## Existing facts and design

The generic `connections/[id]/heartbeat` POST requires `credential:read`, then reads and updates an owned connection by ID and tenant. Viewer and Billing can therefore mutate its status/capabilities, and an ordinary developer can reach a nonlocal connection outside their project visibility. The separate local connector identity/lease path already rejects generic `local_sidecar` heartbeats and stays authoritative.

Follow [Grafana's separate resource read/write checks](https://github.com/grafana/grafana/blob/v11.6.0/pkg/api/api.go#L360-L373) and [action/scope design](https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/access-control/custom-role-actions-scopes/) through NexusAPI's existing capability and workspace predicates. Require `credential:create`, as connection registration and subscription monitor configuration already do. Use `connectionVisibility` and `workspaceParams` in both the preliminary mode lookup and the actual UPDATE, so a current project visibility check controls the mutation. Also exclude `local_sidecar` at the UPDATE boundary. Return the existing not-found response for hidden/revoked targets and preserve the explicit identity-required rejection for an authorized local target.

Do not introduce a new role, recent-auth rule or online authority. Preserve status/default/capability replacement behavior for authorized ordinary writes. The legacy heartbeat remains management metadata; it cannot establish local connector readiness, lease authentication, API routing or subscription forwarding.

## Characterization and ownership

First use the actual native route, ordinary connection listing and real PostgreSQL to prove read-only mutations and hidden-project access before applying the repair. Keep full rows and credentials in memory and report only fixed status/error codes, counts and booleans. Cover visible authorized developer and unbound-owner writes, hidden project, unrelated tenant, revoked connection, CSRF and local connector identity controls.

The delegated test owns only `tests/integration/connection-heartbeat-access.test.ts` and its ignored audit outputs. Use exact query/fragment-free loopback port `55439`, database `workspace_access_heartbeat_round56` or verified serial CI `convergence_ci15`; verify `current_database()` before reset and apply all twenty-eight migrations. No private application env, subscription authentication or production database is read.

Root owns route/docs/validation/Git. A separate agent may prepare future storage-health characterization in its own database and Go test file; that future work must be preserved and excluded from this round's staged scope. No Go, UI, migration or local connector transport change is planned here.

## Results

- Independent read-only design review accepts `credential:create` as the existing ordinary write capability and the shared visibility predicate at both SQL boundaries. The UPDATE rechecks project membership and local mode at statement time; this is not a new organization-role revalidation or serialization guarantee.
- The first fourteen-leaf fixture stopped during setup because an extra same-tenant organization violated the canonical unique organization/tenant constraint. No route assertions were reached; these setup failures are excluded from product RED evidence. The author removes the impossible organization/control and retains actual private-project/unbound-owner visibility plus the separate unrelated-tenant control.
- The corrected native OLD fixture has five desired failures and eight passing controls (10.49 seconds). Viewer/Billing writes to a visible connection, developer writes to a private project or another owner's unbound connection, and membership removal during real delayed body consumption each return 200, mutate one connection and append one success audit. Actual native GET listings prove which objects are visible; the unchanged-membership delayed-body control succeeds normally.
- The repaired route passes all thirteen cases (10.26 seconds), with all twenty-eight migrations. Read-only roles return `403 forbidden`; hidden targets and lost membership return the existing `404 not_found`. Denials preserve complete business facts and success audits. Authorized developer/owner/admin writes retain status, empty-body defaults and capabilities semantics. The unrelated tenant, revoked target, local connector identity rejection and legitimate CSRF audit controls pass; the pool closes.
- The related 141 TypeScript unit/contract checks pass (3.22 seconds), as do scoped ESLint and Prettier. No Go, UI or local connector transport changed; the preceding round's nineteen real private-TLS end-to-end scenarios remain applicable, and this native fixture independently checks the unchanged administrator local-sidecar rejection.
- Fresh non-incremental TypeScript compilation, repository secret scan and diff checks pass. The loopback test guard rejects malformed database URLs without echoing their input, raw query/fragment delimiters and production mode; pool closure is bounded.
- Final independent read-only review of the exact four staged files against `3f0e6bb` found no actionable issues and accepted integration. The reviewer inspected native visibility/body-gating evidence, complete denial comparisons, SQL parameter binding and source claims. Live deployment, future storage-health work and independent reruns of broader/static checks were outside its scope.

## Reproduction

Provide an independent environment file whose `DATABASE_URL` selects `workspace_access_heartbeat_round56` on loopback port `55439`, without a query or fragment. This suite resets its dedicated schemas and applies all twenty-eight canonical migrations. Do not share its database with another active test.

```sh
node --env-file=/path/to/disposable-heartbeat-test.env node_modules/vitest/vitest.mjs run tests/integration/connection-heartbeat-access.test.ts --no-file-parallelism
```
