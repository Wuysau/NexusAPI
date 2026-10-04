import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, link, unlink, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isIP } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { publicDiagnosticAddress } from './outbound'

export class LocalCredentialError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}
export const LOCAL_CREDENTIAL_FORMAT = 'nexus.local-credential.v1'
export const LOCAL_CREDENTIAL_MODELS_FORMAT = 'nexus.local-credential.v2'
export interface LocalCredentialBinding {
  tenant_id: string
  credential_id: string
  credential_version: number
  provider_id: string
  base_url: string
  protocol: 'openai' | 'anthropic'
  model: string
  models?: string[]
}
export interface LocalCredentialEnvelope extends LocalCredentialBinding {
  format: typeof LOCAL_CREDENTIAL_FORMAT | typeof LOCAL_CREDENTIAL_MODELS_FORMAT
  nonce: string
  tag: string
  ciphertext: string
  fingerprint: string
}
const denied = () =>
  new LocalCredentialError('credential_unavailable', '本地密钥不可用，请检查密钥存储或重新保存 API Key', 409)

export function localKeyInputAllowed(
  req: Request,
  mutation = false,
  source: Record<string, string | undefined> = process.env,
) {
  try {
    const origin = new URL(source.NEXUS_DESKTOP_ORIGIN ?? '')
    return (
      source.NODE_ENV !== 'production' &&
      ['http:', 'https:'].includes(origin.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
      origin.origin === source.NEXUS_DESKTOP_ORIGIN &&
      req.headers.get('host') === origin.host &&
      (!mutation || req.headers.get('origin') === origin.origin)
    )
  } catch {
    return false
  }
}
export function assertLocalKeyInput(req: Request) {
  if (!localKeyInputAllowed(req, true))
    throw new LocalCredentialError('local_key_input_unavailable', 'API Key 录入仅在本机控制台开放', 403)
}
export function localCredentialDirectory() {
  if (process.env.NODE_ENV === 'production') throw denied()
  return resolve(
    /* turbopackIgnore: true */ process.env.NEXUS_LOCAL_CREDENTIAL_DIR || join(homedir(), '.nexusapi', 'credentials'),
  )
}
export function normalizeLocalEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    throw new LocalCredentialError('invalid_endpoint', '请填写有效的接口地址')
  let u: URL
  try {
    u = new URL(value.trim())
  } catch {
    throw new LocalCredentialError('invalid_endpoint', '请填写有效的接口地址')
  }
  const h = u.hostname.replace(/^\[|\]$/g, '')
  const v4 = h.split('.').map(Number)
  const privateHost =
    h === '::1' ||
    (isIP(h) === 4 &&
      (v4[0] === 10 ||
        v4[0] === 127 ||
        (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) ||
        (v4[0] === 192 && v4[1] === 168)))
  const forbiddenHost =
    (isIP(h) !== 0 && !privateHost && !publicDiagnosticAddress(h)) || h === 'metadata.google.internal'
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    /[%\\\x00-\x1f]/.test(decodeURIComponent(u.pathname)) ||
    forbiddenHost ||
    (u.protocol === 'http:' && !privateHost)
  )
    throw new LocalCredentialError(
      'invalid_endpoint',
      '公网接口请使用 HTTPS；本地 HTTP 仅支持明确的内网或回环 IP，地址不能含账号、参数或片段',
    )
  return u.toString().replace(/\/+$/, '')
}
export function localConnectionConfig(body: { baseUrl?: unknown; protocol?: unknown; model?: unknown }) {
  const baseUrl = normalizeLocalEndpoint(body.baseUrl)
  if (body.protocol !== 'openai' && body.protocol !== 'anthropic')
    throw new LocalCredentialError('invalid_protocol', '请选择 OpenAI 或 Anthropic 接口协议')
  if (
    typeof body.model !== 'string' ||
    !body.model.trim() ||
    body.model.length > 200 ||
    /[\x00-\x1f\x7f]/.test(body.model)
  )
    throw new LocalCredentialError('invalid_model', '请填写上游模型名称')
  return { baseUrl, protocol: body.protocol as 'openai' | 'anthropic', model: body.model.trim() }
}
export function localModelIds(value: unknown): string[] {
  const entries = typeof value === 'string' ? [value] : value
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 50)
    throw new LocalCredentialError('invalid_models', '请填写 1–50 个上游模型 ID')
  const models = entries.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 200 || /[\x00-\x1f\x7f]/.test(entry))
      throw new LocalCredentialError('invalid_models', '每个上游模型 ID 须为不超过 200 字符的有效文本')
    return entry.trim()
  })
  if (new Set(models).size !== models.length) throw new LocalCredentialError('invalid_models', '上游模型 ID 不能重复')
  return models
}
function validateBinding(b: LocalCredentialBinding) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.credential_id) ||
    !Number.isSafeInteger(b.credential_version) ||
    b.credential_version < 1 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(b.tenant_id) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(b.provider_id)
  )
    throw denied()
  const config = localConnectionConfig({ baseUrl: b.base_url, protocol: b.protocol, model: b.model })
  if (config.baseUrl !== b.base_url || config.model !== b.model) throw denied()
  if (b.models !== undefined) {
    const models = localModelIds(b.models)
    if (models[0] !== b.model || models.some((model, index) => model !== b.models![index])) throw denied()
  }
}
function aad(
  b: LocalCredentialBinding,
  format = b.models === undefined ? LOCAL_CREDENTIAL_FORMAT : LOCAL_CREDENTIAL_MODELS_FORMAT,
) {
  validateBinding(b)
  if (format === LOCAL_CREDENTIAL_MODELS_FORMAT && b.models === undefined) throw denied()
  return Buffer.from(
    JSON.stringify([
      format,
      b.tenant_id,
      b.credential_id,
      b.credential_version,
      b.provider_id,
      b.base_url,
      b.protocol,
      b.model,
      ...(format === LOCAL_CREDENTIAL_MODELS_FORMAT ? [b.models] : []),
    ]),
  )
}
export function encryptLocalCredential(
  binding: LocalCredentialBinding,
  secret: string,
  key: Buffer,
): LocalCredentialEnvelope {
  if (typeof secret !== 'string' || !secret || secret.length > 8192 || /[\s\x00-\x1f\x7f]/.test(secret))
    throw new LocalCredentialError('invalid_api_key', 'API Key 不能为空或包含空白字符（最多8192字符）')
  if (key.length !== 32) throw denied()
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad(binding))
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return {
    ...binding,
    format: binding.models === undefined ? LOCAL_CREDENTIAL_FORMAT : LOCAL_CREDENTIAL_MODELS_FORMAT,
    nonce: nonce.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    fingerprint: createHash('sha256').update(secret).digest('hex'),
  }
}
export function decryptLocalCredential(e: LocalCredentialEnvelope, key: Buffer): string {
  try {
    if (
      (e.format !== LOCAL_CREDENTIAL_FORMAT && e.format !== LOCAL_CREDENTIAL_MODELS_FORMAT) ||
      (e.format === LOCAL_CREDENTIAL_FORMAT && e.models !== undefined) ||
      !/^[0-9a-f]{24}$/.test(e.nonce) ||
      !/^[0-9a-f]{32}$/.test(e.tag) ||
      !/^(?:[0-9a-f]{2}){1,8192}$/.test(e.ciphertext)
    )
      throw denied()
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.nonce, 'hex'))
    d.setAAD(aad(e, e.format))
    d.setAuthTag(Buffer.from(e.tag, 'hex'))
    const secret = Buffer.concat([d.update(Buffer.from(e.ciphertext, 'hex')), d.final()]).toString('utf8')
    if (createHash('sha256').update(secret).digest('hex') !== e.fingerprint) throw denied()
    return secret
  } catch {
    throw denied()
  }
}
async function masterKey(dir: string, create: boolean) {
  const path = join(dir, 'master.key')
  if (create) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      const existing = await readFile(path)
      if (existing.length !== 32) throw denied()
      return existing
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    if ((await readdir(dir)).some((name) => name.endsWith('.json'))) throw denied()
    const temp = join(dir, `.master-${randomUUID()}`)
    try {
      await writeFile(temp, randomBytes(32), { flag: 'wx', mode: 0o600 })
      try {
        await link(temp, path)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
    } finally {
      await unlink(temp).catch(() => {})
    }
  }
  const key = await readFile(path)
  if (key.length !== 32) throw denied()
  return key
}
function credentialPath(b: LocalCredentialBinding, dir: string) {
  validateBinding(b)
  return join(dir, `${b.credential_id}.${b.credential_version}.json`)
}
export async function publishLocalCredential(
  b: LocalCredentialBinding,
  secret: string,
  dir = localCredentialDirectory(),
) {
  validateBinding(b)
  const key = await masterKey(dir, true)
  try {
    const e = encryptLocalCredential(b, secret, key)
    const temp = join(dir, `.credential-${randomUUID()}`)
    try {
      await writeFile(temp, JSON.stringify(e), { flag: 'wx', mode: 0o600 })
      await link(temp, credentialPath(b, dir))
    } finally {
      await unlink(temp).catch(() => {})
    }
    return e
  } finally {
    key.fill(0)
  }
}
export async function readLocalCredential(
  b: LocalCredentialBinding,
  dir = localCredentialDirectory(),
  expectedEnvelope?: LocalCredentialEnvelope,
) {
  const key = await masterKey(dir, false)
  try {
    const e = JSON.parse(await readFile(credentialPath(b, dir), 'utf8')) as LocalCredentialEnvelope
    if (expectedEnvelope && !isDeepStrictEqual(e, expectedEnvelope)) throw denied()
    // Legacy files authorize only the primary model. This local diagnostic read
    // never expands that grant; the gateway still requires exact v1 model match.
    if (!aad(e, e.format).equals(aad(b, e.format))) throw denied()
    return decryptLocalCredential(e, key)
  } catch {
    throw denied()
  } finally {
    key.fill(0)
  }
}
export async function removeLocalCredential(b: LocalCredentialBinding, dir = localCredentialDirectory()) {
  await unlink(credentialPath(b, dir)).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  })
}
