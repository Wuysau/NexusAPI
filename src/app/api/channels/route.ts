// Local desktop accepts encrypted API key onboarding; deployments retain external references.
import { pool } from '@/db'
import { assertLocalKeyInput, LocalCredentialError, localKeyInputAllowed } from '@/lib/channels/local-credentials'
import { createLocalChannel } from '@/lib/channels/local-management'
import { apiError, auditControlPlane, jsonOk, readJsonBody, requireContext, routeError } from '../_lib/control-plane'

export const dynamic = 'force-dynamic'

const CAPABILITIES = ['chat', 'embeddings', 'images', 'audio', 'tools', 'multimodal'] as const

interface ChannelRow {
  id: string
  name: string
  provider_id: string
  provider_code: string
  provider_name: string
  provider_credential_id: string | null
  capabilities: string[]
  region: string
  weight: number
  priority: number
  enabled: boolean
  tenant_id: string | null
  created_at: Date
  credential_name: string | null
  credential_enabled: boolean | null
  fingerprint: string | null
  last_verified_at: Date | null
  credential_type: string | null
  is_platform_managed: boolean | null
  metadata: Record<string, unknown> | null
  official_base_url: string
}

const SELECT_CHANNELS = `
  SELECT c.id, c.name, c.provider_id, p.code AS provider_code, p.name AS provider_name,
         c.provider_credential_id, c.capabilities, c.region, c.weight, c.priority, c.enabled,
         c.tenant_id, c.created_at,
         pc.name AS credential_name, pc.enabled AS credential_enabled, pc.fingerprint,
         pc.last_verified_at, pc.credential_type, pc.is_platform_managed, c.metadata, p.official_base_url
    FROM channels c
    JOIN providers p ON p.id = c.provider_id
    LEFT JOIN provider_credentials pc ON pc.id = c.provider_credential_id
   WHERE c.tenant_id = $1 OR c.tenant_id IS NULL
   ORDER BY c.created_at DESC`

function safeChannel(row: ChannelRow) {
  return {
    id: row.id,
    name: row.name,
    provider: { id: row.provider_id, code: row.provider_code, name: row.provider_name },
    capabilities: row.capabilities,
    region: row.region,
    weight: row.weight,
    priority: row.priority,
    enabled: row.enabled,
    isPlatform: row.tenant_id === null,
    createdAt: row.created_at.toISOString(),
    baseUrl: row.metadata?.credential_storage === 'local' ? row.metadata.base_url : row.official_base_url,
    protocol: row.metadata?.protocol ?? null,
    model: row.metadata?.model ?? null,
    models: Array.isArray(row.metadata?.models)
      ? row.metadata.models.filter((model): model is string => typeof model === 'string')
      : typeof row.metadata?.model === 'string'
        ? [row.metadata.model]
        : [],
    verification: row.metadata?.verification ?? null,
    credential: row.provider_credential_id
      ? {
          id: row.provider_credential_id,
          name: row.credential_name,
          enabled: row.credential_enabled,
          fingerprint: row.fingerprint,
          lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
          credentialType: row.credential_type,
          isPlatformManaged: row.is_platform_managed ?? false,
          storage: row.metadata?.credential_storage === 'local' ? 'local' : 'external',
        }
      : null,
  }
}

async function findProvider(ref: string): Promise<{ id: string; code: string } | null> {
  const result = await pool.query<{ id: string; code: string }>(
    'SELECT id, code FROM providers WHERE code = $1 OR id::text = $1 LIMIT 1',
    [ref],
  )
  return result.rows[0] ?? null
}

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'credential:read')
    const result = await pool.query<ChannelRow>(SELECT_CHANNELS, [ctx.tenantId])
    const providers = await pool.query<{ id: string; code: string; name: string }>(
      'SELECT id, code, name, official_base_url AS "baseUrl" FROM providers ORDER BY name',
    )
    const response = jsonOk({
      channels: result.rows.map(safeChannel),
      capabilities: CAPABILITIES,
      providers: providers.rows,
      localKeyInput: localKeyInputAllowed(req),
    })
    response.headers.set('cache-control', 'no-store')
    return response
  } catch (error) {
    return routeError(error)
  }
}

interface CreateChannelBody {
  name?: unknown
  provider?: unknown
  secret?: unknown
  credentialId?: unknown
  credentialVersion?: unknown
  capabilities?: unknown
  region?: unknown
  weight?: unknown
  priority?: unknown
  baseUrl?: unknown
  protocol?: unknown
  model?: unknown
  models?: unknown
}

export async function POST(req: Request) {
  try {
    const ctx = await requireContext(req, 'credential:create')
    const body = await readJsonBody<CreateChannelBody>(req)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 80) return apiError(400, 'invalid_request', '请填写渠道名称（不超过 80 字）')
    const local = body?.secret !== undefined
    if (local) assertLocalKeyInput(req)
    const credentialId = typeof body?.credentialId === 'string' ? body.credentialId : ''
    if (!local && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(credentialId))
      return apiError(400, 'invalid_request', '请提供独立注册的凭据 ID')
    const credentialVersion = body?.credentialVersion
    if (
      credentialVersion !== undefined &&
      (typeof credentialVersion !== 'number' || !Number.isSafeInteger(credentialVersion) || credentialVersion < 1)
    )
      return apiError(400, 'invalid_request', '凭据版本必须为正整数')

    const providerRef = typeof body?.provider === 'string' ? body.provider : ''
    const customProvider = providerRef === 'custom'
    if (customProvider && !local)
      return apiError(400, 'custom_requires_local', '自定义供应商仅支持本机控制台录入 API Key')
    const provider = customProvider ? { id: 'custom', code: 'custom' } : await findProvider(providerRef)
    if (!provider) return apiError(400, 'unknown_provider', '请选择有效的上游供应商')

    const capabilities = Array.isArray(body?.capabilities)
      ? (body.capabilities as unknown[]).filter(
          (c): c is string => typeof c === 'string' && (CAPABILITIES as readonly string[]).includes(c),
        )
      : ['chat']
    if (!capabilities.length) return apiError(400, 'invalid_request', '请至少选择一种能力')

    const weight = body?.weight === undefined ? 10 : Number(body.weight)
    if (!Number.isInteger(weight) || weight < 1 || weight > 100)
      return apiError(400, 'invalid_request', '权重范围为 1–100')
    const priority = body?.priority === undefined ? 0 : Number(body.priority)
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000)
      return apiError(400, 'invalid_request', '优先级范围为 0–1000')
    const region = typeof body?.region === 'string' && body.region.trim() ? body.region.trim().slice(0, 40) : 'global'

    if (local)
      return jsonOk(
        await createLocalChannel(ctx, {
          name,
          providerId: provider.id,
          customProvider,
          secret: body?.secret,
          baseUrl: body?.baseUrl,
          protocol: body?.protocol,
          model: body?.model,
          models: body?.models,
          capabilities,
          weight,
          priority,
          region,
        }),
        201,
      )

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "INSERT INTO provider_credentials(id,provider_id,organization_id,tenant_id,name,encrypted_secret) VALUES($1,$2,$3,$4,$5,'external-registry:v1') ON CONFLICT(id) DO NOTHING",
        [credentialId, provider.id, ctx.organizationId, ctx.tenantId, `${name} credential`],
      )
      const reference = await client.query(
        "SELECT id FROM provider_credentials WHERE id=$1 AND provider_id=$2 AND organization_id=$3 AND tenant_id=$4 AND encrypted_secret='external-registry:v1' AND enabled=true FOR SHARE",
        [credentialId, provider.id, ctx.organizationId, ctx.tenantId],
      )
      if (reference.rowCount !== 1) {
        await client.query('ROLLBACK')
        return apiError(409, 'credential_reference_conflict', '凭据引用不可用于当前租户和供应商')
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO channels (tenant_id, provider_id, provider_credential_id, name, capabilities, region, weight, priority, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb) RETURNING id`,
        [
          ctx.tenantId,
          provider.id,
          credentialId,
          name,
          JSON.stringify(capabilities),
          region,
          weight,
          priority,
          JSON.stringify(credentialVersion === undefined ? {} : { credential_version: credentialVersion }),
        ],
      )
      await client.query('COMMIT')
      await auditControlPlane(
        ctx,
        'channel.created',
        { type: 'channel', id: inserted.rows[0].id },
        {
          provider: provider.code,
          credentialId: credentialId,
          capabilities,
        },
      )
      const created = await pool.query<ChannelRow>(SELECT_CHANNELS, [ctx.tenantId])
      const row = created.rows.find((r) => r.id === inserted.rows[0].id)
      return jsonOk({ channel: row ? safeChannel(row) : null }, 201)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    if (error instanceof LocalCredentialError) return apiError(error.status, error.code, error.message)
    return routeError(error)
  }
}
