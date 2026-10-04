import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export type AccountMethod = 'account/read' | 'account/rateLimits/read' | 'account/usage/read'
export class CodexClientError extends Error {
  constructor(public readonly code: 'app_server_unavailable' | 'unsupported' | 'sync_error') {
    super(code) // Never propagate server error text, stderr or payloads to logs.
  }
}

function executable() {
  const configured = process.env.NEXUS_CODEX_EXECUTABLE
  if (configured) {
    if (!path.isAbsolute(configured) || !existsSync(configured)) throw new CodexClientError('app_server_unavailable')
    return configured
  }
  if (process.platform !== 'win32') return 'codex'
  // npm's Windows shim cannot be spawned without a shell; locate its bundled binary instead.
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const root = path.join(dir, 'node_modules', '@openai', 'codex')
    for (const candidate of [
      path.join(dir, 'codex.exe'),
      path.join(root, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'),
      path.join(root, 'vendor', triple, 'bin', 'codex.exe'),
    ]) {
      if (existsSync(/* turbopackIgnore: true */ candidate)) return candidate
    }
  }
  throw new CodexClientError('app_server_unavailable')
}

class AccountRpc {
  private child: ChildProcessWithoutNullStreams
  private buffer = ''
  private serial = 0
  private closed = false
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  constructor(binary: string, proxy: boolean) {
    this.child = spawn(binary, proxy ? ['app-server', 'proxy'] : ['app-server', '--stdio'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
    this.child.stderr.resume() // Drain, never log or retain provider diagnostics.
    this.child.on('error', () => this.close())
    this.child.on('exit', () => this.close())
    this.child.stdin.on('error', () => this.close())
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      if (this.buffer.length > 4 * 1024 * 1024) return this.close()
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (!line.trim()) continue
        try {
          // Node 24 source context preserves integers beyond Number.MAX_SAFE_INTEGER.
          const message = JSON.parse(line, (_key, value, context?: { source: string }) =>
            typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
              ? (context?.source ?? null)
              : value,
          )
          if (message.method && message.id !== undefined) {
            // Never handle server requests for credentials, OAuth, tools or attestation.
            this.child.stdin.write(
              JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only account client' } }) + '\n',
            )
            continue
          }
          const pending = this.pending.get(message.id)
          if (!pending || message.method) continue
          clearTimeout(pending.timer)
          this.pending.delete(message.id)
          if (message.error)
            pending.reject(new CodexClientError(message.error.code === -32601 ? 'unsupported' : 'sync_error'))
          else if (Object.hasOwn(message, 'result')) pending.resolve(message.result)
          else pending.reject(new CodexClientError('sync_error'))
        } catch {
          this.close()
        }
      }
    })
  }
  private request(method: string, params: unknown, timeout: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexClientError('app_server_unavailable'))
    return new Promise((resolve, reject) => {
      const id = ++this.serial
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CodexClientError('sync_error'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  async initialize(timeout: number) {
    await this.request(
      'initialize',
      {
        clientInfo: { name: 'nexus_account_observer', title: 'NexusAPI Account Observer', version: '1.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      timeout,
    )
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
  }
  read(method: AccountMethod) {
    return this.request(method, method === 'account/read' ? { refreshToken: false } : {}, 20000)
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new CodexClientError('app_server_unavailable'))
    }
    this.pending.clear()
    this.buffer = ''
    this.child.stdin.destroy()
    this.child.kill()
  }
}

export async function connectCodexAccount() {
  const binary = executable()
  for (const proxy of [true, false]) {
    const rpc = new AccountRpc(binary, proxy)
    try {
      await rpc.initialize(proxy ? 2500 : 10000)
      return rpc
    } catch {
      rpc.close()
    }
  }
  throw new CodexClientError('app_server_unavailable')
}
