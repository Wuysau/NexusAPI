import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  decryptLocalCredential,
  encryptLocalCredential,
  normalizeLocalEndpoint,
  publishLocalCredential,
  readLocalCredential,
  localKeyInputAllowed,
  localModelIds,
} from './local-credentials'

const binding = () => ({
  tenant_id: 'tenant-a',
  credential_id: randomUUID(),
  credential_version: 1,
  provider_id: 'provider-qwen',
  base_url: 'http://192.168.50.10/dmx/anthropic',
  protocol: 'anthropic' as const,
  model: 'aliyun/qwen3.8-flash',
})
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
describe('local UI credential boundary', () => {
  it('accepts distinct model IDs while keeping a single legacy model readable', () => {
    expect(localModelIds([' model-large ', 'model-fast'])).toEqual(['model-large', 'model-fast'])
    expect(localModelIds('legacy-model')).toEqual(['legacy-model'])
    for (const invalid of [[], ['same', 'same'], ['valid', ''], ['valid', 3], Array(51).fill('model')])
      expect(() => localModelIds(invalid)).toThrow()
  })
  it('encrypts with randomized nonce, authenticates complete identity and endpoint, never serializes plaintext', () => {
    const key = randomBytes(32),
      b = binding(),
      secret = 'synthetic-test-credential'
    const first = encryptLocalCredential(b, secret, key),
      second = encryptLocalCredential(b, secret, key)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(JSON.stringify(first)).not.toContain(secret)
    expect(decryptLocalCredential(first, key)).toBe(secret)
    for (const change of [
      { tenant_id: 'other' },
      { credential_version: 2 },
      { base_url: 'https://attacker.example' },
      { protocol: 'openai' },
      { model: 'other' },
      { provider_id: 'other' },
      { ciphertext: '00' },
    ])
      expect(() => decryptLocalCredential({ ...first, ...change } as typeof first, key)).toThrow()
    expect(() => decryptLocalCredential(first, randomBytes(32))).toThrow()
  })
  it('allows explicit local HTTP but rejects public HTTP, metadata, secrets in URLs and malformed configuration', () => {
    expect(normalizeLocalEndpoint(' http://192.168.50.10/dmx/anthropic/ ')).toBe('http://192.168.50.10/dmx/anthropic')
    expect(normalizeLocalEndpoint('https://api.example.com/v1')).toBe('https://api.example.com/v1')
    for (const url of [
      'http://api.example.com',
      'http://169.254.169.254',
      'https://169.254.169.254',
      'https://100.100.100.200',
      'https://192.0.2.1',
      'http://8.8.8.8',
      'https://u:secret@example.com',
      'https://example.com/?key=secret',
      'https://example.com/#secret',
      'file:///tmp/a',
    ])
      expect(() => normalizeLocalEndpoint(url)).toThrow()
  })
  it('requires explicit nonproduction loopback host and exact origin', () => {
    const source = { NODE_ENV: 'development', NEXUS_DESKTOP_ORIGIN: 'http://127.0.0.1:3340' }
    const req = new Request(source.NEXUS_DESKTOP_ORIGIN + '/api/channels', {
      headers: { host: '127.0.0.1:3340', origin: source.NEXUS_DESKTOP_ORIGIN },
    })
    expect(localKeyInputAllowed(req, true, source)).toBe(true)
    expect(localKeyInputAllowed(req, true, { ...source, NODE_ENV: 'production' })).toBe(false)
    expect(localKeyInputAllowed(req, true, { ...source, NEXUS_DESKTOP_ORIGIN: 'http://remote.example' })).toBe(false)
    expect(
      localKeyInputAllowed(
        new Request(req.url, { headers: { host: '127.0.0.1:3340', origin: 'http://evil.example' } }),
        true,
        source,
      ),
    ).toBe(false)
  })
  it('persists one random master key and independently scoped immutable files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-local-credential-'))
    dirs.push(dir)
    const b = binding(),
      first = await publishLocalCredential(b, 'synthetic-secret-one', dir)
    const key = await readFile(join(dir, 'master.key'))
    expect(key.length).toBe(32)
    const next = await publishLocalCredential({ ...b, credential_version: 2 }, 'synthetic-secret-two', dir)
    expect(await readFile(join(dir, 'master.key'))).toEqual(key)
    expect(await readLocalCredential(first, dir)).toBe('synthetic-secret-one')
    expect(await readLocalCredential(next, dir)).toBe('synthetic-secret-two')
    await expect(publishLocalCredential(b, 'overwrite', dir)).rejects.toThrow()
    await expect(readLocalCredential({ ...first, tenant_id: 'other' }, dir)).rejects.toThrow()
    await expect(publishLocalCredential({ ...b, credential_id: '../escape' }, 'key', dir)).rejects.toThrow()
  })
  it('does not silently replace a lost master key when encrypted records exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-local-credential-'))
    dirs.push(dir)
    await publishLocalCredential(binding(), 'synthetic-secret', dir)
    await unlink(join(dir, 'master.key'))
    await expect(publishLocalCredential(binding(), 'another-synthetic-secret', dir)).rejects.toThrow()
    await expect(readFile(join(dir, 'master.key'))).rejects.toThrow()
  })
})
