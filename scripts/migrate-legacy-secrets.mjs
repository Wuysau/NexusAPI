// Independent operator-only workload. Never import into Next/CP.
//
// Migrates legacy Control-Plane ciphertext (versioned-scrypt-v1 and
// local-envelope-v1, the two formats produced by src/lib/crypto.ts and
// src/lib/secrets/envelope.ts LocalKms) into the accepted Vault external
// registry. The operator decrypts each source ciphertext in memory with an
// explicitly supplied key, calls the real encrypt-only Vault enrollment, and
// emits an independently signed migration proof binding the source ciphertext
// digest to the target registry entry/payload digest. No plaintext, DEK,
// passphrase or canary is ever written to output, receipts or logs.
//
// Per ADR-0009 / SECRET_WORKLOAD_CONTRACT: the Control Plane cannot read
// plaintext, cannot import this module, and cannot supply defaults. The
// importer (scripts/legacy-migration.mjs) accepts the resulting external
// registry rows only via the signed proof + trusted key (--proofs/--trust).
import {
  createHash,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  scryptSync,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const refuse = () => {
  throw new Error('Legacy secret migration refused by schema or operator policy')
}
const identifier = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v)
const integer = (v, min) => Number.isSafeInteger(v) && v >= min
function keys(value, expected) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join('|') !== [...expected].sort().join('|')
  )
    refuse()
}

const SCRYPT_N = 1 << 14,
  SCRYPT_R = 8,
  SCRYPT_P = 1,
  SCRYPT_SALT = 'nexusapi-upstream-key-salt'

function deriveScryptKey(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 1 || passphrase.length > 1024) refuse()
  return scryptSync(passphrase, SCRYPT_SALT, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
}

// Parse the versioned envelope "v{version}:{iv_hex}:{tag_hex}:{data_hex}".
function parseVersionedEnvelope(payload) {
  if (typeof payload !== 'string' || payload.length > 32768) refuse()
  const parts = payload.split(':')
  if (parts.length !== 4) refuse()
  const head = parts[0]
  if (!/^v\d+$/.test(head)) refuse()
  const version = Number(head.slice(1))
  if (!integer(version, 1)) refuse()
  const iv = Buffer.from(parts[1], 'hex')
  const tag = Buffer.from(parts[2], 'hex')
  const data = Buffer.from(parts[3], 'hex')
  if (iv.length !== 12 || tag.length !== 16 || data.length < 1) refuse()
  if (parts[1] !== iv.toString('hex') || parts[2] !== tag.toString('hex') || parts[3] !== data.toString('hex')) refuse()
  return { version, iv, tag, data }
}

function aesGcmDecrypt(key, iv, tag, data, aad) {
  const d = createDecipheriv('aes-256-gcm', key, iv)
  if (aad) d.setAAD(aad)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(data), d.final()])
}

/**
 * Decrypt a legacy source ciphertext in operator memory. The format and key
 * version MUST be explicitly declared; a versionless 3-part payload cannot
 * have its KDF guessed and is refused. Wrong key, tamper and version mismatch
 * fail closed as GCM auth errors.
 */
export function decryptLegacySecret({ ciphertext, encryptedDataKey, format, keyVersion, keyPassphrase, kmsMaster }) {
  if (!integer(keyVersion, 1)) refuse()
  if (format === 'versioned-scrypt-v1') {
    if (typeof keyPassphrase !== 'string' || !keyPassphrase) refuse()
    const { version, iv, tag, data } = parseVersionedEnvelope(ciphertext)
    if (version !== keyVersion) refuse()
    const key = deriveScryptKey(keyPassphrase)
    try {
      return aesGcmDecrypt(key, iv, tag, data)
    } catch {
      refuse()
    }
  }
  if (format === 'local-envelope-v1') {
    if (typeof kmsMaster !== 'string' || !kmsMaster) refuse()
    const { version, iv, tag, data } = parseVersionedEnvelope(encryptedDataKey)
    if (version !== keyVersion) refuse()
    const masterKey = scryptSync(`${kmsMaster}|nexus-kms|v${keyVersion}`, SCRYPT_SALT, 32, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    })
    let dekHex
    try {
      dekHex = aesGcmDecrypt(masterKey, iv, tag, data).toString('utf8')
    } catch {
      refuse()
    }
    const dek = Buffer.from(dekHex, 'hex')
    if (dek.length !== 32) refuse()
    // The secret envelope is "v1:..." encrypted with the random DEK; its version
    // tag is the DEK envelope version (1), not the KMS version.
    const secret = parseVersionedEnvelope(ciphertext)
    if (secret.version !== 1) refuse()
    try {
      return aesGcmDecrypt(dek, secret.iv, secret.tag, secret.data)
    } catch {
      refuse()
    }
  }
  // Unknown / empty format: cannot guess the KDF.
  refuse()
}

/** Source ciphertext digest, identical to the importer's digest(r.secret):
 * sha256(JSON.stringify(ciphertextString)). Explicit algorithm name for proof
 * portability; never used to recover plaintext. */
export function legacySourceDigest(ciphertext) {
  if (typeof ciphertext !== 'string' || ciphertext.length < 1 || ciphertext.length > 32768) refuse()
  return createHash('sha256').update(JSON.stringify(ciphertext)).digest('hex')
}
legacySourceDigest.algorithm = 'sha256-json-string-v1'

/** Per-entry digest matching the Go gateway entryBinding (sha256 over the exact
 * entry JSON bytes, same field order as the Go struct). */
export function entryDigest(entry) {
  if (!entry || typeof entry !== 'object') refuse()
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex')
}

/** Payload digest matching the Go validateRegistry digest (sha256 over the
 * exact signed payload bytes). */
export function payloadDigest(payloadBytes) {
  if (!Buffer.isBuffer(payloadBytes) || payloadBytes.length === 0 || payloadBytes.length > 12 * 1024 * 1024) refuse()
  return createHash('sha256').update(payloadBytes).digest('hex')
}

function signingPayload(proof) {
  const { signature_base64: _sig, ...rest } = proof
  return Buffer.from(JSON.stringify(rest))
}

export function buildMigrationProof({
  source,
  targetEntry,
  payloadBytes,
  registryId,
  registryVersion,
  signingKey,
  signingKeyId,
  now = Date.now(),
}) {
  const requiredSourceKeys = [
    'namespace',
    'table',
    'id',
    'ciphertext_digest',
    'ciphertext_digest_algorithm',
    'source_format',
    'source_key_version',
  ]
  const allowedSourceKeys = [...requiredSourceKeys, 'wrapped_dek_digest', 'fingerprint']
  if (!source || typeof source !== 'object' || Array.isArray(source)) refuse()
  for (const k of requiredSourceKeys) if (!(k in source)) refuse()
  for (const k of Object.keys(source)) if (!allowedSourceKeys.includes(k)) refuse()
  if (!identifier(source.namespace) || !identifier(source.table) || !identifier(source.id)) refuse()
  if (source.ciphertext_digest_algorithm !== legacySourceDigest.algorithm) refuse()
  if (!/^[a-f0-9]{64}$/.test(source.ciphertext_digest)) refuse()
  if (!['versioned-scrypt-v1', 'local-envelope-v1'].includes(source.source_format)) refuse()
  if (!integer(source.source_key_version, 1)) refuse()
  if (source.fingerprint !== undefined && !/^[a-f0-9]{32}$/.test(source.fingerprint)) refuse()
  if (source.wrapped_dek_digest !== undefined && !/^[a-f0-9]{64}$/.test(source.wrapped_dek_digest)) refuse()
  if (!identifier(registryId) || !integer(registryVersion, 1)) refuse()
  if (!identifier(signingKeyId)) refuse()
  if (!Buffer.isBuffer(payloadBytes)) refuse()
  const proof = {
    format: 'nexus.legacy-secret-migration.proof.v1',
    signing_key_id: signingKeyId,
    source: {
      namespace: source.namespace,
      table: source.table,
      id: source.id,
      ciphertext_digest: source.ciphertext_digest,
      ciphertext_digest_algorithm: source.ciphertext_digest_algorithm,
      source_format: source.source_format,
      source_key_version: source.source_key_version,
      ...(source.wrapped_dek_digest ? { wrapped_dek_digest: source.wrapped_dek_digest } : {}),
      ...(source.fingerprint ? { fingerprint: source.fingerprint } : {}),
    },
    target: {
      registry_id: registryId,
      registry_version: registryVersion,
      tenant_id: targetEntry.tenant_id,
      credential_id: targetEntry.credential_id,
      credential_version: targetEntry.credential_version,
      provider_id: targetEntry.provider_id,
      entry_digest: entryDigest(targetEntry),
      payload_digest: payloadDigest(payloadBytes),
    },
    migrated_at: new Date(now).toISOString(),
  }
  const key = createPrivateKey(signingKey)
  if (key.asymmetricKeyType !== 'ed25519') refuse()
  const sig = edSign(null, signingPayload(proof), key)
  return { ...proof, signature_base64: sig.toString('base64') }
}

export function verifyMigrationProof({ proof, trust, recomputedEntryDigest, recomputedPayloadDigest, expectedSource }) {
  if (!proof || proof.format !== 'nexus.legacy-secret-migration.proof.v1' || !identifier(proof.signing_key_id)) refuse()
  const pubBase64 = trust?.[proof.signing_key_id]
  if (typeof pubBase64 !== 'string' || pubBase64.length > 128) refuse()
  const pubRaw = Buffer.from(pubBase64, 'base64')
  if (pubRaw.length !== 32 || pubRaw.toString('base64') !== pubBase64) refuse()
  // Reconstruct an SPKI KeyObject from the raw 32-byte Ed25519 public key
  // (fixed prefix), matching how secret-enroll.mjs / Go store trust material.
  const pubKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubRaw]),
    format: 'der',
    type: 'spki',
  })
  const signature = Buffer.from(proof.signature_base64, 'base64')
  if (signature.length !== 64 || signature.toString('base64') !== proof.signature_base64) refuse()
  const { signature_base64: _sig, ...rest } = proof
  const signed = Buffer.from(JSON.stringify(rest))
  if (!edVerify(null, signed, pubKey, signature)) refuse()
  // Signature validity is not source/target verification. Callers must supply
  // independently recomputed digests and the actual source identity.
  if (!/^[a-f0-9]{64}$/.test(recomputedEntryDigest ?? '') || proof.target.entry_digest !== recomputedEntryDigest)
    refuse()
  if (!/^[a-f0-9]{64}$/.test(recomputedPayloadDigest ?? '') || proof.target.payload_digest !== recomputedPayloadDigest)
    refuse()
  if (
    !expectedSource ||
    ['namespace', 'table', 'id', 'ciphertext_digest'].some((k) => typeof expectedSource[k] !== 'string')
  )
    refuse()
  for (const [key, value] of Object.entries(expectedSource)) if (proof.source[key] !== value) refuse()
  if (proof.source.ciphertext_digest_algorithm !== legacySourceDigest.algorithm) refuse()
  return { source: proof.source, target: proof.target }
}

function fingerprintOf(plaintext) {
  return createHash('sha256').update(plaintext).digest('hex').slice(0, 32)
}

function validateManifest(m) {
  keys(m, [
    'namespace',
    'registry_id',
    'registry_version',
    'revocation_epoch',
    'allowed_https_origins',
    'vault',
    'records',
  ])
  if (!identifier(m.namespace) || !identifier(m.registry_id) || !integer(m.registry_version, 1)) refuse()
  if (!Number.isSafeInteger(m.revocation_epoch) || m.revocation_epoch < 0) refuse()
  if (!Array.isArray(m.records) || m.records.length < 1 || m.records.length > 10000) refuse()
  if (!Array.isArray(m.allowed_https_origins) || m.allowed_https_origins.length < 1) refuse()
  keys(m.vault, ['mount', 'key'])
  if (!identifier(m.vault.mount) || !identifier(m.vault.key)) refuse()
  const seen = new Set()
  const requiredRecordKeys = [
    'source_table',
    'source_id',
    'tenant_id',
    'provider_id',
    'credential_id',
    'credential_version',
    'format',
    'key_version',
    'ciphertext',
  ]
  const allowedRecordKeys = [...requiredRecordKeys, 'encrypted_data_key', 'fingerprint']
  for (const r of m.records) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) refuse()
    for (const k of requiredRecordKeys) if (!(k in r)) refuse()
    for (const k of Object.keys(r)) if (!allowedRecordKeys.includes(k)) refuse()
    if (
      !identifier(r.source_table) ||
      !identifier(r.source_id) ||
      !identifier(r.tenant_id) ||
      !identifier(r.provider_id) ||
      !identifier(r.credential_id) ||
      !integer(r.credential_version, 1) ||
      !integer(r.key_version, 1)
    )
      refuse()
    if (!['versioned-scrypt-v1', 'local-envelope-v1'].includes(r.format)) refuse()
    if (r.format === 'local-envelope-v1' && (typeof r.encrypted_data_key !== 'string' || !r.encrypted_data_key))
      refuse()
    if (r.fingerprint !== undefined && !/^[a-f0-9]{32}$/.test(r.fingerprint)) refuse()
    const tuple = JSON.stringify([r.namespace ?? m.namespace, r.source_table, r.source_id])
    if (seen.has(tuple)) refuse()
    seen.add(tuple)
  }
}

/**
 * Run the in-memory migration. `enroll` is the real encrypt-only Vault
 * enrollment function (scripts/secret-enroll.mjs enrollCredential) or an
 * equivalent operator workload; it receives the recovered plaintext Buffer and
 * must return a complete, validated registry entry. No plaintext is persisted
 * or returned; only entries, a signed registry and per-record proofs.
 */
export async function runLegacySecretMigration({
  manifest,
  keyPassphrase,
  kmsMaster,
  enroll,
  signingKey,
  signingKeyId,
  now = Date.now(),
}) {
  validateManifest(manifest)
  if (typeof enroll !== 'function' || !signingKeyId || !signingKey) refuse()
  const entries = []
  const proofs = []
  const receipts = []
  for (const r of manifest.records) {
    const plaintext = decryptLegacySecret({
      ciphertext: r.ciphertext,
      encryptedDataKey: r.encrypted_data_key,
      format: r.format,
      keyVersion: r.key_version,
      keyPassphrase,
      kmsMaster,
    })
    let entry
    try {
      if (r.fingerprint && fingerprintOf(plaintext) !== r.fingerprint) refuse()
      entry = await enroll({
        request: {
          tenant_id: r.tenant_id,
          credential_id: r.credential_id,
          credential_version: r.credential_version,
          provider_id: r.provider_id,
          allowed_https_origins: manifest.allowed_https_origins,
          vault: manifest.vault,
        },
        secret: plaintext,
      })
    } finally {
      plaintext.fill(0)
    }
    if (!entry || ['tenant_id', 'credential_id', 'credential_version', 'provider_id'].some((k) => entry[k] !== r[k]))
      refuse()
    entries.push(entry)
    receipts.push({
      source_id: r.source_id,
      credential_id: r.credential_id,
      source_format: r.format,
      source_key_version: r.key_version,
      status: 'migrated',
    })
  }
  // Build and sign the deployable registry payload via the shared operator
  // signer (strict validation of every entry/context/origin).
  const { signRegistry } = await import('./secret-enroll.mjs')
  const payloadBytes = Buffer.from(
    JSON.stringify({
      format: 'nexus.secret-registry.payload.v1',
      registry_id: manifest.registry_id,
      registry_version: manifest.registry_version,
      revocation_epoch: manifest.revocation_epoch,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60000).toISOString(),
      entries,
    }),
  )
  const signedRegistry = signRegistry({ payloadBytes, signingKey, signingKeyId, now })
  for (let i = 0; i < manifest.records.length; i++) {
    const r = manifest.records[i]
    const entry = entries[i]
    const source = {
      namespace: manifest.namespace,
      table: r.source_table,
      id: r.source_id,
      ciphertext_digest: legacySourceDigest(r.ciphertext),
      ciphertext_digest_algorithm: legacySourceDigest.algorithm,
      source_format: r.format,
      source_key_version: r.key_version,
      ...(r.encrypted_data_key ? { wrapped_dek_digest: legacySourceDigest(r.encrypted_data_key) } : {}),
      ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}),
    }
    proofs.push(
      buildMigrationProof({
        source,
        targetEntry: entry,
        payloadBytes,
        registryId: manifest.registry_id,
        registryVersion: manifest.registry_version,
        signingKey,
        signingKeyId,
        now,
      }),
    )
  }
  return { signedRegistry, proofs, receipts }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2),
    flags = {}
  try {
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i]?.startsWith('--') || !args[i + 1] || args[i] in flags) refuse()
      flags[args[i]] = args[i + 1]
    }
    const manifest = JSON.parse(await readFile(flags['--manifest'], 'utf8'))
    const keyPassphrase = flags['--key-file'] ? (await readFile(flags['--key-file'], 'utf8')).trimEnd() : undefined
    const kmsMaster = flags['--kms-master-file']
      ? (await readFile(flags['--kms-master-file'], 'utf8')).trimEnd()
      : undefined
    const signingKey = await readFile(flags['--signing-key-file'])
    const vault = {
      vaultUrl: flags['--vault-url'],
      vaultTokenFile: flags['--vault-token-file'],
      vaultCaFile: flags['--vault-ca-file'],
    }
    const { enrollCredential } = await import('./secret-enroll.mjs')
    const enroll = async ({ request, secret }) => enrollCredential({ request, secret, ...vault })
    const { signedRegistry, proofs, receipts } = await runLegacySecretMigration({
      manifest,
      keyPassphrase,
      kmsMaster,
      enroll,
      signingKey,
      signingKeyId: flags['--signing-key-id'],
      now: Date.now(),
    })
    const out = flags['--output'] || 'migrate-legacy-secrets.out.json'
    const tmp = `${out}.${randomBytes(8).toString('hex')}.tmp`
    // Only sanitized artifacts: signed registry, proofs (no plaintext/DEK/canary),
    // and per-record status receipts.
    await writeFile(tmp, JSON.stringify({ signedRegistry, proofs, receipts }, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    })
    await rename(tmp, out)
    console.log(JSON.stringify({ status: 'complete', records: receipts.length, output: out }))
  } catch {
    console.error(
      'Legacy secret migration refused; no key material or canary is emitted. Inspect the manifest, explicit key files and authorized Vault workload.',
    )
    process.exitCode = 1
  }
}
