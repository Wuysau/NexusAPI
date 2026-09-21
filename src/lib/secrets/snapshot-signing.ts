import { buildKeyring } from '@/lib/crypto'

// Routing HMAC authority is independent of credential encryption and registry approval.
export function snapshotSigningKeyring() {
  const production = process.env.NODE_ENV === 'production'
  const key = process.env.SNAPSHOT_SIGNING_KEY || (production ? '' : process.env.UPSTREAM_ENCRYPTION_KEY) || ''
  if (production && key.length < 32) throw new Error('SNAPSHOT_SIGNING_KEY is required')
  const previousKey =
    process.env.SNAPSHOT_SIGNING_KEY_PREVIOUS || (production ? undefined : process.env.UPSTREAM_ENCRYPTION_KEY_PREVIOUS)
  const previousVersion =
    process.env.SNAPSHOT_SIGNING_KEY_PREVIOUS_VERSION ||
    (production ? undefined : process.env.UPSTREAM_ENCRYPTION_KEY_PREVIOUS_VERSION)
  return buildKeyring({
    upstreamEncryptionKey: key,
    currentVersion: Number(process.env.SNAPSHOT_SIGNING_KEY_VERSION || '1'),
    previousKey,
    previousVersion: previousVersion ? Number(previousVersion) : undefined,
  })
}
