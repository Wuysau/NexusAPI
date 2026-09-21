# Independent credential enrollment

## Local desktop UI

For the nonproduction local desktop console, open **渠道管理 → 添加渠道**, select a supplier, enter its Base URL, API protocol, model ID and API Key, then save. The credential ID is generated automatically. Save does not call the provider; **测试连接（少量额度）** sends one minimal request. **替换 API Key** saves a new version without returning the previous key. These diagnostics do not claim gateway routing or billing settlement.

The local profile requires exact loopback `NEXUS_DESKTOP_ORIGIN`, authenticated administrator capabilities and CSRF. Normal Windows development startup configures the desktop origin. API keys are AES-256-GCM encrypted in credential records and local encrypted files. The random master key and encrypted files live under `~/.nexusapi/credentials` by default; `NEXUS_LOCAL_CREDENTIAL_DIR` overrides that directory. Keep this directory private and back it up together with the database; a lost master key cannot decrypt existing credentials. No plaintext key is persisted or returned by channel reads.

The same-host **development** Go gateway reads those files when launched with `NEXUS_LOCAL_CREDENTIAL_DIR` pointing at the same directory. No plaintext Control Plane endpoint is restored. Public providers use HTTPS; explicit RFC1918/loopback IP HTTP addresses are supported locally. Hostname DNS destinations are checked before dispatch, redirects are denied, and credentials are bound to the saved endpoint/protocol/model. Anthropic-compatible bases without a trailing `/v1` use `/v1/messages`; bases already ending `/v1` use `/messages`.

Vendor and protocol are independent: a Qwen channel may use Anthropic Messages. Channel metadata reaches signed snapshots; normal gateway catalog, downstream key and price/budget rules still apply. A successful connection diagnostic alone does not enable a model in the approved gateway catalog or create a billable record. Production refuses the local credential directory and retains the independent workflow below.

## Production independent workflow

Production keeps provider plaintext in an operator intake workload and the Go Gateway only. Next accepts `credentialId` references on channel creation; it does not accept `secret`, rotate plaintext, or resolve plaintext over HTTP. `/api/internal/gateway/credential` returns 410 in every environment without reading the body. Console rotation directs the operator to this workflow.

The Control Plane production environment requires `KMS_PROVIDER=vault` and an independent `SNAPSHOT_SIGNING_KEY` (at least 32 characters). The routing HMAC is not Vault authority or the operator Ed25519 registry signer. `UPSTREAM_ENCRYPTION_KEY`, either old production-local bypass, Vault credentials and registry private keys must not be mounted in CP. Startup rejects configured legacy wrapping keys and known crypto-identity variables. Mount/process isolation remains the deployment authority; application checks cannot constrain a host administrator.

## Operator intake and publication

Run these commands outside CP on an independently controlled machine/container. The encryptor token file is provisioned through its separate AppRole/Agent policy; it can encrypt the approved Transit resource/context, not decrypt or mint tokens. The registrar key file stays with the independent signing workload. Never pass plaintext, tokens or private keys in command arguments or environment values.

The request file has exactly these fields:

```json
{
  "tenant_id": "customer-tenant",
  "credential_id": "customer-credential",
  "credential_version": 1,
  "provider_id": "provider-id",
  "allowed_https_origins": ["https://api.example.com"],
  "vault": {"mount": "transit", "key": "nexus-provider-v1"}
}
```

The identity tuple and origins require customer/operator approval. The tenant/provider IDs must match the routing snapshot. Use the exact credential ID and version subsequently entered in the channel form. The channel API accepts optional `credentialVersion`, exports it as signed `credential_version`, and the Gateway selects that immutable version during N/N-1 overlap. Old channels without a version are accepted only when the registry has exactly one matching version. The secret file contains exact credential bytes; an editor-added newline becomes part of the credential.

```sh
node scripts/secret-enroll.mjs enroll --request-file request.json --secret-file /private/provider-secret --vault-url https://vault.example.com:8200 --vault-token-file /private/encryptor-token --vault-ca-file /private/vault-ca.pem --output entry.json
node scripts/secret-enroll.mjs sign --payload-file full-registry.json --signing-key-file /private/operator-ed25519.pem --signing-key-id operator-key-1 --output registry.json
```

Intake generates a random 32-byte DEK and 12-byte nonce, encrypts using AES-256-GCM, and wraps the DEK via TLS-verified Transit. Both operations use the UTF-8 encoding of the compact JSON array `["nexus.provider-credential.v1", tenant_id, credential_id, credential_version, provider_id]`, as implemented by `credentialContext` in `scripts/secret-enroll.mjs`. It refuses HTTP, redirects, unknown fields, noncanonical base64 and unapproved envelope shapes. Errors and stdout contain only operation status; the credential and token are not printed.

`full-registry.json` is a **complete** payload with `format: nexus.secret-registry.payload.v1`, configured `registry_id`, strictly increasing `registry_version`, nondecreasing `revocation_epoch`, RFC3339 `issued_at`/`expires_at`, and an `entries` array of enrolled entries. Issue at or before current time; lifetime must be positive and no more than 60 seconds. Publish a fresh complete payload every 15 seconds through the independent registrar. Omission revokes, so never replace the full registry with an enrollment fragment. The sign command validates strict UTF-8, duplicate keys, safe integer values, exact context, tuple uniqueness, origin normalization and freshness, then signs the exact original payload bytes, including whitespace. Reformatting requires a new signature and version. Output replacement is atomic.

An independently provisioned trust file maps operator key IDs to base64 raw 32-byte Ed25519 public keys. The Gateway also receives a persistent floor file containing `registry_id`, `registry_version`, `revocation_epoch` and, after first acceptance, `payload_sha256`. Bootstrap floors and trust roots are operator controlled; they cannot come from CP. Preserve the state directory across restarts and restores. Never reset floors to replay an old registry.

## Mounts and rollout

Production Compose requires the Gateway-only paths `GATEWAY_IDENTITY_DIR` (Agent sink named `token`), `VAULT_CA_PATH`, `SECRET_REGISTRY_DIR` (publication named `registry.json`), `SECRET_REGISTRY_TRUST_PATH`, and `SECRET_REGISTRY_STATE_DIR`, plus `VAULT_ADDR`, `SECRET_REGISTRY_ID`, `SECRET_VAULT_RESOURCES` and `SECRET_ALLOWED_ORIGINS`. The state directory must be writable by Gateway UID 1001; keys/token/trust/registry mounts are read-only to Gateway. CP, Worker and Budget mount none of these resources. The signing private key and encryptor identity are absent from every application container. An external Vault Agent renews the Gateway-specific token sink; CP cannot access the issuer or Agent control socket. Compose uses directory mounts for token renewal and atomic registry publication so new file inodes are visible. Trust/CA replacement requires a controlled remount or restart; an expired old registry fails closed.

Publish an approved registry and provision its floors before enabling traffic. Register the matching opaque credential ID in the console; registration alone conveys no provider authority. The Gateway checks operator signature, tenant/provider tuple, immutable deployment resources/origins, freshness and rollback state before decrypt/dispatch.

Keep old local ciphertext, wrapped DEKs and backups unchanged. Existing `v1:...` envelopes are not silently accepted as Vault envelopes or decrypted by CP. A separately authorized legacy migration workload with custody of the old wrapping key must export/re-enroll into new immutable credential IDs and publish operator-approved entries; the CLI deliberately has no old-key unwrap mode. Verify destination, identity and counts before switching channel references. Existing channel references can remain disabled while their new enrollment is published. Production rollback disables affected ingress or restores a compatible real-Vault Gateway; it never restores CP plaintext routes, old wrapping mounts or local KMS flags.

Development-only `LocalKms` and `createCredential`/`rotateCredential` helpers remain for historical isolated test fixtures. They reject production and do not enable a browser onboarding path or any role-string unwrap. Dev routing can use an explicit `SNAPSHOT_SIGNING_KEY`; the old wrapping key is a dev-only routing compatibility fallback. New deployment tests should use the independent signing variable.

## Evidence boundaries

For the local desktop profile, `npm run gateway:local` starts the Go Gateway and usage Worker alongside the existing Web/Observer process. Supply the same `DATABASE_URL`, `SNAPSHOT_SIGNING_KEY`, `GATEWAY_INTERNAL_TOKEN`, and `NEXUS_DESKTOP_ORIGIN` used by the console, plus the local `REDIS_URL`. Existing environment variables take precedence over environment files. Default Gateway listener is `127.0.0.1:8080`; the encrypted credential directory defaults to `~/.nexusapi/credentials`. Neither launcher runs seeds or migrations. Apply reviewed forward migrations through the canonical runner before startup. Both NODE_ENV=production and GATEWAY_ENV=production are rejected.

Local enabled owned channels supply their tenant's signed model configuration without official prices. New UI channels receive a scoped owned connection automatically; prior local channels can be linked with authenticated `POST /api/channels/{id}/gateway`. Test the chain using a short-lived Nexus key and `/v1/models`, then a minimal `/v1/chat/completions` request. Correlate its x-request-id with logs and canonical usage, then revoke the test key. Unknown price leads to reconciliation without a wallet debit; successful HTTP alone does not establish priced settlement.

`node scripts/verify-secret-plane-runtime.mjs` exercises real isolated TLS/AppRole policy behavior. `node scripts/verify-secret-plane-enrollment.mjs` exercises this Node intake against that Vault, actual Gateway-principal unwrap, AES-GCM context, and independent raw-byte signatures. Unit/schema tests alone do not establish IAM isolation. Production host isolation, CA/Agent operation, availability and durable recovery must be checked in the deployed environment.
