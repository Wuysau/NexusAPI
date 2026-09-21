// Independent operator workload only. Never import this module into Next/CP.
import { createCipheriv, createPrivateKey, randomBytes, sign } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const refuse = () => {
  throw new Error('Secret enrollment rejected by schema or workload policy')
}
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const keys = (value, expected) => {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join('|') !== [...expected].sort().join('|')
  )
    refuse()
}
const integer = (value, minimum) => {
  if (!Number.isSafeInteger(value) || value < minimum) refuse()
}
function base64(value, size, max = 1048576) {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > max ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    refuse()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) refuse()
  return bytes
}

/** Strict UTF-8 JSON, preserving the original bytes for signatures. */
export function parseStrictJson(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 12 * 1024 * 1024) refuse()
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    refuse()
  }
  let pos = 0
  const ws = () => {
    while (/[\x20\t\r\n]/.test(text[pos] ?? '\0')) pos++
  }
  function string() {
    const start = pos++
    while (pos < text.length) {
      if (text[pos] === '\\') {
        pos += 2
        continue
      }
      if (text[pos++] === '"') {
        try {
          return JSON.parse(text.slice(start, pos))
        } catch {
          refuse()
        }
      }
    }
    refuse()
  }
  function value(depth) {
    if (depth > 64) refuse()
    ws()
    if (text[pos] === '"') return string()
    if (text[pos] === '{') {
      pos++
      ws()
      const obj = Object.create(null),
        seen = new Set()
      if (text[pos] === '}') {
        pos++
        return obj
      }
      while (true) {
        ws()
        if (text[pos] !== '"') refuse()
        const key = string()
        if (seen.has(key)) refuse()
        seen.add(key)
        ws()
        if (text[pos++] !== ':') refuse()
        obj[key] = value(depth + 1)
        ws()
        if (text[pos] === '}') {
          pos++
          return obj
        }
        if (text[pos++] !== ',') refuse()
      }
    }
    if (text[pos] === '[') {
      pos++
      ws()
      const arr = []
      if (text[pos] === ']') {
        pos++
        return arr
      }
      while (true) {
        arr.push(value(depth + 1))
        ws()
        if (text[pos] === ']') {
          pos++
          return arr
        }
        if (text[pos++] !== ',') refuse()
      }
    }
    for (const [literal, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ]) {
      if (text.startsWith(literal, pos)) {
        pos += literal.length
        return result
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos))
    if (!match) refuse()
    pos += match[0].length
    const number = Number(match[0])
    if (!Number.isSafeInteger(number) || /[.eE]/.test(match[0])) refuse()
    return number
  }
  const result = value(0)
  ws()
  if (pos !== text.length) refuse()
  return result
}

export function credentialContext(entry) {
  for (const key of ['tenant_id', 'credential_id', 'provider_id']) if (!identifier(entry[key])) refuse()
  integer(entry.credential_version, 1)
  return Buffer.from(
    JSON.stringify([
      'nexus.provider-credential.v1',
      entry.tenant_id,
      entry.credential_id,
      entry.credential_version,
      entry.provider_id,
    ]),
  )
}

function origins(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16 || new Set(values).size !== values.length)
    refuse()
  for (const value of values) {
    if (
      typeof value !== 'string' ||
      value.length > 300 ||
      !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[1-9][0-9]{0,4})?$/.test(
        value,
      )
    )
      refuse()
    let url
    try {
      url = new URL(value)
    } catch {
      refuse()
    }
    if (url.origin !== value || /\.(localhost|local|internal)$/.test(url.hostname)) refuse()
  }
}
function validateEntry(entry) {
  keys(entry, [
    'tenant_id',
    'credential_id',
    'credential_version',
    'provider_id',
    'allowed_https_origins',
    'context_base64',
    'vault',
    'encrypted',
  ])
  if (credentialContext(entry).toString('base64') !== entry.context_base64) refuse()
  origins(entry.allowed_https_origins)
  keys(entry.vault, ['mount', 'key', 'wrapped_dek'])
  if (!identifier(entry.vault.mount) || !identifier(entry.vault.key)) refuse()
  const wrapped = entry.vault.wrapped_dek
  if (typeof wrapped !== 'string' || wrapped.length > 16384 || !/^vault:v[1-9][0-9]*:/.test(wrapped)) refuse()
  base64(wrapped.split(':')[2])
  if (wrapped.split(':').length !== 3) refuse()
  integer(Number(wrapped.split(':')[1].slice(1)), 1)
  keys(entry.encrypted, ['algorithm', 'nonce_base64', 'ciphertext_base64', 'tag_base64'])
  if (entry.encrypted.algorithm !== 'AES-256-GCM') refuse()
  base64(entry.encrypted.nonce_base64, 12)
  base64(entry.encrypted.tag_base64, 16)
  base64(entry.encrypted.ciphertext_base64)
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    refuse()
  const parts = value.match(/\d+/g).map(Number)
  if (
    parts[1] < 1 ||
    parts[1] > 12 ||
    parts[2] < 1 ||
    parts[2] > new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate() ||
    parts[3] > 23 ||
    parts[4] > 59 ||
    parts[5] > 59
  )
    refuse()
  const result = Date.parse(value)
  if (!Number.isFinite(result)) refuse()
  return result
}
export function validateRegistryPayload(payloadBytes, now = Date.now()) {
  const payload = parseStrictJson(payloadBytes)
  keys(payload, ['format', 'registry_id', 'registry_version', 'revocation_epoch', 'issued_at', 'expires_at', 'entries'])
  if (payload.format !== 'nexus.secret-registry.payload.v1' || !identifier(payload.registry_id)) refuse()
  integer(payload.registry_version, 1)
  integer(payload.revocation_epoch, 0)
  const issued = timestamp(payload.issued_at),
    expires = timestamp(payload.expires_at)
  if (issued > now || expires <= now || expires <= issued || expires - issued > 60000) refuse()
  if (!Array.isArray(payload.entries) || payload.entries.length > 10000) refuse()
  const tuples = new Set()
  for (const entry of payload.entries) {
    validateEntry(entry)
    const tuple = JSON.stringify([entry.tenant_id, entry.credential_id, entry.credential_version])
    if (tuples.has(tuple)) refuse()
    tuples.add(tuple)
  }
  return payload
}

export function signRegistry({ payloadBytes, signingKey, signingKeyId, now = Date.now() }) {
  validateRegistryPayload(payloadBytes, now)
  if (!identifier(signingKeyId)) refuse()
  const key = createPrivateKey(signingKey)
  if (key.asymmetricKeyType !== 'ed25519') refuse()
  return {
    format: 'nexus.secret-registry.signed.v1',
    signing_key_id: signingKeyId,
    payload_base64: payloadBytes.toString('base64'),
    signature_base64: sign(null, payloadBytes, key).toString('base64'),
  }
}

async function wrapDek({ url, token, ca, plaintext, context }) {
  const body = Buffer.from(JSON.stringify({ plaintext, context }))
  try {
    return await new Promise((resolvePromise, reject) => {
      const req = httpsRequest(
        url,
        {
          method: 'POST',
          ca,
          rejectUnauthorized: true,
          timeout: 5000,
          headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json', 'Content-Length': body.length },
        },
        (response) => {
          const chunks = []
          let size = 0
          response.on('data', (chunk) => {
            size += chunk.length
            if (size > 1048576) response.destroy(new Error('Vault response rejected'))
            else chunks.push(chunk)
          })
          response.on('error', reject)
          response.on('end', () => {
            if (response.statusCode !== 200) {
              reject(new Error('Vault encryption denied'))
              return
            }
            try {
              resolvePromise(parseStrictJson(Buffer.concat(chunks)).data.ciphertext)
            } catch {
              reject(new Error('Vault response rejected'))
            }
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error('Vault encryption timed out')))
      req.on('error', () => reject(new Error('Vault encryption unavailable')))
      req.end(body)
    })
  } finally {
    body.fill(0)
  }
}

export async function enrollCredential({ request, secret, vaultUrl, vaultTokenFile, vaultCaFile }) {
  keys(request, ['tenant_id', 'credential_id', 'credential_version', 'provider_id', 'allowed_https_origins', 'vault'])
  keys(request.vault, ['mount', 'key'])
  const context = credentialContext(request)
  origins(request.allowed_https_origins)
  if (
    !identifier(request.vault.mount) ||
    !identifier(request.vault.key) ||
    !Buffer.isBuffer(secret) ||
    secret.length < 1 ||
    secret.length > 786432
  )
    refuse()
  const url = new URL(vaultUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    refuse()
  url.pathname = `/v1/${request.vault.mount}/encrypt/${request.vault.key}`
  const tokenBytes = await readFile(vaultTokenFile),
    ca = await readFile(vaultCaFile)
  const dek = randomBytes(32),
    nonce = randomBytes(12)
  try {
    const token = tokenBytes.toString('utf8').trim()
    if (!token || token.length > 8192 || /\s/.test(token)) refuse()
    const cipher = createCipheriv('aes-256-gcm', dek, nonce)
    cipher.setAAD(context)
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()])
    const wrapped = await wrapDek({
      url,
      token,
      ca,
      plaintext: dek.toString('base64'),
      context: context.toString('base64'),
    })
    const entry = {
      ...request,
      context_base64: context.toString('base64'),
      vault: { ...request.vault, wrapped_dek: wrapped },
      encrypted: {
        algorithm: 'AES-256-GCM',
        nonce_base64: nonce.toString('base64'),
        ciphertext_base64: ciphertext.toString('base64'),
        tag_base64: cipher.getAuthTag().toString('base64'),
      },
    }
    validateEntry(entry)
    return entry
  } finally {
    dek.fill(0)
    tokenBytes.fill(0)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2),
    flags = {}
  try {
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i]?.startsWith('--') || !args[i + 1] || args[i] in flags) refuse()
      flags[args[i]] = args[i + 1]
    }
    let output
    if (mode === 'enroll') {
      keys(flags, [
        '--request-file',
        '--secret-file',
        '--vault-url',
        '--vault-token-file',
        '--vault-ca-file',
        '--output',
      ])
      const secret = await readFile(flags['--secret-file'])
      try {
        output = await enrollCredential({
          request: parseStrictJson(await readFile(flags['--request-file'])),
          secret,
          vaultUrl: flags['--vault-url'],
          vaultTokenFile: flags['--vault-token-file'],
          vaultCaFile: flags['--vault-ca-file'],
        })
      } finally {
        secret.fill(0)
      }
    } else if (mode === 'sign') {
      keys(flags, ['--payload-file', '--signing-key-file', '--signing-key-id', '--output'])
      const signingKey = await readFile(flags['--signing-key-file'])
      try {
        output = signRegistry({
          payloadBytes: await readFile(flags['--payload-file']),
          signingKey,
          signingKeyId: flags['--signing-key-id'],
        })
      } finally {
        signingKey.fill(0)
      }
    } else refuse()
    const temp = `${flags['--output']}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temp, JSON.stringify(output) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temp, flags['--output'])
    console.log(JSON.stringify({ status: 'complete', operation: mode }))
  } catch {
    console.error('Operator enrollment refused; inspect nonsecret configuration and independent workload authority')
    process.exitCode = 1
  }
}
