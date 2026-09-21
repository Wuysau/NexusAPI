# Key Rotation Runbook

## Scope

This covers:
- NexusAPI downstream keys (`sk-nx-...`).
- Upstream provider credentials (stored encrypted, KMS envelope).
- The KMS master key itself.
- `ADMIN_TOKEN` and `GATEWAY_INTERNAL_TOKEN`.

## Downstream key rotation

1. Revoke the key: `UPDATE api_keys SET enabled = false WHERE id = $1`.
2. The revocation epoch propagates to the gateway via the snapshot refresh
   (p99 < 60s). A request using the revoked key fails within that window.
3. Issue a replacement key if needed.
4. Audit: the revocation is recorded in `audit_events` with action
   `apikey.revoked`.

## Upstream credential rotation

1. Create a new credential record via the control plane (`POST /api/channels`).
   The new credential is encrypted with the current KMS version.
2. Disable the old credential: `UPDATE channel_credentials SET disabled = true`.
3. Verify the new credential works (gateway health check).
4. The old credential's epoch propagates via the snapshot. The gateway stops
   using it within the refresh window.
5. Audit: `credential.rotated` is recorded.

## KMS master key rotation

1. Provision a new KMS key version (`KMS_KEY_VERSION` + 1).
2. Re-encrypt all credential DEKs with the new master key. The envelope
   module supports versioned decryption: old envelopes decrypt with the old
   version, new envelopes with the new.
3. Deploy with the new `KMS_KEY_VERSION`.
4. Verify: a request using a credential that was re-encrypted succeeds.
5. After a verification period, retire the old KMS version.

## ADMIN_TOKEN rotation

1. Set the new `ADMIN_TOKEN` in the environment (secrets manager).
2. Restart the application.
3. The old token immediately stops working (fail-closed comparison).

## GATEWAY_INTERNAL_TOKEN rotation

1. Set the new token in both the app and gateway environments.
2. Restart the gateway first (it will fail closed until the app is updated,
   then succeed).
3. Restart the app.
4. Verify: the gateway can fetch snapshots and call reserve/settle.
