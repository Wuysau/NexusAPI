import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import { apiError } from '@/app/api/_lib/control-plane'
import { withOrganizationAdmin } from './members'
import { WorkspaceError, workspaceRouteError } from './management'

export interface ConfigurationInput {
  providerId?: unknown
  upstreamModelId?: unknown
  displayName?: unknown
  notes?: unknown
  expectedVersion?: unknown
  archived?: unknown
}
function boundedText(value: unknown, name: string, max: number, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.trim().length > max)
    throw new WorkspaceError('invalid_field', `${name}${allowEmpty ? '' : '不能为空，且'}最多 ${max} 个字符`, 400)
  return value.trim()
}
export async function createModelConfiguration(ctx: ControlPlaneContext, input: ConfigurationInput | null) {
  const providerId = boundedText(input?.providerId, '供应商', 160)
  const upstreamModelId = boundedText(input?.upstreamModelId, '模型 ID', 200)
  const displayName = boundedText(input?.displayName, '显示名称', 120)
  const notes = boundedText(input?.notes ?? '', '备注', 2000, true)
  return withOrganizationAdmin(ctx, 'model:manage', async (client) => {
    const provider = await client.query('SELECT id FROM providers WHERE id=$1 AND enabled=true', [providerId])
    if (!provider.rows.length) throw new WorkspaceError('invalid_provider', '请选择已启用的供应商', 400)
    return (
      await client.query(
        `INSERT INTO organization_model_configurations(tenant_id,organization_id,provider_id,upstream_model_id,display_name,notes)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,version`,
        [ctx.tenantId, ctx.organizationId, providerId, upstreamModelId, displayName, notes],
      )
    ).rows[0]
  })
}
export async function updateModelConfiguration(
  ctx: ControlPlaneContext,
  id: string,
  input: ConfigurationInput | null,
  remove = false,
) {
  const version = input?.expectedVersion
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version >= 2147483647)
    throw new WorkspaceError('invalid_version', '请刷新后使用当前配置版本重试', 400)
  if (input?.archived !== undefined && typeof input.archived !== 'boolean')
    throw new WorkspaceError('invalid_status', '配置状态无效', 400)
  if (!remove && input?.archived === undefined && input?.displayName === undefined && input?.notes === undefined)
    throw new WorkspaceError('invalid_request', '没有可更新的字段', 400)
  if (input?.providerId !== undefined || input?.upstreamModelId !== undefined)
    throw new WorkspaceError('immutable_identity', '供应商和模型 ID 不可修改，请创建另一项配置', 400)
  const name = input?.displayName === undefined ? null : boundedText(input.displayName, '显示名称', 120)
  const notes = input?.notes === undefined ? null : boundedText(input.notes, '备注', 2000, true)
  return withOrganizationAdmin(ctx, 'model:manage', async (client) => {
    const record = await client.query(
      'SELECT version FROM organization_model_configurations WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 FOR UPDATE',
      [id, ctx.tenantId, ctx.organizationId],
    )
    if (!record.rows.length) throw new WorkspaceError('not_found', '模型配置不存在', 404)
    if (record.rows[0].version !== version)
      throw new WorkspaceError('version_conflict', '配置已被修改，请刷新后重试', 409)
    return (
      await client.query(
        `UPDATE organization_model_configurations SET display_name=COALESCE($4,display_name),notes=COALESCE($5,notes),
      archived_at=CASE WHEN $6::boolean THEN now() WHEN $6::boolean=false THEN NULL ELSE archived_at END,version=version+1,updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 RETURNING id,version,archived_at AS "archivedAt"`,
        [id, ctx.tenantId, ctx.organizationId, name, notes, remove ? true : (input?.archived ?? null)],
      )
    ).rows[0]
  })
}
export function modelConfigurationError(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
    return apiError(409, 'configuration_exists', '该模型已有组织配置，请编辑现有配置或从已移除列表恢复')
  return workspaceRouteError(error)
}
