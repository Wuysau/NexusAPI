# Apply existing project access to project-bound API key creation

## Source and current gap

[Grafana v11.6.0 service-account token creation](https://github.com/grafana/grafana/blob/v11.6.0/pkg/services/serviceaccounts/api/api.go#L52-L63) combines the write action with the selected service-account scope. NexusAPI already combines action and resource access for project management and bindings; project-bound key creation should use that same principle. This is a design reference, with no copied code or new dependency.

POST /api/keys requires apikey:create, which an organization developer has. Its project lookup currently checks only the supplied ID, tenant and archive flag. Source predicts that a developer without membership can mint a key bound to an otherwise hidden private project. The native project GET already applies managed-project visibility. A successful key issuance would create key and audit facts; execution impact must not be asserted without actual dispatch proof. Native OLD characterization comes first.

## Minimal design and boundary

For a supplied nonempty project ID, call the existing resolveManagedProject before the existing tenant/archive lookup and before key generation, persistence, audit or binding. It rereads active organization membership and applies the current ordinary-member project scope and privileged organization visibility. Hidden/foreign/missing projects get the shared fixed 404; a visible archived project retains the existing project_not_found refusal. Preserve current omitted-project behavior and input handling, visible unarchived project-state behavior, scope/expiry validation, key list/revocation roles, one-time plaintext response and signed projection rules.

Independent read-only design review is clear. The shared concealment error is 404 tenant_isolation for hidden/missing/foreign projects; it replaces the old project_not_found code for missing/foreign objects. Visible archived projects still reach the original 404 project_not_found. Viewer/Billing still fail the initial apikey:create check before any project read. The resolver does not repeat apikey:create after a concurrent role change; the claim remains authorization at the read.

This checks current scope at the authorization read. It does not add a serializable key/binding transaction or revoke previously issued keys when human membership changes. No key, project, resource identity, model, usage or settlement schema is added. Gateway runtime authorization remains separate.

## Proof and ownership

The agent owns only new tests/integration/api-key-project-access.test.ts and ignored fixture artifacts. Root owns production, documents, review and Git. Use only explicit query/fragment-free loopback port55439 database workspace_access_api_key_project_round62, or the already-verified serial CI fixture convergence_ci15. Prove current_database before reset and apply all 28 canonical migrations. Create actual sessions/CSRF and call native project GET and key POST with real PostgreSQL; do not mock authentication, results or queries. Keep plaintext keys and complete fact comparisons in memory, with fixed boolean/count assertions and no row/hash/token output.

OLD must show that the same developer's private-project GET is denied while key POST succeeds and creates a project-bound key/success audit. GREEN must refuse issuance without any key or successful audit change. Include authorized project member, owner/admin, missing/foreign projects, visible archive and omitted/null project controls. Compare complete facts and exact safe attribution metadata; close all clients/pools/processes before handoff. The test does not perform inference or financial settlement.

After the minimal change, run the unchanged formal native regression, related TypeScript checks and fresh compilation/lint/format/secret checks. Run actual private-TLS connector forwarding checks with valid project keys. No Go or migration changes are planned; reuse previous Go evidence explicitly. Review and commit only completed paths through the separate-main-worktree hook.

## Actual OLD and implemented result

The stable native OLD run has exactly one expected failure and six passing controls (Vitest 6.02s, runner 6.45s). The developer's actual project GET returns 404 tenant_isolation and the project list hides the private project. Actual key POST nevertheless returns 201 with a plaintext token and safe key projection, creating one key bound to that project/tenant and one apikey.created audit with the matching target. Other domain/accounting facts remain unchanged. No execution impact is asserted from this issuance test.

The production change adds only the shared resolver import and call before the existing project lookup. The unchanged native test passes all seven groups (6.49s, runner 6.88s). Twelve observed operations include six legitimate issuances, five complete-fact-preserving refusals and the legitimate CSRF refusal audit. Private/foreign/missing projects return 404 tenant_isolation without a token/key, new key or success audit. Visible archived projects retain 404 project_not_found. Member, owner/admin, inactive-but-unarchived and omitted/null binding controls retain their existing successful projections, scopes, expiry, one-way hashes and exact audit attribution. Historical keys remain unchanged. All owned clients, pool, inspection and child processes close; activeOtherSessions is zero.

With an explicitly supplied guard-matching DATABASE_URL for a pre-created disposable database, run:

```sh
npx vitest run tests/integration/api-key-project-access.test.ts --no-file-parallelism
npx tsc --noEmit --incremental false
```

The fixture verifies current_database before reset and applies all 28 canonical migrations. Keys, hashes and full fact comparisons remain in memory; only safe statuses/counts/booleans are emitted. Fresh compilation passes, related 146 TypeScript unit/contracts pass in 3.27s, and scoped ESLint/formatting pass. The actual nineteen-scenario separate-process private-TLS connector regression passes in 25.78s with seeded project keys, covering discovery, normal/streaming calls and attribution. Native HTTP issuance and its audits are proven by the new fixture; TLS routing is proven by the existing fixture. Its clients/processes close. No Go or migration changes occurred; Round59's full native/race/vet and scoped minimum-Go evidence remains applicable. The single-Gateway transport limit remains.

Independent read-only review of the exact five commit paths is clear. Secret scan and diff checks pass. All verification clients/processes are closed. Integration follows explicit-path commits and the automatic separate-main-worktree merge/push hook; the ignored local handoff stays outside the commit.
