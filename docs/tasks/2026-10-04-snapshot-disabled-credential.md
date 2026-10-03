# Omit valid disabled credentials after validating snapshot identities

## Source and current failure

[Kong 3.9.1 address lifecycle](https://github.com/Kong/kong/blob/3.9.1/kong/runloop/balancer/balancers.lua#L268-L299) validates address ownership separately from its availability/disabled state. NexusAPI can apply that distinction to signed routing candidates; it does not import Kong's implementation or change credential authority.

The current external Channel POST permits multiple Channels to reference one enabled opaque credential. Channel DELETE disables that credential and only the selected Channel. Other referencing Channels can remain enabled. Snapshot loadChannels currently combines disabled credentials with invalid credential scope and throws for the whole tenant bundle, potentially withholding an independent healthy Channel. Resources already project the shared credential as disabled. Native OLD proof is required; this is a snapshot availability problem, not proof of unauthorized dispatch.

## Minimal design and boundary

Keep all existing credential and connection ownership/provider/organization checks, including explicit connection and local-only binding. Treat credential enabled as an exact boolean state; null/missing/invalid referenced identity remains an error. After validation, omit a correctly bound candidate with enabled=false. Keep output/order/model/key/billing-mode identities and Channel DELETE semantics. A simple SQL enabled filter is insufficient because it would hide invalid disabled identities that currently refuse signing.

Preserve local-only downstream shape checks before omission as well: valid credential_version and the existing capability-array boundary must not be masked by an earlier skip. Ordinary published version/shape compatibility remains unchanged. An absent credential reference is an existing managed compatibility case; a missing nonnull FK is rejected by canonical storage constraints. No new identity policy is inferred for either.

This governs newly generated bundles. It does not instantly invalidate previously cached signed generations or perform independent registry revocation. No credential is reenabled, no fallback or replay rule changes, and no price/usage fact is added.

## Proof and ownership

Parent owns sole new tests/integration/snapshot-disabled-credential.test.ts and ignored fixture artifacts. Root owns production, documents, verification and Git. Use only explicit query/fragment-free loopback port55439 database gateway_test_disabled_credential_round64, or the already-verified serial CI fixture convergence_ci15. Prove current_database before reset and apply all28 canonical migrations. Use actual fresh console sessions/CSRF, external Channel POST/DELETE/PATCH, resource GET and internal-token signed snapshot GET. Verify HMAC and freeze all facts in memory; print only safe statuses/counts/booleans. No plaintext provider, subscription credential or application environment is read.

Create A/B sharing a credential and independent C; verify the initial signed bundle, then actually DELETE A. Record shared credential disabled, A disabled/B enabled, unchanged C and resource projection. OLD should fail the fresh bundle; desired bundle contains only C. Pause B through actual PATCH and record recovery before final desired assertions. Add correctly bound disabled tenant/platform controls and invalid tenant/provider/org/null-scope/connection and local-shape controls that still refuse signing, plus absent-reference and canonical-FK controls. Reads preserve domain/audit/accounting facts; legitimate mutation audits remain. No Gateway inference, Vault operation or settlement is claimed. Close all clients/processes before production handoff.

After stable OLD, make the minimal projection change, rerun unchanged native characterization, appropriate snapshot/routing/connector TypeScript checks and fresh compiler/static checks. Run the actual private-TLS connector regression for existing authorized forwarding. No Go/migration change is planned; reuse prior Go evidence explicitly. Review exact completed paths and integrate separately through the main-worktree hook.

## Implementation and verification

The route now requires an exact boolean credential state, preserves identity/binding validation and the local builder's positive safe version/capability-array boundary, then omits valid disabled candidates. The existing SQL does not filter disabled credentials before validation. Ordinary published version compatibility, credentialless managed compatibility, model/key directory rules and Channel deletion remain unchanged. Local snapshots derive their models from surviving local Channels.

- Native OLD: 4 desired failures and 7 passing controls, 11.33s (runner 11.76s). Actual creation yields three signed candidates; deleting A yields exactly two legitimate audits, disables its shared credential and leaves B enabled. The old fresh snapshot fails with a fixed unsigned 500, while resource identities show A/B disabled and C configured with unknown health. Actual pause of B restores a signed C-only bundle before desired assertions run.
- Unchanged native GREEN: all 11 groups pass, 12.48s (runner 12.88s). Tenant/platform/local disabled candidates are omitted. Invalid tenant/provider/organization/null scope, five connection cases, six local version cases and two capability shapes still refuse signing. Canonical missing-reference FK refusal and legacy null-reference compatibility pass. Full facts stay unchanged across reads; C's fields and the published nested payload/model/key/limit facts are preserved. All 28 canonical migrations are applied; all fixture clients/processes close, with zero other active sessions.
- Local-route unit OLD: 2 failures and 31 passing controls. A valid disabled candidate suppresses the healthy bundle, and a nonboolean string state incorrectly passes. Related GREEN: 163 tests across twelve files pass in 3.16s, including canonical HMAC and surviving local models.
- Fresh `npx tsc --noEmit --incremental false`: exit 0 (10.75s). Scoped ESLint, Prettier, `npm run secrets:scan` and `git diff --check` pass.
- Fresh actual separate-process private-TLS connector regression: 19 tests pass in 31.02s. This uses mock Ollama and seeded project API keys; new key issuance is proven separately by Round62's native test. All workers, HTTP clients and pools close.

Reproduce the native test with an explicit DATABASE_URL targeting only loopback55439/gateway_test_disabled_credential_round64, then run `npx vitest run tests/integration/snapshot-disabled-credential.test.ts --no-file-parallelism`. The test refuses production, other targets and raw query/fragment delimiters before destructive setup. Retained ignored OLD/GREEN artifacts are in `.test-artifacts/snapshot-disabled-credential-audit/`; the local fixture runner preserves earlier log names. Other commands are `npx vitest run src/lib/channels/local-snapshot-route.test.ts`, `npx tsc --noEmit --incremental false`, and the retained fixture's `node .test-artifacts/resilience/verify-connector.mjs`.

The native published fixture has an empty global model directory and one retained historical key; it does not prove new global model filtering. Published model loading and key mapping are unchanged source paths. The local profile separately proves its derived models disappear with its sole omitted Channel.

No Go, schema, dependency or deployment change is made. Prior Round59 native Go (91.225s), full Linux race (200.755s), vet/format and scoped minimum Go1.24.13 checks remain prior evidence, not new runs. Connectors still require a single Gateway instance, verified TLS in production and the existing live per-call authorization. This change does not revoke cached generations immediately or add a multi-instance transport.

The user requests stopping after this round. No further optimization round is started; final review, scoped commit and main/remote verification close this work.
