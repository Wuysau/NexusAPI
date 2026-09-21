import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
const modulePath = '../../scripts/secret-enroll.mjs'
const { credentialContext, parseStrictJson, signRegistry } = await import(modulePath)
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const signingKey = privateKey.export({ type: 'pkcs8', format: 'pem' })
const now = Date.now()
const entry = {
  tenant_id: 'tenant',
  credential_id: 'credential',
  credential_version: 1,
  provider_id: 'provider',
  allowed_https_origins: ['https://api.example.com'],
  context_base64: '',
  vault: { mount: 'transit', key: 'provider', wrapped_dek: `vault:v1:${Buffer.alloc(48).toString('base64')}` },
  encrypted: {
    algorithm: 'AES-256-GCM',
    nonce_base64: Buffer.alloc(12).toString('base64'),
    ciphertext_base64: Buffer.from('opaque').toString('base64'),
    tag_base64: Buffer.alloc(16).toString('base64'),
  },
}
entry.context_base64 = credentialContext(entry).toString('base64')
const payload = () => ({
  format: 'nexus.secret-registry.payload.v1',
  registry_id: 'registry',
  registry_version: 1,
  revocation_epoch: 0,
  issued_at: new Date(now - 1000).toISOString(),
  expires_at: new Date(now + 59000).toISOString(),
  entries: [structuredClone(entry)],
})
const sign = (text: string) =>
  signRegistry({ payloadBytes: Buffer.from(text), signingKey, signingKeyId: 'operator', now })
describe('independent operator registry signer', () => {
  it('signs exact original bytes including whitespace and derives the accepted context tuple', () => {
    const raw = JSON.stringify(payload(), null, 2)
    const signed = sign(raw)
    expect(Buffer.from(signed.payload_base64, 'base64').toString()).toBe(raw)
    expect(verify(null, Buffer.from(raw), publicKey, Buffer.from(signed.signature_base64, 'base64'))).toBe(true)
    expect(
      verify(null, Buffer.from(JSON.stringify(payload())), publicKey, Buffer.from(signed.signature_base64, 'base64')),
    ).toBe(false)
    expect(credentialContext(entry).toString()).toBe(
      '["nexus.provider-credential.v1","tenant","credential",1,"provider"]',
    )
  })
  it.each(['{"a":1,"a":2}', '{"a":{"x":1,"x":2}}', '{"a":9007199254740993}', '{"a":1} true', '{"a":NaN}'])(
    'rejects ambiguous JSON before signing: %s',
    (raw) => {
      expect(() => parseStrictJson(Buffer.from(raw))).toThrow()
    },
  )
  it('rejects malformed UTF-8 and BOM', () => {
    expect(() => parseStrictJson(Buffer.from([0xff]))).toThrow()
    expect(() => parseStrictJson(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]))).toThrow()
  })
  it('rejects unknown fields, duplicate bindings, incorrect context and origin normalization', () => {
    const extra = { ...payload(), unapproved: true }
    expect(() => sign(JSON.stringify(extra))).toThrow()
    const duplicate = payload()
    duplicate.entries.push(duplicate.entries[0])
    expect(() => sign(JSON.stringify(duplicate))).toThrow()
    const wrong = payload()
    wrong.entries[0].tenant_id = 'other'
    expect(() => sign(JSON.stringify(wrong))).toThrow()
    for (const origin of [
      'https://api.example.com:443',
      'https://api.example.com:65536',
      'https://127.0.0.1',
      'http://api.example.com',
      'https://API.example.com',
      'https://api.example.com/',
    ]) {
      const p = payload()
      p.entries[0].allowed_https_origins = [origin]
      expect(() => sign(JSON.stringify(p))).toThrow()
    }
  })
  it('refuses expired, future and overlong complete snapshots', () => {
    for (const times of [
      [-61000, -1000],
      [1000, 2000],
      [-1000, 60000],
    ]) {
      const p = payload()
      p.issued_at = new Date(now + times[0]).toISOString()
      p.expires_at = new Date(now + times[1]).toISOString()
      expect(() => sign(JSON.stringify(p))).toThrow()
    }
  })
})
