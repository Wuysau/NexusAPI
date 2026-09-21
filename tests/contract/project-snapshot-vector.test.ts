import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { expect, it } from 'vitest'
import { canonicalJson } from '@/lib/catalog/snapshot'
import { buildKeyring } from '@/lib/crypto'

it('signs additive Project identity with the same canonical encoder as the N-1 bundle', () => {
  for (const path of ['services/gateway/testdata/bundle-vector.json', 'tests/contract/fixtures/project-bundle.json']) {
    const vector = JSON.parse(readFileSync(path, 'utf8'))
    const canonical = canonicalJson(vector.envelope.bundle)
    const keyring = buildKeyring({ upstreamEncryptionKey: vector.passphrase })
    expect(canonical).toBe(vector.canonical)
    expect(createHmac('sha256', keyring.current.key).update(canonical).digest('hex')).toBe(vector.envelope.signature)
  }
})
