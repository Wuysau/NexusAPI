# Validate current connector eligibility before consuming a pairing token

## Source and current gap

[Vault v1.18.5 AppRole login](https://github.com/hashicorp/vault/blob/v1.18.5/builtin/credential/approle/path_login.go#L117-L143) resolves the current role before its later finite-use SecretID consumption. NexusAPI can apply that narrow ordering principle to its own one-use pairing flow. This is a design reference; no licensed implementation is copied and no dependency is added. Vault is not claimed to validate every later condition before consumption.

The existing configure operation checks the bound active, unarchived project. Pairing currently checks the token and unrevoked local connection, then consumes the token and creates/rotates the identity. Its lease endpoint additionally requires a bound active, unarchived project and an active, non-deleted organization. Source therefore predicts that a token issued before project archive/unbinding or organization suspension can yield a successful pairing response followed by an immediate lease refusal. This is an onboarding consistency problem; execution authorization already refuses the unavailable context. Native OLD proof is required before implementation.

## Minimal design and ownership

Join the current bound project and organization in the existing locked pairing lookup, with the same tenant and active/archive/deletion predicates as lease renewal. Preserve the token format/hash, expiry, one-use transaction, connection/pairing locks, stable identity ID and fixed unauthorized error. Ineligible lookups must make no pairing/identity/lease change. Restoring the context before the original token expires permits its first successful use. Existing revocation and execution checks remain separate authorities; no heartbeat, inference, price or settlement fact is added.

Independent read-only design review is clear. This observes eligibility at the lookup statement; it does not serialize concurrent project archive or organization changes. Connection rebinding and revocation already lock the connection row, and the existing connection/pairing locks remain. No extra project/organization lock or token binding schema is needed. Later renewal and execution authorization continue to check current eligibility.

The agent owns only new tests/integration/connector-pairing-eligibility.test.ts and ignored fixture artifacts. Root owns production, documents, verification and Git. All DB work targets only explicit query/fragment-free loopback port55439 database connector_test_pair_eligibility_round61, or the already-verified serial CI fixture convergence_ci15. Prove current_database before reset and apply all 28 canonical migrations. Use actual fresh console sessions/CSRF and native configure/pair/lease routes; no mocked auth or state. Keep tokens, identities, queries and complete fact comparisons in memory and print only fixed booleans/counts.

## Characterization and verification

Issue an actual one-use token, change the project/organization state, then call pairing. Record the actual OLD response and fact effects; when OLD succeeds, verify renewal rejects. Desired behavior is fixed 401 with no changed facts. Cover archive/unbinding/inactive project and inactive/deleted organization, recovery with the same original token, active pairing/lease, concurrent single consumption, expired/wrong/revoked tokens and stable identity rotation. Preserve OLD artifacts and close all pools, clients and processes before handing the DB back.

After the minimal patch, rerun the unchanged formal native test, related TypeScript unit/contracts and fresh compilation/static checks. Run the actual nineteen-scenario separate-process private-TLS connector regression. No Go or migration changes are planned; retain explicit previous native/race/vet and scoped minimum-Go evidence rather than relabeling it as new validation. Review exact completed paths and commit them separately from future work.

## Actual OLD and implemented result

The stable native OLD run has exactly five expected failures and three passing controls (Vitest 6.46s, runner 7.00s). Each unavailable context accepts pairing with 200, consumes the token, changes the existing identity hash and clears its revocation. The actual lease endpoint immediately refuses with 401, and restoring the context does not recover the consumed original token. Lease and audit facts remain unchanged; only the pairing and identity facts change. Archive/unbinding and their recovery use actual management PATCH endpoints; project/organization inactive and organization deleted cases use explicit fixture SQL.

The production change adds the two tenant-matched project/organization joins and existing renewal eligibility predicates to the pairing lookup. The unchanged native test now passes all eight cases (7.35s, runner 7.73s). Unavailable contexts return the fixed 401 without any fact change or credential; restoring each context allows the original token to pair and lease once, retaining the historical identity ID. Normal pairing, actual concurrent single consumption, wrong/expired tokens and actual DELETE revocation remain valid controls. Historical opaque accounting credentials stay unchanged and success audits are not invented. These tests do not execute a model or establish financial settlement. Owned processes, pool and inspection clients close; activeOtherSessions is zero.

Run with an explicitly supplied guard-matching DATABASE_URL for a pre-created disposable database:

```sh
npx vitest run tests/integration/connector-pairing-eligibility.test.ts --no-file-parallelism
npx tsc --noEmit --incremental false
```

The fixture proves current_database before resetting and applies all 28 canonical migrations. Plaintext pairing, identity, lease and API credentials remain in memory; fact comparisons and assertions print fixed booleans/counts rather than private rows or hashes. Related 146 TypeScript unit/contracts pass in 3.12s; fresh compilation, scoped ESLint, formatting and diff checks pass.

The actual separate-process private-TLS connector suite passes all nineteen scenarios in 26.09s, including discovery, normal/streaming forwarding and attribution. All clients/processes close. No Go or migration change occurred; Round59's full native/race/vet and scoped minimum-Go results remain the applicable prior evidence. The single-Gateway transport limit is unchanged.

Independent read-only review of the exact five commit paths is clear. Secret scanning and diff checks pass. Future project-key work and the ignored local handoff stay outside this commit; integration uses explicit paths and the automatic separate-main-worktree merge/push hook.
