// Fail-closed Control Plane configuration. It MUST NOT start in production without
// the variables listed below. This replaces the old pattern of deriving the
// encryption key from DATABASE_URL (src/lib/server.ts:7) — that is forbidden.

export type Env = ReturnType<typeof loadEnv>

export interface EnvShape {
  nodeEnv: string
  databaseUrl: string
  upstreamEncryptionKey: string
  adminToken: string
  appBaseUrl: string
  redisUrl?: string
  isProduction: boolean
  // Auth / secret plane (Work Item C)
  kmsProvider: string
  kmsKeyVersion: number
  sessionTtlSeconds: number
  cookieDomain?: string
}

const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'SNAPSHOT_SIGNING_KEY',
  'ADMIN_TOKEN',
  'APP_BASE_URL',
  'KMS_PROVIDER',
] as const

export const MIN_SESSION_TTL_SECONDS = 5 * 60
export const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`[fail-closed] ${name} must be a positive integer`)
  }
  return Math.min(max, Math.max(min, n))
}

/**
 * Load and validate environment. In production, throws if any required var is
 * missing, a crypto identity is mounted here, or a local KMS is requested.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): EnvShape {
  const nodeEnv = (source.NODE_ENV ?? 'development').trim()
  const isProduction = nodeEnv === 'production'

  const databaseUrl = source.DATABASE_URL?.trim() ?? ''
  const upstreamEncryptionKey = source.UPSTREAM_ENCRYPTION_KEY?.trim() ?? ''
  const adminToken = source.ADMIN_TOKEN?.trim() ?? ''
  const appBaseUrl = source.APP_BASE_URL?.trim() ?? ''
  const redisUrl = source.REDIS_URL?.trim() || undefined

  // ── Auth / secret plane settings ────────────────────────────────────
  const kmsProvider = source.KMS_PROVIDER?.trim() || 'local'
  const kmsKeyVersion = parsePositiveInt(source.KMS_KEY_VERSION, 1, 1, 1_000_000, 'KMS_KEY_VERSION')
  const sessionTtlSeconds = parsePositiveInt(
    source.SESSION_TTL_SECONDS,
    DEFAULT_SESSION_TTL_SECONDS,
    MIN_SESSION_TTL_SECONDS,
    MAX_SESSION_TTL_SECONDS,
    'SESSION_TTL_SECONDS',
  )
  const cookieDomain = source.SESSION_COOKIE_DOMAIN?.trim() || undefined

  if (isProduction) {
    const missing = REQUIRED_IN_PRODUCTION.filter((k) => !(source as Record<string, string | undefined>)[k]?.trim())
    if (missing.length) {
      throw new Error(`[fail-closed] missing required env in production: ${missing.join(', ')}`)
    }
    const forbidden = [
      'UPSTREAM_ENCRYPTION_KEY',
      'UPSTREAM_ENCRYPTION_KEY_PREVIOUS',
      'VAULT_TOKEN',
      'VAULT_TOKEN_FILE',
      'VAULT_ROLE_ID',
      'VAULT_SECRET_ID',
      'VAULT_SECRET_ID_FILE',
      'VAULT_ROLE_ID_FILE',
      'SECRET_REGISTRY_SIGNING_KEY_FILE',
      'SECRET_REGISTRY_PRIVATE_KEY',
      'ALLOW_LOCAL_KMS_IN_PRODUCTION',
    ]
    if (forbidden.some((key) => source[key]?.trim()))
      throw new Error(
        '[fail-closed] Control Plane must not hold wrapping keys, Vault identities, registrar keys or local bypasses',
      )
    if ((source.SNAPSHOT_SIGNING_KEY?.trim().length ?? 0) < 32)
      throw new Error('[fail-closed] SNAPSHOT_SIGNING_KEY must be at least 32 chars')
    if (adminToken.length < 24) {
      throw new Error('[fail-closed] ADMIN_TOKEN must be at least 24 chars in production')
    }
    if (kmsProvider !== 'vault')
      throw new Error('[fail-closed] KMS_PROVIDER must be vault; crypto runs only in independent workloads')
  }

  // Even in dev, refuse the dangerous derivation pattern.
  if (upstreamEncryptionKey && upstreamEncryptionKey === databaseUrl) {
    throw new Error('[fail-closed] UPSTREAM_ENCRYPTION_KEY must not equal DATABASE_URL')
  }

  return {
    nodeEnv,
    databaseUrl,
    upstreamEncryptionKey,
    adminToken,
    appBaseUrl,
    redisUrl,
    isProduction,
    kmsProvider,
    kmsKeyVersion,
    sessionTtlSeconds,
    cookieDomain,
  }
}

let cached: EnvShape | null = null
export function env(): EnvShape {
  if (!cached) cached = loadEnv()
  return cached
}

// Test-only reset (avoids polluting other tests when env vars are stubbed).
export function __resetEnvCacheForTests(): void {
  cached = null
}
