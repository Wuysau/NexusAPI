// Cryptography for NexusAPI. Replaces the single-key crypto in the old
// src/lib/server.ts with versioned keys to support rotation.
//
// Key rotation model:
//   - Encryption keys are addressed by integer version, sourced from env.
//   - UPSTREAM_ENCRYPTION_KEY is the CURRENT key (version N).
//   - UPSTREAM_ENCRYPTION_KEY_PREVIOUS is the prior key (version N-1), kept
//     for decrypting legacy ciphertext after a rotation.
//   - Encrypt with the current version; decrypt tries current, then previous.
//   - ciphertext format: "v{version}:{iv}:{tag}:{data}" (all hex).

import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, scryptSync } from 'crypto'

const SCRYPT_N = 1 << 14,
  SCRYPT_R = 8,
  SCRYPT_P = 1

export interface Keyring {
  current: { version: number; key: Buffer }
  previous?: { version: number; key: Buffer }
}

let keyringCache: Keyring | null = null

function deriveKey(passphrase: string): Buffer {
  // Derive a 32-byte AES key from the passphrase via a KDF. We do NOT use the
  // raw passphrase as the key (variable length / weak entropy).
  return scryptSync(passphrase, 'nexusapi-upstream-key-salt', 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
}

export interface KeyringEnv {
  upstreamEncryptionKey: string
  currentVersion?: number
  previousKey?: string
  previousVersion?: number
}

/** Build a keyring from an explicit env (tests / one-off calls). */
export function buildKeyring(env: KeyringEnv): Keyring {
  const currentVersion = env.currentVersion ?? 1
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) throw new Error('Invalid key version')
  const current = deriveKey(env.upstreamEncryptionKey || 'local-development-only-key-DO-NOT-USE-IN-PROD')
  let previous: Keyring['previous']
  if (env.previousKey) {
    previous = { version: env.previousVersion ?? currentVersion - 1, key: deriveKey(env.previousKey) }
  }
  return { current: { version: currentVersion, key: current }, previous }
}

/** Cached keyring from the process env (the gateway hot path). */
export function getKeyring(): Keyring {
  if (process.env.NODE_ENV === 'production') throw new Error('Control Plane local credential cryptography is disabled')
  if (keyringCache) return keyringCache
  // Lazily import config to avoid a cycle at module load time.
  const { env } = require('./config') as typeof import('./config')
  keyringCache = buildKeyring({
    upstreamEncryptionKey: env().upstreamEncryptionKey,
    previousKey: (process.env.UPSTREAM_ENCRYPTION_KEY_PREVIOUS || undefined) as string | undefined,
    previousVersion: process.env.UPSTREAM_ENCRYPTION_KEY_PREVIOUS_VERSION
      ? Number(process.env.UPSTREAM_ENCRYPTION_KEY_PREVIOUS_VERSION)
      : undefined,
  })
  return keyringCache
}

/** Test-only: reset the keyring cache so env stubs take effect. */
export function __resetKeyringForTests(): void {
  keyringCache = null
}

export function encrypt(plaintext: string, keyring?: Keyring): string {
  const kr = keyring ?? getKeyring()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', kr.current.key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `v${kr.current.version}:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`
}

export function decrypt(payload: string, keyring?: Keyring): string {
  const kr = keyring ?? getKeyring()
  const [versionTag, iv, tag, data] = payload.split(':')
  const version = parseInt(versionTag.replace(/^v/, ''), 10)
  const entry = version === kr.current.version ? kr.current : version === kr.previous?.version ? kr.previous : null
  if (!entry) throw new Error(`crypto: no key for version ${version}`)
  const d = createDecipheriv('aes-256-gcm', entry.key, Buffer.from(iv, 'hex'))
  d.setAuthTag(Buffer.from(tag, 'hex'))
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8')
}

/** Backwards-compatible decrypt for legacy ciphertext without a version tag. */
export function decryptLegacy(payload: string, keyring?: Keyring): string {
  const kr = keyring ?? getKeyring()
  const parts = payload.split(':')
  if (parts.length === 3) {
    const [iv, tag, data] = parts
    const d = createDecipheriv('aes-256-gcm', kr.current.key, Buffer.from(iv, 'hex'))
    d.setAuthTag(Buffer.from(tag, 'hex'))
    return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8')
  }
  return decrypt(payload, kr)
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** Constant-time comparison of two secrets (auth tokens, session ids). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(sha256hex(a))
  const bb = Buffer.from(sha256hex(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** Password hashing via scrypt (no external dep). Output: "scrypt$N$r$p$salt$hash". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltHex, hashHex] = parts
  if (!/^[a-f0-9]+$/i.test(saltHex) || !/^[a-f0-9]{64}$/i.test(hashHex)) return false
  const expected = Buffer.from(hashHex, 'hex')
  let hash: Buffer
  try {
    hash = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    })
  } catch {
    return false
  }
  // Length equality is proven above; timingSafeEqual would throw otherwise.
  return hash.length === expected.length && timingSafeEqual(hash, expected)
}

/** New session token (returns plaintext token to show once; store only the hash). */
export function newSessionToken(): string {
  return randomBytes(32).toString('hex')
}

/** New downstream API key with recognizable prefix. */
export function newApiKey(prefix: string): string {
  return `${prefix}${randomBytes(24).toString('hex')}`
}
