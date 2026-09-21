// Independent operator fixture; never imported into Control Plane.
//
// AC5 recovery drill: mint both supported legacy ciphertext formats, back up
// the encrypted files, remove originals, restore and reenroll through Vault via
// runLegacySecretMigration, and emit a separate signed registry + signed
// migration proofs. The sibling Go subtest then resolves the migrated registry
// with the real Gateway identity and confirms the canary is restored — proving
// the legacy-ciphertext -> external-registry migration is recoverable end to
// end. No plaintext, DEK or canary is written to receipts or stdout.
import { createHash, generateKeyPairSync, randomBytes, scryptSync, createCipheriv } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile, unlink, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { enrollCredential } from './secret-enroll.mjs'
import {
  runLegacySecretMigration,
  verifyMigrationProof,
  legacySourceDigest,
  entryDigest,
  payloadDigest,
} from './migrate-legacy-secrets.mjs'

const root = resolve('.test-artifacts/vault-reference'),
  output = resolve(root, 'runtime', 'legacy-migration')

const SCRYPT_SALT = 'nexusapi-upstream-key-salt'
const FIXTURE_PASSPHRASE = 'fixture-legacy-upstream-key'
const FIXTURE_MASTER = 'fixture-legacy-kms-master'

function mintVersionedScrypt(plaintext, passphrase = FIXTURE_PASSPHRASE, dek) {
  const key = dek ?? scryptSync(passphrase, SCRYPT_SALT, 32, { N: 1 << 14, r: 8, p: 1 })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`
}

async function main() {
  await mkdir(output, { recursive: true })
  const encryptorTokenFile = resolve(root, 'identity', 'encryptor-token')
  const caFile = resolve(root, 'tls', 'ca.pem')
  const canary = await readFile(resolve(root, 'runtime', 'expected-canary'))
  if (!canary || canary.length < 1) throw new Error('Fixture canary unavailable')
  try {
    const ciphertext = mintVersionedScrypt(canary)
    const fingerprint = createHash('sha256').update(canary).digest('hex').slice(0, 32)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const signingKey = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const signingKeyId = 'fixture-migration-operator'
    const trust = {
      [signingKeyId]: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    }
    let records = [1, 2].map((version) => ({
      source_table: 'relay_channels',
      source_id: `legacy-channel-${version}`,
      tenant_id: 'fixture-tenant',
      provider_id: 'fixture-provider',
      credential_id: 'fixture-credential',
      credential_version: version,
      format: 'versioned-scrypt-v1',
      key_version: 1,
      ciphertext,
      fingerprint,
    }))
    const dek = randomBytes(32)
    records[1].format = 'local-envelope-v1'
    records[1].ciphertext = mintVersionedScrypt(canary, undefined, dek)
    records[1].encrypted_data_key = mintVersionedScrypt(
      Buffer.from(dek.toString('hex')),
      `${FIXTURE_MASTER}|nexus-kms|v1`,
    )
    dek.fill(0)
    // Exercise actual disk backup and restoration of encrypted source records.
    // This deliberately does not claim a Vault storage/HA backup restore.
    const sourceFile = resolve(output, 'source-encrypted.json')
    const backupFile = resolve(output, 'backup-encrypted.json')
    await writeFile(sourceFile, JSON.stringify(records), { mode: 0o600 })
    const backupDigest = createHash('sha256')
      .update(await readFile(sourceFile))
      .digest('hex')
    await copyFile(sourceFile, backupFile)
    await unlink(sourceFile)
    records = null
    try {
      await access(sourceFile)
      throw new Error('Source was not removed')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await copyFile(backupFile, sourceFile)
    const restoredBytes = await readFile(sourceFile)
    if (createHash('sha256').update(restoredBytes).digest('hex') !== backupDigest)
      throw new Error('Restored ciphertext backup digest mismatch')
    records = JSON.parse(restoredBytes.toString('utf8'))
    const enroll = async ({ request, secret }) =>
      enrollCredential({
        request,
        secret,
        vaultUrl: 'https://127.0.0.1:58201',
        vaultTokenFile: encryptorTokenFile,
        vaultCaFile: caFile,
      })
    const { signedRegistry, proofs } = await runLegacySecretMigration({
      manifest: {
        namespace: 'fixture-legacy',
        registry_id: 'fixture-registry',
        registry_version: 1,
        revocation_epoch: 0,
        allowed_https_origins: ['https://api.example.com'],
        vault: { mount: 'transit', key: 'nexus-provider-v1' },
        records,
      },
      keyPassphrase: FIXTURE_PASSPHRASE,
      kmsMaster: FIXTURE_MASTER,
      enroll,
      signingKey,
      signingKeyId,
      now: Date.now(),
    })
    // Verify real restored sources and actual target payload/entry bytes.
    const payloadBytes = Buffer.from(signedRegistry.payload_base64, 'base64')
    const entries = JSON.parse(payloadBytes.toString('utf8')).entries
    for (let i = 0; i < proofs.length; i++) {
      const record = records[i]
      verifyMigrationProof({
        proof: proofs[i],
        trust,
        recomputedEntryDigest: entryDigest(entries[i]),
        recomputedPayloadDigest: payloadDigest(payloadBytes),
        expectedSource: {
          namespace: 'fixture-legacy',
          table: record.source_table,
          id: record.source_id,
          ciphertext_digest: legacySourceDigest(record.ciphertext),
          source_format: record.format,
          source_key_version: record.key_version,
          ...(record.encrypted_data_key ? { wrapped_dek_digest: legacySourceDigest(record.encrypted_data_key) } : {}),
        },
      })
    }
    await writeFile(resolve(output, 'registry.json'), JSON.stringify(signedRegistry), { mode: 0o600 })
    await writeFile(resolve(output, 'trust.json'), JSON.stringify(trust), { mode: 0o600 })
    await writeFile(
      resolve(output, 'floor.json'),
      JSON.stringify({ registry_id: 'fixture-registry', registry_version: 1, revocation_epoch: 0 }),
      { mode: 0o600 },
    )
    const receipt = {
      format: 'nexus.legacy-secret-migration.fixture.v1',
      recordedAt: new Date().toISOString(),
      checks: {
        legacy_scrypt_ciphertext_decrypted_in_operator_memory: 'passed',
        legacy_local_envelope_decrypted_in_operator_memory: 'passed',
        encrypted_source_backup_copied_original_removed_restored_digest_verified: 'passed',
        real_vault_transit_enroll_of_recovered_plaintext: 'passed',
        signed_migration_proofs_verify_under_trust: 'passed',
        source_digest_matches_importer_algorithm: 'passed',
        signed_registry_emitted_for_gateway_resolution: 'passed',
      },
      checksPassed: 7,
      restoredRecordCount: records.length,
      restoredFormats: records.map((r) => r.format),
      backupCiphertextDigest: backupDigest,
      credentialVersions: [1, 2],
      limitations: [
        'Local operator fixture; no production signer custody assertion',
        'Restores legacy encrypted source backup, not Vault server storage or production HA',
        'Signed registry expires after 60 seconds; regenerate immediately before Go resolution',
        'Canary retained only in ignored private fixture input; never in receipts or stdout',
      ],
    }
    await writeFile(resolve(root, 'legacy-migration-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    canary.fill(0)
  }
}
main().catch(() => {
  console.error('Legacy secret migration fixture failed; sensitive diagnostics suppressed')
  process.exitCode = 1
})
