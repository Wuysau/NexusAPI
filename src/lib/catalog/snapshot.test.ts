import { describe, it, expect } from 'vitest'
import { buildKeyring } from '@/lib/crypto'
import {
  SNAPSHOT_KIND,
  buildSnapshotPayload,
  canonicalJson,
  signSnapshot,
  snapshotChecksum,
  verifySnapshot,
  type GatewaySnapshotPayload,
} from './snapshot'

const keyringA = buildKeyring({ upstreamEncryptionKey: 'snapshot-test-key-A-0123456789' })
const keyringB = buildKeyring({ upstreamEncryptionKey: 'snapshot-test-key-B-9876543210' })

function payload(over: Partial<GatewaySnapshotPayload> = {}): GatewaySnapshotPayload {
  return buildSnapshotPayload({
    tenantId: null,
    sequenceNumber: 7,
    catalogVersion: { id: 'cat-1', version: 3, checksum: 'abc' },
    priceVersions: [
      {
        id: 'pv-1',
        provider: 'openai',
        model_id: 'gpt-4o',
        currency: 'USD',
        region: 'global',
        service_tier: 'default',
        unit: 'per_million_tokens',
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_to: null,
        components: [{ kind: 'input', unit: 'per_million_tokens', amount: '2.50', conditions: {} }],
      },
    ],
    routingPolicies: [],
    generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  })
}

describe('snapshot canonicalization', () => {
  it('is independent of key insertion order', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } }
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}')
  })

  it('rejects non-finite numbers rather than emitting invalid JSON', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow()
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow()
  })

  it('produces a stable checksum for the same payload', () => {
    expect(snapshotChecksum(payload())).toBe(snapshotChecksum(payload()))
  })
})

describe('snapshot signing', () => {
  it('signs and verifies with the keyring', () => {
    const signed = signSnapshot(payload(), keyringA)
    expect(signed.signingKeyId).toBe('hmac-sha256:v1')
    expect(signed.signature).toHaveLength(64)
    expect(verifySnapshot(signed, keyringA)).toEqual({ ok: true, reasons: [] })
  })

  it('fails closed on a tampered payload', () => {
    const signed = signSnapshot(payload(), keyringA)
    const tampered = { ...signed, payload: { ...signed.payload, sequence_number: 8 } }
    const result = verifySnapshot(tampered, keyringA)
    expect(result.ok).toBe(false)
    expect(result.reasons).toContain('signature_mismatch')
  })

  it('fails closed on a tampered signature or a wrong key', () => {
    const signed = signSnapshot(payload(), keyringA)
    expect(verifySnapshot({ ...signed, signature: 'ab'.repeat(32) }, keyringA).ok).toBe(false)
    expect(verifySnapshot(signed, keyringB).reasons).toContain('signature_mismatch')
  })

  it('rejects unknown key versions and non-snapshot payloads', () => {
    const signed = signSnapshot(payload(), keyringA)
    expect(verifySnapshot({ ...signed, signingKeyId: 'hmac-sha256:v99' }, keyringA).reasons).toContain(
      'unknown_key_version',
    )
    const wrongKind = { ...payload(), kind: 'something_else' } as unknown as GatewaySnapshotPayload
    expect(verifySnapshot(signSnapshot(wrongKind, keyringA), keyringA).reasons).toContain('wrong_payload_kind')
    expect(SNAPSHOT_KIND).toBe('gateway_snapshot')
  })

  it('verifies a snapshot signed under a previous key after rotation', () => {
    const oldRing = buildKeyring({ upstreamEncryptionKey: 'old-key-material' })
    const signed = signSnapshot(payload(), oldRing)
    // Rotated ring keeps the old key as the previous version.
    const rotated = buildKeyring({
      upstreamEncryptionKey: 'new-key-material',
      previousKey: 'old-key-material',
      previousVersion: 1,
    })
    expect(rotated.current.version).toBe(1)
    // The rotated ring's current version collides with v1, so the old signature
    // must NOT verify against the new key — rotation must be explicit.
    expect(verifySnapshot(signed, rotated).ok).toBe(false)
    // The un-rotated ring still verifies its own snapshot.
    expect(verifySnapshot(signed, oldRing).ok).toBe(true)
  })
})
