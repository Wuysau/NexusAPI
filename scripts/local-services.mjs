import { spawn } from 'node:child_process'

/** Parent owns both children; Windows worker shutdown uses IPC instead of Unix-only signals. */
export function startLocalServices(nextArgs, env = process.env) {
  let closing = false
  let observer
  let restart
  const startObserver = () => {
    if (closing) return
    observer = spawn(process.execPath, ['--import', 'tsx', 'services/observer/index.ts'], {
      env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    })
    observer.on('error', () => console.error('[observer] process_unavailable'))
    observer.on('exit', () => {
      if (!closing) restart = setTimeout(startObserver, 5000)
    })
  }
  const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', ...nextArgs], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  })
  startObserver()
  const stop = () => {
    if (closing) return
    closing = true
    clearTimeout(restart)
    if (observer?.connected) observer.send('stop', () => {})
    else if (observer && observer.exitCode === null) observer.kill()
    const deadline = setTimeout(() => {
      if (observer?.exitCode === null) observer.kill()
    }, 10000)
    deadline.unref()
    if (app.exitCode === null) app.kill()
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop)
  app.on('error', () => {
    console.error('[dev] web_start_failed')
    process.exitCode = 1
    stop()
  })
  app.on('exit', (code) => {
    process.exitCode = code ?? 0
    stop()
  })
  return { app, stop }
}
