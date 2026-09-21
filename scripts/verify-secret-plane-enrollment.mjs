// Independent operator fixture; never imported into Control Plane.
import { enrollCredential, signRegistry } from './secret-enroll.mjs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { request } from 'node:https'
import { createDecipheriv, generateKeyPairSync, randomBytes, timingSafeEqual, verify } from 'node:crypto'

const root = resolve('.test-artifacts/vault-reference'),
  output = resolve(root, 'runtime')
async function main() {
  await mkdir(output, { recursive: true })
  const secret = Buffer.from(randomBytes(32).toString('hex'))
  const entries = []
  for (const credentialVersion of [1, 2]) {
    const entry = await enrollCredential({
      request: {
        tenant_id: 'fixture-tenant',
        credential_id: 'fixture-credential',
        credential_version: credentialVersion,
        provider_id: 'fixture-provider',
        allowed_https_origins: ['https://api.example.com'],
        vault: { mount: 'transit', key: 'nexus-provider-v1' },
      },
      secret,
      vaultUrl: 'https://127.0.0.1:58201',
      vaultTokenFile: resolve(root, 'identity/encryptor-token'),
      vaultCaFile: resolve(root, 'tls/ca.pem'),
    })
    const ca = await readFile(resolve(root, 'tls/ca.pem')),
      token = (await readFile(resolve(root, 'identity/gateway-token'), 'utf8')).trim()
    const decrypted = await new Promise((accept, reject) => {
      const req = request(
        'https://127.0.0.1:58201/v1/transit/decrypt/nexus-provider-v1',
        { ca, method: 'POST', headers: { 'content-type': 'application/json', 'x-vault-token': token }, timeout: 10000 },
        (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => {
            if (res.statusCode !== 200) return reject(new Error('Gateway-role unwrap refused'))
            try {
              accept(JSON.parse(body).data.plaintext)
            } catch {
              reject(new Error('Invalid Vault response'))
            }
          })
        },
      )
      req.on('error', () => reject(new Error('Vault TLS failed')))
      req.on('timeout', () => req.destroy())
      req.end(JSON.stringify({ ciphertext: entry.vault.wrapped_dek, context: entry.context_base64 }))
    })
    const dek = Buffer.from(decrypted, 'base64')
    if (dek.length !== 32) throw new Error('Wrong DEK length')
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(entry.encrypted.nonce_base64, 'base64'))
    decipher.setAAD(Buffer.from(entry.context_base64, 'base64'))
    decipher.setAuthTag(Buffer.from(entry.encrypted.tag_base64, 'base64'))
    const clear = Buffer.concat([
      decipher.update(Buffer.from(entry.encrypted.ciphertext_base64, 'base64')),
      decipher.final(),
    ])
    if (!timingSafeEqual(clear, secret)) throw new Error('Envelope mismatch')
    dek.fill(0)
    clear.fill(0)
    entries.push(entry)
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'),
    now = Date.now()
  const payload = Buffer.from(
    JSON.stringify({
      format: 'nexus.secret-registry.payload.v1',
      registry_id: 'fixture-registry',
      registry_version: 1,
      revocation_epoch: 0,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60000).toISOString(),
      entries,
    }),
  )
  const signed = signRegistry({
    payloadBytes: payload,
    signingKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    signingKeyId: 'fixture-operator',
    now,
  })
  if (!verify(null, payload, publicKey, Buffer.from(signed.signature_base64, 'base64')))
    throw new Error('Registry signature mismatch')
  await writeFile(resolve(output, 'registry.json'), JSON.stringify(signed), { mode: 0o600 })
  await writeFile(
    resolve(output, 'trust.json'),
    JSON.stringify({
      'fixture-operator': publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    }),
    { mode: 0o600 },
  )
  await writeFile(
    resolve(output, 'floor.json'),
    JSON.stringify({ registry_id: 'fixture-registry', registry_version: 1, revocation_epoch: 0 }),
    { mode: 0o600 },
  )
  // Exact canary is passed only through an ignored private test input, never argv/output/receipt.
  await writeFile(resolve(output, 'expected-canary'), secret, { mode: 0o600 })
  secret.fill(0)
  const receipt = {
    format: 'nexus.secret-enrollment.fixture.v1',
    recordedAt: new Date().toISOString(),
    checks: {
      intake_encryptor_approle_tls: 'passed',
      gateway_agent_approle_unwrap: 'passed',
      aes_gcm_context_roundtrip: 'passed',
      independent_ed25519_raw_payload_signature: 'passed',
    },
    checksPassed: 4,
    credentialVersions: [1, 2],
    limitations: [
      'Local operator fixture; no production signer custody assertion',
      'Signed fixture expires after 60 seconds; regenerate immediately before Go test',
      'Canary retained only in ignored private runtime input for cross-language equality test',
    ],
  }
  await writeFile(resolve(root, 'enrollment-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
}
main().catch(() => {
  console.error('Secret enrollment fixture failed; sensitive diagnostics suppressed')
  process.exitCode = 1
})
