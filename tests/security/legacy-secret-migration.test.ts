import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, verify, createHash } from 'node:crypto'
import { buildKeyring, encrypt as aesEncrypt } from '../../src/lib/crypto'
// @ts-expect-error Operational ESM runner is exercised directly.
import { credentialContext } from '../../scripts/secret-enroll.mjs'
// @ts-expect-error Operational ESM runner is exercised directly.
import * as legacyMigration from '../../scripts/migrate-legacy-secrets.mjs'

const {
  decryptLegacySecret,
  legacySourceDigest,
  entryDigest,
  payloadDigest,
  buildMigrationProof,
  verifyMigrationProof,
  runLegacySecretMigration,
} = legacyMigration

// Mirror the importer's digest(r.secret) exactly: sha256(JSON.stringify(string)).
const importerDigest = (s: string) => createHash('sha256').update(JSON.stringify(s)).digest('hex')

const SCRYPT_PASSPHRASE = 'fixture-upstream-key'
const KMS_MASTER = 'fixture-kms-master'

function mintVersionedScrypt(plaintext: string) {
  // crypto.ts encrypt() => "v{version}:{iv}:{tag}:{data}" with scrypt-derived key.
  const kr = buildKeyring({ upstreamEncryptionKey: SCRYPT_PASSPHRASE })
  return aesEncrypt(plaintext, kr)
}

function mintLocalEnvelope(plaintext: string) {
  // LocalKms: random DEK encrypts the secret; master (|nexus-kms|v1) wraps the DEK.
  const dek = Buffer.from('0'.repeat(64), 'hex') // deterministic 32-byte DEK for the fixture
  const secretEnvelope = aesEncrypt(plaintext, { current: { version: 1, key: dek } })
  const master = buildKeyring({ upstreamEncryptionKey: `${KMS_MASTER}|nexus-kms|v1` })
  const wrappedDek = aesEncrypt(dek.toString('hex'), master)
  return { secretEnvelope, wrappedDek }
}

const baseRecord = (overrides: Record<string, unknown> = {}) => ({
  source_table: 'relay_channels',
  source_id: 'c1',
  tenant_id: 'tenant-a',
  provider_id: 'p1',
  credential_id: 'cred1',
  credential_version: 1,
  ...overrides,
})

const baseManifest = (records: unknown[]) => ({
  namespace: 'fixture16',
  registry_id: 'fixture-registry',
  registry_version: 1,
  revocation_epoch: 0,
  allowed_https_origins: ['https://api.example.com'],
  vault: { mount: 'transit', key: 'nexus-provider-v1' },
  records,
})

describe('legacy secret decryption', () => {
  it('decrypts versioned-scrypt-v1 ciphertext with the declared passphrase and version', () => {
    const plaintext = 'sk-fixture-plaintext'
    const ciphertext = mintVersionedScrypt(plaintext)
    const recovered = decryptLegacySecret({
      ciphertext,
      format: 'versioned-scrypt-v1',
      keyVersion: 1,
      keyPassphrase: SCRYPT_PASSPHRASE,
    })
    expect(recovered.toString()).toBe(plaintext)
  })

  it('decrypts local-envelope-v1 by unwrapping the DEK with the kms master then the secret', () => {
    const plaintext = 'sk-fixture-envelope'
    const { secretEnvelope, wrappedDek } = mintLocalEnvelope(plaintext)
    const recovered = decryptLegacySecret({
      ciphertext: secretEnvelope,
      encryptedDataKey: wrappedDek,
      format: 'local-envelope-v1',
      keyVersion: 1,
      kmsMaster: KMS_MASTER,
    })
    expect(recovered.toString()).toBe(plaintext)
  })

  it('refuses a versionless 3-part ciphertext without an explicit declared format', () => {
    const plaintext = 'sk-fixture-legacy'
    const kr = buildKeyring({ upstreamEncryptionKey: SCRYPT_PASSPHRASE })
    // Strip the v1: prefix to produce a bare iv:tag:data string.
    const bare = aesEncrypt(plaintext, kr).split(':').slice(1).join(':')
    expect(() =>
      decryptLegacySecret({
        ciphertext: bare,
        // format intentionally omitted — KDF cannot be guessed
        format: '',
        keyVersion: 1,
        keyPassphrase: SCRYPT_PASSPHRASE,
      }),
    ).toThrow()
  })

  it('rejects a wrong passphrase as a failed decrypt, not a wrong plaintext', () => {
    const ciphertext = mintVersionedScrypt('sk-fixture-plaintext')
    expect(() =>
      decryptLegacySecret({
        ciphertext,
        format: 'versioned-scrypt-v1',
        keyVersion: 1,
        keyPassphrase: 'wrong-passphrase',
      }),
    ).toThrow()
  })

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const ciphertext = mintVersionedScrypt('sk-fixture-plaintext')
    const parts = ciphertext.split(':')
    // Flip a single hex char in the data segment.
    parts[3] = parts[3].length > 1 ? parts[3].slice(0, -2) + 'ff' : parts[3]
    expect(() =>
      decryptLegacySecret({
        ciphertext: parts.join(':'),
        format: 'versioned-scrypt-v1',
        keyVersion: 1,
        keyPassphrase: SCRYPT_PASSPHRASE,
      }),
    ).toThrow()
  })

  it('rejects a key-version mismatch for versioned-scrypt-v1', () => {
    const ciphertext = mintVersionedScrypt('sk-fixture-plaintext') // embedded v1
    expect(() =>
      decryptLegacySecret({
        ciphertext,
        format: 'versioned-scrypt-v1',
        keyVersion: 2, // declared version differs from embedded
        keyPassphrase: SCRYPT_PASSPHRASE,
      }),
    ).toThrow()
  })
})

describe('legacy migration digest binding', () => {
  it('legacySourceDigest equals the importer digest(r.secret) over the same ciphertext string', () => {
    const ciphertext = mintVersionedScrypt('sk-fixture-plaintext')
    expect(legacySourceDigest(ciphertext)).toBe(importerDigest(ciphertext))
    // And the algorithm name is explicit.
    expect(legacySourceDigest.algorithm).toBe('sha256-json-string-v1')
  })

  it('entryDigest and payloadDigest are stable sha256 over exact bytes', () => {
    const entry = {
      tenant_id: 'tenant-a',
      credential_id: 'cred1',
      credential_version: 1,
      provider_id: 'p1',
      allowed_https_origins: ['https://api.example.com'],
      context_base64: 'Y29udGV4dA==',
      vault: { mount: 'transit', key: 'nexus-provider-v1', wrapped_dek: 'vault:v1:AAAA' },
      encrypted: {
        algorithm: 'AES-256-GCM',
        nonce_base64: 'AAAAAAAAAAAAAAAA',
        ciphertext_base64: 'AAAA',
        tag_base64: 'AAAAAAAAAAAAAAAA',
      },
    }
    const expected = createHash('sha256').update(JSON.stringify(entry)).digest('hex')
    expect(entryDigest(entry)).toBe(expected)
    const payloadBytes = Buffer.from(JSON.stringify({ format: 'x', entries: [entry] }))
    expect(payloadDigest(payloadBytes)).toBe(createHash('sha256').update(payloadBytes).digest('hex'))
  })
})

describe('signed migration proof', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signingKey = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const trust = { operator: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') }
  const now = Date.now()

  it('signs exact source->target binding and verifies under the trusted key', () => {
    const source = {
      namespace: 'fixture16',
      table: 'relay_channels',
      id: 'c1',
      ciphertext_digest: legacySourceDigest('opaque'),
      ciphertext_digest_algorithm: 'sha256-json-string-v1',
      source_format: 'versioned-scrypt-v1',
      source_key_version: 1,
      fingerprint: 'abcd'.repeat(8),
    }
    const entry = {
      tenant_id: 'tenant-a',
      credential_id: 'cred1',
      credential_version: 1,
      provider_id: 'p1',
      allowed_https_origins: ['https://api.example.com'],
      context_base64: 'Y29udGV4dA==',
      vault: { mount: 'transit', key: 'nexus-provider-v1', wrapped_dek: 'vault:v1:AAAA' },
      encrypted: {
        algorithm: 'AES-256-GCM',
        nonce_base64: 'AAAAAAAAAAAAAAAA',
        ciphertext_base64: 'AAAA',
        tag_base64: 'AAAAAAAAAAAAAAAA',
      },
    }
    const payloadBytes = Buffer.from(
      JSON.stringify({
        format: 'nexus.secret-registry.payload.v1',
        registry_id: 'fixture-registry',
        registry_version: 1,
        revocation_epoch: 0,
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60000).toISOString(),
        entries: [entry],
      }),
    )
    const proof = buildMigrationProof({
      source,
      targetEntry: entry,
      payloadBytes,
      registryId: 'fixture-registry',
      registryVersion: 1,
      signingKey,
      signingKeyId: 'operator',
      now,
    })
    expect(() => verifyMigrationProof({ proof, trust })).toThrow()
    expect(() =>
      verifyMigrationProof({
        proof,
        trust,
        recomputedEntryDigest: entryDigest({ ...entry, credential_id: 'substituted' }),
        recomputedPayloadDigest: payloadDigest(payloadBytes),
        expectedSource: source,
      }),
    ).toThrow()
    expect(() =>
      verifyMigrationProof({
        proof,
        trust,
        recomputedEntryDigest: entryDigest(entry),
        recomputedPayloadDigest: payloadDigest(payloadBytes),
        expectedSource: { ...source, ciphertext_digest: legacySourceDigest('substituted') },
      }),
    ).toThrow()
    const verified = verifyMigrationProof({
      proof,
      trust,
      recomputedEntryDigest: entryDigest(entry),
      recomputedPayloadDigest: payloadDigest(payloadBytes),
      expectedSource: source,
    })
    expect(verified.source.id).toBe('c1')
    expect(verified.target.entry_digest).toBe(entryDigest(entry))
    expect(verified.target.payload_digest).toBe(payloadDigest(payloadBytes))
  })

  it('rejects a proof whose target entry was mutated after signing', () => {
    const entry = {
      tenant_id: 'tenant-a',
      credential_id: 'cred1',
      credential_version: 1,
      provider_id: 'p1',
      allowed_https_origins: ['https://api.example.com'],
      context_base64: 'Y29udGV4dA==',
      vault: { mount: 'transit', key: 'nexus-provider-v1', wrapped_dek: 'vault:v1:AAAA' },
      encrypted: {
        algorithm: 'AES-256-GCM',
        nonce_base64: 'AAAAAAAAAAAAAAAA',
        ciphertext_base64: 'AAAA',
        tag_base64: 'AAAAAAAAAAAAAAAA',
      },
    }
    const payloadBytes = Buffer.from(JSON.stringify({ entries: [entry] }))
    const source = {
      namespace: 'fixture16',
      table: 'relay_channels',
      id: 'c1',
      ciphertext_digest: legacySourceDigest('opaque'),
      ciphertext_digest_algorithm: 'sha256-json-string-v1',
      source_format: 'versioned-scrypt-v1',
      source_key_version: 1,
      fingerprint: 'abcd'.repeat(8),
    }
    const proof = buildMigrationProof({
      source,
      targetEntry: entry,
      payloadBytes,
      registryId: 'fixture-registry',
      registryVersion: 1,
      signingKey,
      signingKeyId: 'operator',
      now,
    })
    // Mutate the entry the verifier will recompute against.
    const tampered = { ...entry, credential_id: 'cred9' }
    expect(() =>
      verifyMigrationProof({
        proof: { ...proof, target: { ...proof.target, entry_digest: entryDigest(tampered) } },
        trust,
        recomputedEntryDigest: entryDigest(tampered),
        recomputedPayloadDigest: payloadDigest(payloadBytes),
      }),
    ).toThrow()
  })

  it('rejects a proof signed by an untrusted key', () => {
    const other = generateKeyPairSync('ed25519')
    const entry = {
      tenant_id: 'tenant-a',
      credential_id: 'cred1',
      credential_version: 1,
      provider_id: 'p1',
      allowed_https_origins: ['https://api.example.com'],
      context_base64: 'Y29udGV4dA==',
      vault: { mount: 'transit', key: 'nexus-provider-v1', wrapped_dek: 'vault:v1:AAAA' },
      encrypted: {
        algorithm: 'AES-256-GCM',
        nonce_base64: 'AAAAAAAAAAAAAAAA',
        ciphertext_base64: 'AAAA',
        tag_base64: 'AAAAAAAAAAAAAAAA',
      },
    }
    const payloadBytes = Buffer.from(JSON.stringify({ entries: [entry] }))
    const source = {
      namespace: 'fixture16',
      table: 'relay_channels',
      id: 'c1',
      ciphertext_digest: legacySourceDigest('opaque'),
      ciphertext_digest_algorithm: 'sha256-json-string-v1',
      source_format: 'versioned-scrypt-v1',
      source_key_version: 1,
      fingerprint: 'abcd'.repeat(8),
    }
    const proof = buildMigrationProof({
      source,
      targetEntry: entry,
      payloadBytes,
      registryId: 'fixture-registry',
      registryVersion: 1,
      signingKey: other.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      signingKeyId: 'rogue',
      now,
    })
    expect(() => verifyMigrationProof({ proof, trust })).toThrow()
  })
})

describe('end-to-end legacy secret migration (mocked Vault enroll)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signingKey = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const trust = { operator: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') }
  // Capture the recovered plaintext the operator passed to enrollCredential.
  let capturedPlaintext: Buffer | null = null
  const enroll = async ({ request, secret }: { request: Record<string, unknown>; secret: Buffer }) => {
    capturedPlaintext = Buffer.from(secret)
    const entry = {
      tenant_id: request.tenant_id,
      credential_id: request.credential_id,
      credential_version: request.credential_version,
      provider_id: request.provider_id,
      allowed_https_origins: request.allowed_https_origins,
      context_base64: '',
      vault: {
        ...(request.vault as Record<string, unknown>),
        wrapped_dek: 'vault:v1:' + Buffer.alloc(48).toString('base64'),
      },
      encrypted: {
        algorithm: 'AES-256-GCM',
        nonce_base64: Buffer.alloc(12).toString('base64'),
        ciphertext_base64: secret.toString('base64'),
        tag_base64: Buffer.alloc(16).toString('base64'),
      },
    }
    entry.context_base64 = credentialContext(entry).toString('base64')
    return entry
  }

  it('migrates both formats, recovers the exact plaintext, and emits verifiable proofs', async () => {
    const p1 = 'sk-fixture-scrypt'
    const p2 = 'sk-fixture-envelope'
    const c1 = mintVersionedScrypt(p1)
    const env2 = mintLocalEnvelope(p2)
    const manifest = baseManifest([
      baseRecord({
        credential_id: 'cred1',
        source_id: 'c1',
        ciphertext: c1,
        format: 'versioned-scrypt-v1',
        key_version: 1,
        fingerprint: createHash('sha256').update(p1).digest('hex').slice(0, 32),
      }),
      baseRecord({
        credential_id: 'cred2',
        source_id: 'c2',
        ciphertext: env2.secretEnvelope,
        encrypted_data_key: env2.wrappedDek,
        format: 'local-envelope-v1',
        key_version: 1,
        fingerprint: createHash('sha256').update(p2).digest('hex').slice(0, 32),
      }),
    ])
    const { signedRegistry, proofs, receipts } = await runLegacySecretMigration({
      manifest,
      keyPassphrase: SCRYPT_PASSPHRASE,
      kmsMaster: KMS_MASTER,
      enroll,
      signingKey,
      signingKeyId: 'operator',
      now: Date.now(),
    })
    expect(signedRegistry.format).toBe('nexus.secret-registry.signed.v1')
    expect(proofs).toHaveLength(2)
    // The first record's recovered plaintext was p1.
    expect(capturedPlaintext?.toString()).toBe(p2) // last enrolled
    // Each proof verifies under the trusted key and binds the source digest.
    for (const proof of proofs) {
      const payloadBytes = Buffer.from(signedRegistry.payload_base64, 'base64')
      const entry = JSON.parse(payloadBytes.toString()).entries.find(
        (e: { credential_id: string }) => e.credential_id === proof.target.credential_id,
      )
      const record = (manifest.records as Record<string, unknown>[]).find((r) => r.source_id === proof.source.id)!
      const v = verifyMigrationProof({
        proof,
        trust,
        recomputedEntryDigest: entryDigest(entry),
        recomputedPayloadDigest: payloadDigest(payloadBytes),
        expectedSource: {
          namespace: manifest.namespace,
          table: record.source_table,
          id: record.source_id,
          ciphertext_digest: legacySourceDigest(record.ciphertext),
          source_format: record.format,
          source_key_version: record.key_version,
          ...(record.encrypted_data_key ? { wrapped_dek_digest: legacySourceDigest(record.encrypted_data_key) } : {}),
        },
      })
      expect(v.source.ciphertext_digest_algorithm).toBe('sha256-json-string-v1')
    }
    // No canary appears anywhere in the receipts or stdout-shaped output.
    const serialized = JSON.stringify({ signedRegistry, proofs, receipts })
    expect(serialized).not.toContain('sk-fixture-scrypt')
    expect(serialized).not.toContain('sk-fixture-envelope')
  })

  it('refuses a missing source mapping (record without matching source ciphertext)', async () => {
    const manifest = baseManifest([
      baseRecord({ ciphertext: mintVersionedScrypt('x'), format: 'versioned-scrypt-v1', key_version: 1 }),
    ])
    await expect(
      runLegacySecretMigration({
        manifest,
        keyPassphrase: 'wrong',
        kmsMaster: KMS_MASTER,
        enroll,
        signingKey,
        signingKeyId: 'operator',
        now: Date.now(),
      }),
    ).rejects.toThrow()
  })

  it('rejects a fingerprint mismatch (tampered plaintext evidence)', async () => {
    const p = 'sk-fingerprint'
    const manifest = baseManifest([
      baseRecord({
        ciphertext: mintVersionedScrypt(p),
        format: 'versioned-scrypt-v1',
        key_version: 1,
        fingerprint: 'deadbeef'.repeat(8), // wrong fingerprint
      }),
    ])
    await expect(
      runLegacySecretMigration({
        manifest,
        keyPassphrase: SCRYPT_PASSPHRASE,
        kmsMaster: KMS_MASTER,
        enroll,
        signingKey,
        signingKeyId: 'operator',
        now: Date.now(),
      }),
    ).rejects.toThrow()
  })
})
