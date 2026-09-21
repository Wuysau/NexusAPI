import { execFile } from 'node:child_process'
import path from 'node:path'

type PickerEnvironment = { NODE_ENV?: string; NEXUS_DESKTOP_ORIGIN?: string }
export type ObserverPathKind = 'file' | 'directory'
export class LocalPickerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message)
  }
}
function desktopOrigin(env: PickerEnvironment): URL | null {
  try {
    const origin = new URL(env.NEXUS_DESKTOP_ORIGIN ?? '')
    return ['http:', 'https:'].includes(origin.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) &&
      origin.origin === env.NEXUS_DESKTOP_ORIGIN &&
      !origin.username &&
      !origin.password
      ? origin
      : null
  } catch {
    return null
  }
}
export function desktopPickerAvailable(env: PickerEnvironment = process.env, platform: string = process.platform) {
  return platform === 'win32' && env.NODE_ENV !== 'production' && desktopOrigin(env) !== null
}
export function desktopPickerHostAllowed(
  req: Request,
  env: PickerEnvironment = process.env,
  platform: string = process.platform,
) {
  return desktopPickerAvailable(env, platform) && req.headers.get('host') === desktopOrigin(env)?.host
}
export function desktopPickerRequestAllowed(
  req: Request,
  env: PickerEnvironment = process.env,
  platform: string = process.platform,
) {
  return desktopPickerHostAllowed(req, env, platform) && req.headers.get('origin') === desktopOrigin(env)?.origin
}

// Retain one desktop dialog across Next development module reloads.
const desktopState = globalThis as typeof globalThis & { nexusObserverPickerBusy?: boolean }
export async function pickObserverPath(kind: ObserverPathKind, signal?: AbortSignal): Promise<string | null> {
  if (kind !== 'file' && kind !== 'directory') throw new LocalPickerError('invalid_kind', '选择类型无效', 400)
  if (desktopState.nexusObserverPickerBusy)
    throw new LocalPickerError('picker_busy', '已有一个系统选择器，请先完成或取消选择')
  desktopState.nexusObserverPickerBusy = true
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        path.win32.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoLogo',
          '-NoProfile',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.resolve('scripts/select-observer-path.ps1'),
          '-Kind',
          kind,
        ],
        { windowsHide: true, timeout: 120000, maxBuffer: 16384, encoding: 'utf8', signal },
        (error, stdout) =>
          error ? reject(new LocalPickerError('picker_closed', '系统选择器已关闭或超时，请重试')) : resolve(stdout),
      )
    })
    try {
      const result: unknown = JSON.parse(output.replace(/^\uFEFF/, ''))
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).join(',') !== 'path')
        throw new Error()
      const selected = (result as { path: unknown }).path
      if (selected === null) return null
      if (typeof selected !== 'string' || selected.length > 4096 || /[\x00-\x1f]/.test(selected)) throw new Error()
      const normalized = path.win32.normalize(selected)
      if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(normalized) || /^[a-z]:\\fakepath\\/i.test(normalized))
        throw new Error()
      if (kind === 'file' && path.win32.extname(normalized).toLowerCase() !== '.jsonl') throw new Error()
      return normalized
    } catch {
      throw new LocalPickerError('invalid_picker_result', '系统选择器未返回有效路径')
    }
  } finally {
    desktopState.nexusObserverPickerBusy = false
  }
}
