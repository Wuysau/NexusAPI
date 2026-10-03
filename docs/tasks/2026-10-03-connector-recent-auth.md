# Recent authentication for connector pairing and rotation

## Existing contract and candidate

The connector configuration POST already classifies its operation as `credential:rotate`. It issues a one-time pairing secret and invalidates preceding identities, leases and pairing credentials. Shared Control Plane plumbing requires recent authentication for credential rotation, but this route currently uses only `requireContext`. The connection panel directly sends the POST without the existing reauthentication interaction.

An independent real PostgreSQL/native-route characterization established stale-session behavior before implementation. This round follows the existing fifteen-minute recent-auth rule; it does not define a new window or add a separate connector approval policy.

## Smallest consistent change

Use `requireHighRiskContext` for the entire existing connector POST, including initial pairing issuance and later rotation. Keep ordinary connection creation, GET readiness, diagnostics and runtime pair/lease authentication unchanged. A conditional prior-identity policy would add state and a transaction-boundary decision to a route already classified as rotation.

In `LocalConnectorPanel`, reuse `useHighRiskAction` and `ReauthDialog`. Put the actual POST inside the retriable action, so the shared helper receives its `ApiError`. Capture the submitted model list and connection lifetime once. Before sending and applying results, verify that lifetime is still current; canceled dialogs or unmounted/replaced panels must not resume an old action. Preserve one-time token display and the existing testing/cancellation workflow.

[GitHub sudo mode](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/sudo-mode) and [Nextcloud password confirmation](https://docs.nextcloud.com/server/stable/developer_manual/digging_deeper/javascript-apis.html#nextcloud-password-confirmation) illustrate recent verification for sensitive actions followed by the pending operation. NexusAPI retains its own session rotation and fifteen-minute rule.

## Verification and ownership

Use only the guarded query-free loopback PostgreSQL fixture on port `55439`, database `connector_test_reauth_round54`, or the existing CI database when explicitly allowed. Verify `current_database()` before destructive setup and apply all twenty-eight canonical migrations. Prove a valid sixteen-minute administrator session is denied before connector, pairing, identity, lease or success-audit writes. Cover initial issuance, actual reauthentication/session replacement and one successful rotation, plus fresh-session, capability and CSRF controls. Do not print tokens, stored credential material or passwords.

Verify the actual browser panel with the repository's Next app and Chromium: stale-session dialog, successful single retry with the original submitted models, cancellation and panel removal without an old retry. Lifecycle controls delay delivery of an actual authentication response; authorization endpoints are not stubbed. Keep all fixture processes and database ownership bounded and explicit.

Root owns production, UI, docs, validation and Git. The delegated agents own only the new `tests/integration/connector-recent-auth.test.ts`, `tests/e2e/local-connector-reauth.mjs` and their separately guarded ignored artifacts. The browser database is `connector_test_reauth_browser_round54`, using the same loopback/port/query/current-database safeguards. Production edits began after the preceding endpoint configuration round completed its integration and commit. No migration, new capability, subscription credential access or deployment change is involved.

## Results

- The ignored actual-route characterization produces two desired old failures and three passing controls (5.20 seconds). Still-valid sixteen-minute administrator sessions pass ordinary session authentication and report `freshAuth: false`, yet old initial issuance and rotation return 200. Initial issuance creates the Channel/credential/pairing and success audit; rotation revokes an active identity/lease and replaces the pairing hash. The first probe also incorrectly expected no CSRF-denial audit; that assertion was corrected to preserve the legitimate `csrf.rejected` audit, and its extra error is excluded.
- The five-group formal fixture reproduces exactly two old failures and three controls (4.93 seconds). It uses all twenty-eight canonical migrations, the exact guarded round54 or verified existing CI database, and bounded pool closure. Fresh issuance/rotation, capability/CSRF denials and actual reauthentication/session replacement pass; successful rotation also rejects the old identity through the real lease API and the old lease through current authorization.
- The shared high-risk guard passes all five groups (5.04 seconds), and the final guard also rejects literal database URL delimiters before reset; all five groups pass again (5.26 seconds). Both stale denials return `401 forbidden`, issue no token and preserve all business facts and success audit counts. Actual reauthentication invalidates the old session and permits one issuance from the new fresh session.
- The new backend passes nineteen real private-TLS Gateway/CLI/mock Ollama scenarios (32.09 seconds), with all twenty-eight canonical migrations, and 141 related TypeScript unit/contract checks (3.01 seconds). No Go source changed this round; the endpoint round's native/race/vet/minimum-version checks remain applicable.
- Browser fixture setup/startup errors are excluded from product evidence. Windows source-junction discovery required unchanged public source/packages copies, and the fixture's forced webpack mode was incompatible with the application's CSP. The fixture now uses the repository's default Turbopack with an explicit workspace root and isolated Next output, preserving CSP and avoiding repository environment files and root generated-file changes.
- The one-case actual old-panel/new-backend baseline fails only because the reauthentication dialog is absent (11.80 seconds). The real stale POST returns 401, makes one configuration request, preserves complete connector facts and exposes no pairing token; browser errors are empty and all fixture processes/pools close.
- The panel now puts the POST inside the shared retriable action, retains its submitted models/lifetime, manages busy state for initial execution and retry, suppresses obsolete denials before the shared hook and guards the captured dialog callback. Fresh non-incremental TypeScript compilation and scoped ESLint/Prettier pass.
- The first five-group browser run has four passes and one fixture-ordering failure (25.27 seconds). The replacement connection was created through the API after the page collection loaded, so it was absent from the cached UI list; it did not reach the obsolete-action assertion. The fixture now creates the replacement before loading the page. No product adjustment was made.
- The corrected browser run passes all five groups (13.61 seconds): real stale-session cancellation, password reauthentication with immutable-model single retry, fresh issuance, and held real authentication responses after panel removal or replacement. There is no extra configuration POST or token after either obsolete callback. Browser errors are empty, all process trees/pools close, and root generated types remain byte-identical. Syntax, formatting and saved log/report privacy checks pass.
- Final scoped ESLint, Prettier, browser syntax, repository secret scan and staged diff checks pass. Independent read-only review of the exact eight-file scope against `90e61a7` found no actionable issues and accepted integration. The review inspected the actual native and browser RED/GREEN evidence; live deployment and independently repeating broader checks were outside its scope.

## Reproduction

Run the native route suite with an explicit disposable environment file whose `DATABASE_URL` selects `connector_test_reauth_round54` on loopback port `55439`, with no query or fragment:

```sh
node --env-file=/path/to/disposable-reauth-test.env node_modules/vitest/vitest.mjs run tests/integration/connector-recent-auth.test.ts --no-file-parallelism
```

The browser companion requires a separate environment file selecting `connector_test_reauth_browser_round54` at the same guarded host/port. Both suites reset their dedicated schemas and apply all twenty-eight migrations. The browser run uses actual application source and routes, isolates Next output, and retains ignored outputs; it does not build or execute Go inference.

```sh
npx playwright install chromium
node --env-file=/path/to/disposable-reauth-browser-test.env tests/e2e/local-connector-reauth.mjs
```
