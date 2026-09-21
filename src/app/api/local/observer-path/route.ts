import { apiError, auditControlPlane, jsonOk, readJsonBody, requireContext, routeError } from '../../_lib/control-plane'
import {
  desktopPickerHostAllowed,
  desktopPickerRequestAllowed,
  LocalPickerError,
  pickObserverPath,
} from '@/lib/observer/local-picker'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const allowedRole = (role: string) => role === 'owner' || role === 'admin'
const unavailable = '系统路径选择仅支持以 npm run dev:local 启动的本机 Windows 工作空间；其他环境请手动输入绝对路径。'
function noStore(response: Response) {
  response.headers.set('Cache-Control', 'no-store')
  return response
}
export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'credential:read')
    const available = allowedRole(ctx.membership.role) && desktopPickerHostAllowed(req)
    return noStore(
      jsonOk({
        available,
        reason: available
          ? null
          : !allowedRole(ctx.membership.role)
            ? '系统路径选择仅对本机工作空间管理员开放，你仍可手动填写路径。'
            : unavailable,
      }),
    )
  } catch (error) {
    return noStore(routeError(error))
  }
}
export async function POST(req: Request) {
  try {
    const ctx = await requireContext(req, 'credential:create')
    if (!allowedRole(ctx.membership.role))
      return noStore(apiError(403, 'forbidden', '仅本机工作空间管理员可以打开系统选择器'))
    if (!desktopPickerRequestAllowed(req)) return noStore(apiError(403, 'local_picker_unavailable', unavailable))
    const body = await readJsonBody<{ kind?: unknown }>(req)
    if (
      !body ||
      Object.keys(body).join(',') !== 'kind' ||
      typeof body.kind !== 'string' ||
      !['file', 'directory'].includes(body.kind)
    )
      return noStore(apiError(400, 'invalid_kind', '请选择文件夹或 JSONL 文件'))
    const kind = body.kind as 'file' | 'directory'
    const selectedPath = await pickObserverPath(kind, req.signal)
    await auditControlPlane(
      ctx,
      'observer.path_selected',
      { type: 'local_picker' },
      { kind, cancelled: selectedPath === null },
    )
    return noStore(jsonOk({ path: selectedPath }))
  } catch (error) {
    return noStore(
      error instanceof LocalPickerError ? apiError(error.status, error.code, error.message) : routeError(error),
    )
  }
}
