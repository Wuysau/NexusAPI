import { changeMember, parseMemberRole } from '@/lib/workspace/members'
import { workspaceRouteError } from '@/lib/workspace/management'
import { auditControlPlane, jsonOk, readJsonBody, requireContext } from '../../../_lib/control-plane'

export const dynamic = 'force-dynamic'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await requireContext(req, 'member:update-role')
    const body = await readJsonBody<{ role?: unknown }>(req)
    const role = parseMemberRole(body?.role)
    const change = await changeMember(ctx, id, role)
    await auditControlPlane(ctx, 'member.role_changed', { type: 'membership', id }, change)
    return jsonOk({ id, role })
  } catch (error) {
    return workspaceRouteError(error)
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await requireContext(req, 'member:remove')
    const change = await changeMember(ctx, id)
    await auditControlPlane(ctx, 'member.removed', { type: 'membership', id }, change)
    return jsonOk({ id, removed: true })
  } catch (error) {
    return workspaceRouteError(error)
  }
}
