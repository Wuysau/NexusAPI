# Credential rotation runbook

Use the procedure for the credential’s owner. Keep credentials in private input/storage; record resource IDs, versions and audit outcomes in the change record.

| Credential | Owner and supported operation |
|---|---|
| Downstream project API Key | Console/API key management |
| Local desktop provider key | Desktop Channel credential replacement |
| Production provider key | Independent enrollment and signed registry publication |
| Vault Transit encryption key | Independent Vault operator rotation and recovery policy |
| Internal service token | Coordinated configuration of its specific consumers |

The former `scripts/ops/rotate-key.sh` entry point is retired and exits with an unsupported diagnostic. Production credential rotation follows the procedures below. `/api/health` checks PostgreSQL reachability with `SELECT 1`; successful health alone establishes no credential rotation or decryption result.

## Downstream API Keys

1. Create a replacement in **API Keys**, or through authenticated `POST /api/keys` with CSRF, the intended `projectId`, scopes and expiry. Project-bound creation requires current project access. The plaintext is returned once; save it in the client’s private secret storage.
2. Configure a client with the replacement. Verify the intended model catalog and an approved Gateway call, including attribution and applicable usage. A model list alone establishes no inference result.
3. Revoke the old key through **Revoke** or authenticated `DELETE /api/keys/{id}` with CSRF. Terminal revocation requires console authentication within the existing 15-minute window; reauthenticate when requested.
4. Verify the saved revoked status and `apikey.revoked` audit for the expected key ID. Confirm new Gateway requests using the old key are refused and the replacement still works.

`PATCH /api/keys/{id}` with `enabled: false` is reversible suspension; DELETE is terminal revocation. The authoritative table is `downstream_api_keys`. Direct SQL changes bypass the management operation’s audit and cache invalidation.

Propagation depends on Gateway refresh configuration, signed generation expiry and successful refreshes. Cached snapshots can remain usable during a failed refresh until their applicable expiry. Observe the deployed Gateway’s acceptance/refusal; this runbook specifies no measured p99 bound. Live local-connector authorization additionally checks the key on each new call. In-progress requests may have already executed or incurred usage.

## Provider credentials

### Local desktop

Use **渠道管理 → 替换 API Key** in the supported desktop profile. The corresponding authenticated, CSRF-protected `PATCH /api/channels/{id}` with `secret` requires recent authentication and the configured desktop host/origin. Follow [independent-secret-enrollment.md](./independent-secret-enrollment.md#local-desktop-ui) for private encrypted-file storage and backup requirements.

Verify a configured model through the Channel diagnostic and the intended project-key Gateway call. The diagnostic uses a small provider request and does not prove signed routing publication or settlement. Confirm the credential rotation audit and selected version/reference. Local connector Ollama credentials remain in the user’s local configuration; the Channel’s opaque accounting credential is not an Ollama key. See [local-connector.md](./local-connector.md).

### Production

Follow [independent enrollment and publication](./independent-secret-enrollment.md#operator-intake-and-publication). Keep provider plaintext, Vault credentials and registry signing authority outside CP. Production Channel creation accepts approved opaque `credentialId` and `credentialVersion` references; it does not accept provider plaintext or perform replacement encryption.

Enroll the approved new immutable credential identity/version, publish a complete signed registry with the existing freshness/floor rules, and configure the matching Channel reference. Preserve unrelated entries: omission from the complete registry revokes an entry. The documented N/N-1 overlap can keep reviewed versions available during a planned transition. Verify actual Gateway dispatch against the new tuple before withdrawing old authority.

The authoritative credential table is `provider_credentials`, with `enabled` status. A temporary Channel pause preserves its credential. Channel DELETE disables the associated credential and can affect Channels sharing that reference; identify those references before withdrawal. Registration or DB status alone does not establish independent Vault/registry authority.

## Vault Transit key versions

An independently authorized Vault operator rotates the named Transit key under the deployment’s policy. [Vault v1.18.5’s rotation contract](https://github.com/hashicorp/vault/blob/v1.18.5/builtin/logical/transit/path_rotate.go#L84-L89) uses the new version for new encryption while supporting decryption of older versions. Rotation, rewrapping existing data and retiring old decryption versions are separate operations.

Verify approved new enrollment/encryption, actual Gateway decryption/dispatch and recovery of retained ciphertext/backups. Retain old decryption authority until the deployment’s live and recovery requirements are met. NexusAPI has no production CP bulk-rewrap procedure; changing `KMS_KEY_VERSION` does not rotate current production credentials or the desktop credential-file master key. The variable remains part of a development legacy helper. Production CP rejects encryption/decryption; `/api/internal/gateway/credential` returns 410.

## Compatibility and internal tokens

`ADMIN_TOKEN` remains a required production configuration value. Current console authentication uses sessions and capabilities; `/api/admin` is retired with 410. Updating this value does not rotate console sessions or restore the legacy API. Update the configured compatibility value through the deployment’s secret mechanism when necessary.

`GATEWAY_INTERNAL_TOKEN` authenticates Gateway-to-CP snapshot and connector authorization calls. Coordinate its replacement in the CP and Gateway configurations through the deployment rollout. There is no previous-token overlap. Observe successful fresh snapshot acquisition and applicable live connector authorization after rollout; cached generations do not prove the new token works. Coordinate traffic/availability during the transition rather than assuming restart order guarantees uninterrupted access.

The independent Budget service uses `BUDGET_SERVICE_TOKEN`; its reservation calls are a separate credential boundary. CP reserve/settle endpoints are retired. Verify affected Budget operations when rotating that token, using its own deployment procedure. Keep the snapshot signing key, operator registry signer and Vault identities independently managed.
