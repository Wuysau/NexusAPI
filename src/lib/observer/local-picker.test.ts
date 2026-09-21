import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { desktopPickerAvailable, desktopPickerRequestAllowed, pickObserverPath } from './local-picker'

const exec = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: exec }))
beforeEach(() => {
  exec.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
})
const env = { NODE_ENV: 'development', NEXUS_DESKTOP_ORIGIN: 'http://127.0.0.1:3340' }
const request = (origin = env.NEXUS_DESKTOP_ORIGIN, host = '127.0.0.1:3340') =>
  new Request('http://127.0.0.1:3340/api/local/observer-path', { method: 'POST', headers: { origin, host } })
it('only enables the explicitly configured Windows nonproduction loopback origin', () => {
  expect(desktopPickerAvailable(env, 'win32')).toBe(true)
  for (const origin of [
    '',
    'https://remote.example',
    'http://localhost.evil.test',
    'http://user@localhost',
    'http://127.0.0.1:3340/path',
  ])
    expect(desktopPickerAvailable({ ...env, NEXUS_DESKTOP_ORIGIN: origin }, 'win32')).toBe(false)
  expect(desktopPickerAvailable({ ...env, NODE_ENV: 'production' }, 'win32')).toBe(false)
  expect(desktopPickerAvailable(env, 'linux')).toBe(false)
})
it('rejects foreign or missing Origin and mismatched Host independently of forwarded headers', () => {
  expect(desktopPickerRequestAllowed(request(), env, 'win32')).toBe(true)
  expect(desktopPickerRequestAllowed(request('https://remote.example'), env, 'win32')).toBe(false)
  expect(desktopPickerRequestAllowed(request('', '127.0.0.1:3340'), env, 'win32')).toBe(false)
  expect(desktopPickerRequestAllowed(request(env.NEXUS_DESKTOP_ORIGIN, 'evil.test'), env, 'win32')).toBe(false)
})
function finish(stdout: string, error: Error | null = null) {
  exec.mockImplementation((_file, _args, _options, callback) => {
    queueMicrotask(() => callback(error, stdout, 'PRIVATE_DIAGNOSTIC'))
    return new EventEmitter()
  })
}
it('uses a fixed executable/script and allowlisted kind, returning only the selected absolute Unicode path', async () => {
  const selected = 'D:\\项目 空格\\rollout.jsonl'
  finish(JSON.stringify({ path: selected }))
  expect(await pickObserverPath('file')).toBe(selected)
  const [executable, args, options] = exec.mock.calls[0]
  expect(executable).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/)
  expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-STA', '-File', '-Kind', 'file']))
  expect(args.join(' ')).not.toContain(selected)
  expect(options).toMatchObject({ windowsHide: true, timeout: 120000, maxBuffer: 16384, encoding: 'utf8' })
})
it('allows a directory and preserves cancellation as null', async () => {
  finish(JSON.stringify({ path: 'C:\\Users\\fixture\\.codex\\sessions' }))
  expect(await pickObserverPath('directory')).toBe('C:\\Users\\fixture\\.codex\\sessions')
  finish('{"path":null}')
  expect(await pickObserverPath('directory')).toBeNull()
})
it('rejects arbitrary kinds before spawning and invalid/fake/truncated output without exposing it', async () => {
  await expect(pickObserverPath('file; do-stuff' as 'file')).rejects.toThrow('选择类型无效')
  expect(exec).not.toHaveBeenCalled()
  for (const output of [
    'PRIVATE_PATH',
    '{"path":"relative.jsonl"}',
    '{"path":"C:\\\\fakepath\\\\rollout.jsonl"}',
    '{"path":"C:\\\\auth.json"}',
    '{"path":"D:\\\\rollout.jsonl","extra":"PRIVATE"}',
  ]) {
    finish(output)
    await expect(pickObserverPath('file')).rejects.toThrow('系统选择器未返回有效路径')
  }
})
it('rejects concurrent dialogs and releases the lock after failure; passes cancellation to the child', async () => {
  let complete: (error: Error | null, out: string) => void = () => {}
  exec.mockImplementation((_file, _args, _options, callback) => {
    complete = callback
    return new EventEmitter()
  })
  const controller = new AbortController()
  const pending = pickObserverPath('directory', controller.signal)
  await expect(pickObserverPath('directory')).rejects.toThrow('已有一个系统选择器')
  expect(exec.mock.calls[0][2].signal).toBe(controller.signal)
  complete(new Error('PRIVATE PROCESS ERROR'), '')
  await expect(pending).rejects.toThrow('系统选择器已关闭或超时，请重试')
  finish('{"path":null}')
  expect(await pickObserverPath('directory')).toBeNull()
})
