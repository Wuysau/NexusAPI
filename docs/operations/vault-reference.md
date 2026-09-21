# Vault reference Secret Plane

This document describes the independent Vault Secret Plane and its disposable verification fixtures. Production deployment additionally requires verification of workload isolation, identity bootstrap, registry distribution, outbound enforcement and recovery.

## Verification scope

Use the executable TLS/AppRole fixture below to verify the current revision against an isolated Vault instance. Fixture checks cover policy separation, cryptographic context, rotation and identity denial. They do not establish production availability, issuer custody or deployment isolation. Keep administrator, unseal and runtime-token files outside source control and published artifacts.

## Concrete reference deployment plan

Deploy Vault within the customer trust domain, with independently managed TLS and persistent encrypted storage/recovery. The selected minimal model uses separate customer intake, operator registry signer, Gateway plus Vault Agent, and CP identities. CP needs neither a Vault token nor network access to Vault. Encryptor gets only the exact configured Transit encrypt resource and approved required context; Gateway gets only decrypt for that resource/context. Explicitly constrain request parameters and forbid batch input, key management, export and identity minting. Rotation/rewrap is a temporary operator role. Context-specific policies must be updated by the independent operator when authorizing new immutable credential versions.

The proposed resource identifiers are deployment inputs, not discovered production resources: select one approved Transit mount and per-tenant key names matching the schema, create derived `aes256-gcm96` keys, and forbid export/plaintext backup. Signed records cannot change the independent mount/key allowlist. Application AEAD and Transit use identical UTF-8 bytes from the compact JSON array `["nexus.provider-credential.v1", tenant_id, credential_id, credential_version, provider_id]`; see `credentialContext` in `scripts/secret-enroll.mjs`.

Use Vault Agent AppRole login with independently delivered RoleID and response-wrapped single-use short-lived SecretID. Agent renews bounded tokens into a Gateway-private memory-backed file; resolver configuration contains a path, never token text. Give CP no access to the sink, SecretID, deployment account, Vault role management or Agent namespace. Certificate auth is an explicit alternate design using an independent workload CA and exact Gateway identity constraints, not a fallback after AppRole failure. Do not make a shared CA sufficient without identity restrictions.

Mount the operator Ed25519 public trust set read-only in Gateway; keep signing private keys only in independently operated registrar storage. An operator-owned registry publisher refreshes signed complete snapshots every 15 seconds with <=60-second validity. Transport may be untrusted because Gateway authenticates original payload bytes. Persist version/epoch/digest floors outside CP access, provision a trusted minimum floor on startup and prevent restore rollback. No valid snapshot means no dispatch. Do not embed plaintext or identity material in image layers, snapshots, command arguments, logs or browser replies.

Gateway unwraps only after signature/schema/context/freshness checks and sends Authorization only to the exact independently approved HTTPS origin. Disable redirects and unapproved proxies; enforce DNS/address/TLS policy at the actual connection. No generic plaintext response endpoint is introduced. CP onboarding accepts only signed opaque registrations; existing plaintext onboarding/unwrap routes must be removed or disabled.

## Reproducible validation and evidence handoff

Current design checks, from repository root:

```sh
npx vitest run tests/contract/secret-registry.test.ts
npm run typecheck
npm run lint
```

The contract suite checks strict outer/payload schemas, required identity/crypto/freshness fields, unsafe origin shapes and unknown/plaintext metadata rejection. It does not execute a signer, resolver, Vault request or identity bootstrap. Run the runtime integration command below to verify those boundaries.

The runtime integration fixture requires these inputs: explicitly disposable trust domain/resource, independent CP/encryptor/Gateway execution contexts, TLS CA and Vault endpoint, Gateway-only Agent token-file mount, operator public trust set, signed registry source plus durable floor directory, and an authorized provider fixture with a separate exfiltration sink. Obtain workload credentials through the real selected auth method. Missing prerequisites fail nonzero; do not silently skip or run all cases under one administrator.

Exercise identity mint/read/mount denial, raw-byte signature and malformed JSON cases, destination tampering/redirect/DNS attacks, warmed-cache revocation with lost refresh, restart/restore anti-rollback, outage/local-bypass denial, key rotation and N/N-1 restore. The verification commands below cover parts of this matrix; validate deployment-specific boundaries separately. Record exact command, revision, image/policy digests, nonsecret principal names, allow/deny status/counts, cache timing and cleanup. Never retain plaintext canaries, raw DEKs or token values in receipts.

## Release and recovery

Production readiness additionally requires TLS validation, operator trust-root ownership, durable storage backups and restore rehearsal, audit retention, issuer recovery, resource limits and the actual availability/HA plan. A single-node loopback fixture satisfies none of those deployment gates. Rollback disables affected ingress or restores a compatible real-Vault Gateway, retaining ledger and ciphertext history and monotonic revocation floors. Never restore CP decryption, LocalKms or shared wrapping/snapshot authority. Revoke old Transit versions or delete ciphertext only after recovery/compatibility retention has been proven.

Provider behavior references: [Transit API](https://developer.hashicorp.com/vault/api-docs/secret/transit), [AppRole authentication](https://developer.hashicorp.com/vault/docs/auth/approle), [certificate authentication](https://developer.hashicorp.com/vault/docs/auth/cert).

## Executable TLS and AppRole fixture

From the repository root, run `node scripts/verify-secret-plane.mjs`. Docker, Go and the pinned Vault image are required; missing prerequisites fail nonzero. This creates a separate non-dev `nexus-vault-tls-convergence` instance on `https://127.0.0.1:58201`. `infra/vault-reference/certificates.go` creates a private, 24-hour disposable CA/server certificate; TLS verification is enabled. The fixture uses manual initialization/unseal and a single-node file backend. It is not a production deployment command.

The executable checks separate encryptor, Gateway, CP and temporary rotation AppRole logins. Each role has a 60-second, single-use SecretID delivered through a 60-second response-wrapping token, with a bounded 30-minute workload token. Reusing either wrapping token or SecretID is refused. Real encryptor/decryptor policy tests include identity mint, key export/rotation, batch and context bypass, CP policy alteration, and CP identity access denial. The rotation-only principal cannot decrypt or mint identities; its token is revoked immediately after rotation. Rotation preserves old ciphertext while new encryption uses the next Transit key version; an explicitly revoked Gateway token cannot decrypt.

An actual Vault Agent container performs an additional Gateway auto-auth login from its own wrapped SecretID. It writes its token into a private `/run/identity` tmpfs directory (0700) with a 0600 token file. A separate unprivileged UID in that container cannot read it. The Agent bootstrap bind contains only its RoleID, wrapped SecretID, CA and configuration; it has no admin custody or Docker socket mount. A separate read-only, capability-free synthetic CP container with no network has no identity or Docker mount. This last check proves the fixture's process/mount arrangement, not arbitrary production CP deployment containment.

The redacted receipt is `.test-artifacts/vault-reference/approle-tls-receipt.json`. Checks include trusted TLS, wrong-server-name/unknown-CA refusal, real AppRole/Agent bootstrap, ACL separation, rotation and token revocation. The receipt contains revision, pinned image digest, policy digests, check counts and explicit limitations; it contains no token, canary, raw DEK, unseal material or private key. The command also checks Vault/Agent output for the synthetic canary and current tokens. Browser/provider capture and signed-registry/egress/cache timing require the separate runtime integration suite.

Ignored custody remains under `.test-artifacts/vault-reference`: TLS/manual-unseal administration in `tls`, bootstrap material in `gateway-agent`, and workload token copies in `identity`. The operator copies the Agent token out only to support the separate local Go integration process. This host copy is a fixture accommodation, not the proposed production memory-only delivery model. Do not mount any of these directories into CP, commit them, print them or reuse them for deployment.

The live integration inputs are `VAULT_ADDR=https://127.0.0.1:58201`, `VAULT_CA_FILE=<absolute fixture>/tls/ca.pem` and `VAULT_TOKEN_FILE=<absolute fixture>/identity/gateway-token`; intake uses `identity/encryptor-token` instead. The approved resource is `transit/nexus-provider-v1`. Contexts authorize only tenant `fixture-tenant`, credential `fixture-credential`, provider `fixture-provider`, and immutable versions 1 and 2 using the accepted compact tuple format. Files contain credentials and are read by the workloads; token values must never appear in command arguments or evidence.

Rerunning replaces only the named disposable Agent and issues fresh bounded tokens, preserving Vault file storage and historical key versions. The script does not remove persistent volumes or perform destructive key cleanup. The test CA expires after 24 hours; an expired/missing TLS fixture fails closed and requires an operator-reviewed fixture reset or certificate renewal. Long-duration Agent renewal, reissuance after token expiry, durable recovery, production issuer custody and HA remain deployment checks. Host administrator/Docker authority is outside the fixture CP threat boundary.

After identity provisioning, `node scripts/verify-secret-plane-enrollment.mjs` executes the independent intake module against the real TLS Vault encryptor principal, unwraps with the actual Agent-issued Gateway identity, verifies the AES-GCM/context round trip, and signs/verifies raw registry bytes with a separate ephemeral Ed25519 operator key. The command writes a redacted `enrollment-receipt.json` beside the identity receipt. It generates `runtime/registry.json`, `runtime/trust.json`, `runtime/floor.json` and a private `runtime/expected-canary` for immediate cross-language Go verification. These are ignored test inputs, not production registration files. Regenerate immediately before the Go test because the registry expires after 60 seconds; never print or attach the canary file. This module-level envelope round trip does not itself prove the Go dispatch path, browser capture or anti-rollback behavior.

The combined gate is `node scripts/verify-secret-plane-runtime.mjs`. It runs both fixture commands and immediately invokes the required Go `TestVaultRealIdentity` with the `vaultintegration` build tag. This test verifies the actual Go resolver against the TLS Vault Agent identity and checks incorrect tenant/credential/provider and denied identity failures. The wrapper reports the identity, enrollment and Go test counts for the current run. The wrapper refuses missing or skipped Go tests and suppresses raw subprocess diagnostics that could contain sensitive data. It writes only parsed redacted JSON receipts into `.test-artifacts/ci/secret-plane-{identity,enrollment,runtime}.json`; the custody/runtime input directories are never copied there. The entry point uses cross-platform Node, Docker and Go operations; each execution environment must produce its own successful receipt.
