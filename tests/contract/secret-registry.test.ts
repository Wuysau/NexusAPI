import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'

// Contract-only fixtures. These do not claim runtime signature or Vault validation.
const schemaPath = resolve('packages/contracts/schemas/secret-registry.schema.json')
function validators() {
  const ajv = new Ajv({ strict: true, allErrors: true })
  addFormats(ajv)
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  ajv.addSchema(schema)
  return { outer: ajv.getSchema(schema.$id)!, payload: ajv.getSchema(`${schema.$id}#/$defs/payload`)! }
}
const entry = {
  tenant_id: 'tenant-fixture',
  credential_id: 'credential-fixture',
  credential_version: 1,
  provider_id: 'provider-fixture',
  allowed_https_origins: ['https://api.example.com'],
  context_base64: Buffer.from(
    '["nexus.provider-credential.v1","tenant-fixture","credential-fixture",1,"provider-fixture"]',
  ).toString('base64'),
  vault: { mount: 'nexus-transit', key: 'tenant-fixture', wrapped_dek: 'vault:v1:ZmFrZQ==' },
  encrypted: {
    algorithm: 'AES-256-GCM',
    nonce_base64: 'AAAAAAAAAAAAAAAA',
    ciphertext_base64: 'ZmFrZQ==',
    tag_base64: 'AAAAAAAAAAAAAAAAAAAAAA==',
  },
}
function payload() {
  return {
    format: 'nexus.secret-registry.payload.v1',
    registry_id: 'fixture-registry',
    registry_version: 1,
    revocation_epoch: 0,
    issued_at: '2026-09-15T00:00:00Z',
    expires_at: '2026-09-15T00:01:00Z',
    entries: [structuredClone(entry)],
  }
}
function outer() {
  return {
    format: 'nexus.secret-registry.signed.v1',
    signing_key_id: 'operator-fixture',
    payload_base64: Buffer.from(JSON.stringify(payload())).toString('base64'),
    signature_base64: Buffer.alloc(64).toString('base64'),
  }
}
describe('operator-signed secret registry wire schema', () => {
  it('accepts a complete encrypted payload and detached signature envelope', () => {
    const checks = validators()
    expect(checks.outer(outer())).toBe(true)
    expect(checks.payload(payload())).toBe(true)
  })
  it('allows an empty complete snapshot to revoke every credential', () => {
    expect(validators().payload({ ...payload(), registry_version: 2, revocation_epoch: 1, entries: [] })).toBe(true)
  })
  it.each([
    'tenant_id',
    'credential_id',
    'credential_version',
    'provider_id',
    'allowed_https_origins',
    'context_base64',
    'vault',
    'encrypted',
  ])('requires signed binding %s', (key) => {
    const data = payload()
    Reflect.deleteProperty(data.entries[0], key)
    expect(validators().payload(data)).toBe(false)
  })
  it.each(['registry_version', 'revocation_epoch', 'issued_at', 'expires_at', 'registry_id'])(
    'requires freshness binding %s',
    (key) => {
      const data = payload()
      Reflect.deleteProperty(data, key)
      expect(validators().payload(data)).toBe(false)
    },
  )
  it.each([
    'http://api.example.com',
    'https://api.example.com/path',
    'https://user:pass@api.example.com',
    'https://*.example.com',
    'https://api.example.com?url=evil',
    'https://api.example.com#evil',
  ])('rejects unsafe origin shape %s', (origin) => {
    const data = payload()
    data.entries[0].allowed_https_origins = [origin]
    expect(validators().payload(data)).toBe(false)
  })
  it.each([
    ['plaintext', { secret: 'synthetic-must-not-be-accepted' }],
    ['caller role', { role: 'gateway' }],
    ['identity token', { vault_token: 'synthetic-must-not-be-accepted' }],
  ])('rejects %s metadata', (_label, fields) => {
    expect(validators().payload({ ...payload(), ...fields })).toBe(false)
  })
  it('rejects credential injection and arbitrary Vault paths', () => {
    const data = payload()
    Object.assign(data.entries[0], { secret: 'synthetic' })
    expect(validators().payload(data)).toBe(false)
    const other = payload()
    other.entries[0].vault.mount = '../sys'
    expect(validators().payload(other)).toBe(false)
  })
  it.each(['invalid!', '', 'YQ', 'YQ==='])('rejects malformed base64 %s', (bytes) => {
    expect(validators().outer({ ...outer(), payload_base64: bytes })).toBe(false)
  })
  it('rejects short signatures, unknown algorithms, versions and fields', () => {
    const checks = validators()
    expect(checks.outer({ ...outer(), signature_base64: 'YQ==' })).toBe(false)
    expect(checks.outer({ ...outer(), algorithm: 'HS256' })).toBe(false)
    expect(checks.payload({ ...payload(), format: 'nexus.secret-registry.payload.v2' })).toBe(false)
  })
  it('rejects missing authenticated cipher components and invalid timestamp', () => {
    const data = payload()
    Reflect.deleteProperty(data.entries[0].encrypted, 'tag_base64')
    expect(validators().payload(data)).toBe(false)
    expect(validators().payload({ ...payload(), expires_at: 'tomorrow' })).toBe(false)
  })
})
