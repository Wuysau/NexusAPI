import { snapshotSigningKeyring } from '@/lib/secrets/snapshot-signing'
// Gateway snapshot build / sign / verify.
//
// On activation the control plane freezes the facts the data plane needs —
// catalog version, active price versions, routing policies — into a JSON
// payload, signs it with the versioned keyring (src/lib/crypto.ts), and stores
// it in `gateway_snapshots` with a monotonic sequence number. The gateway
// verifies the signature before using a snapshot and caches approved snapshots
// only; it never re-sources prices at request time (ADR-0003, DYNAMIC spec
// "Caching").
//
// Payloads are canonicalized (sorted keys, compact) so signing is independent
// of property order; signature covers the canonical bytes of the exact stored
// payload.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { sha256hex, type Keyring } from '@/lib/crypto'
import type { PriceComponent } from '@/lib/pricing/components'

export const SNAPSHOT_SCHEMA_VERSION = 1
export const SNAPSHOT_KIND = 'gateway_snapshot'
export const SNAPSHOT_SIGNING_ALGORITHM = 'hmac-sha256'

export interface SnapshotCatalogVersion {
  id: string
  version: number
  checksum: string
}

export interface SnapshotPriceVersion {
  id: string
  provider: string
  model_id: string
  currency: string
  region: string
  service_tier: string
  unit: string
  effective_from: string | null
  effective_to: string | null
  components: PriceComponent[]
  // INVARIANT #4 pin: the sale-price and exchange-rate snapshots the gateway
  // persists on request_records so settle can recompute from the frozen rates.
  sale_price_snapshot_id?: string | null
  exchange_rate_snapshot_id?: string | null
}

export interface SnapshotRoutingPolicy {
  id: string
  version: number
  checksum: string
  credential_mode: string
  model_routes: { modelId: string; weight: number; priority?: number }[]
}

export interface GatewaySnapshotPayload {
  schema_version: typeof SNAPSHOT_SCHEMA_VERSION
  kind: typeof SNAPSHOT_KIND
  tenant_id: string | null
  sequence_number: number
  catalog_version: SnapshotCatalogVersion | null
  price_versions: SnapshotPriceVersion[]
  routing_policies: SnapshotRoutingPolicy[]
  generated_at: string
}

export interface BuildSnapshotInput {
  tenantId: string | null
  sequenceNumber: number
  catalogVersion?: SnapshotCatalogVersion | null
  priceVersions: SnapshotPriceVersion[]
  routingPolicies?: SnapshotRoutingPolicy[]
  generatedAt?: Date
}

export interface SignedSnapshot {
  payload: GatewaySnapshotPayload
  signature: string
  signingKeyId: string
  canonical: string
}

export interface SnapshotVerifyResult {
  ok: boolean
  reasons: string[]
}

export function buildSnapshotPayload(input: BuildSnapshotInput): GatewaySnapshotPayload {
  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    kind: SNAPSHOT_KIND,
    tenant_id: input.tenantId,
    sequence_number: input.sequenceNumber,
    catalog_version: input.catalogVersion ?? null,
    price_versions: input.priceVersions,
    routing_policies: input.routingPolicies ?? [],
    generated_at: (input.generatedAt ?? new Date()).toISOString(),
  }
}

/**
 * Deterministic JSON: object keys sorted, no whitespace, no NaN/Infinity.
 * Signing and verification both go through this, so a payload round-tripped
 * through jsonb verifies identically.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') {
    if (!Number.isFinite(value as number)) throw new Error('snapshot: non-finite number is not canonical')
    return JSON.stringify(value)
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
  }
  throw new Error(`snapshot: cannot canonicalize ${t}`)
}

export function signingKeyIdFor(keyring: Keyring): string {
  return `${SNAPSHOT_SIGNING_ALGORITHM}:v${keyring.current.version}`
}

/**
 * Default signing keyring, built from the same env vars (and same precedence)
 * as crypto.getKeyring(). It is constructed here rather than delegating to
 * getKeyring() because that helper resolves config through a CommonJS
 * `require`, which does not resolve under the ESM test runner.
 */
const defaultKeyring = snapshotSigningKeyring

function hmac(key: Buffer, canonical: string): string {
  return createHmac('sha256', key).update(canonical, 'utf8').digest('hex')
}

export function signSnapshot(payload: GatewaySnapshotPayload, keyring?: Keyring): SignedSnapshot {
  const kr = keyring ?? defaultKeyring()
  const canonical = canonicalJson(payload)
  return {
    payload,
    signature: hmac(kr.current.key, canonical),
    signingKeyId: signingKeyIdFor(kr),
    canonical,
  }
}

export function snapshotChecksum(payload: GatewaySnapshotPayload): string {
  return sha256hex(canonicalJson(payload))
}

function keyForVersion(keyring: Keyring, version: number): Buffer | null {
  if (keyring.current.version === version) return keyring.current.key
  if (keyring.previous?.version === version) return keyring.previous.key
  return null
}

export interface VerifiableSnapshot {
  payload: GatewaySnapshotPayload
  signature: string
  signingKeyId: string
}

/** Constant-time verification of a stored snapshot. Fail-closed. */
export function verifySnapshot(snapshot: VerifiableSnapshot, keyring?: Keyring): SnapshotVerifyResult {
  const reasons: string[] = []
  const kr = keyring ?? defaultKeyring()

  const payload = snapshot.payload as Partial<GatewaySnapshotPayload> | null
  if (!payload || payload.schema_version !== SNAPSHOT_SCHEMA_VERSION || payload.kind !== SNAPSHOT_KIND) {
    reasons.push('wrong_payload_kind')
  }
  if (!snapshot.signature) reasons.push('signature_missing')

  const versionMatch = /^hmac-sha256:v(\d+)$/.exec(snapshot.signingKeyId ?? '')
  if (!versionMatch) {
    reasons.push('unknown_key_version')
  } else {
    const key = keyForVersion(kr, Number(versionMatch[1]))
    if (!key) reasons.push('unknown_key_version')
    else if (snapshot.signature) {
      const expected = hmac(key, canonicalJson(snapshot.payload))
      const a = Buffer.from(expected, 'hex')
      const b = Buffer.from(snapshot.signature, 'hex')
      if (a.length !== b.length || !timingSafeEqual(a, b)) reasons.push('signature_mismatch')
    }
  }

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] }
}
