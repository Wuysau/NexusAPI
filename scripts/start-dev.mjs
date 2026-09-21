import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { startLocalServices } from './local-services.mjs'

const npmCommand = platform() === 'win32' ? 'npm.cmd' : 'npm'

// Load the same local configuration Next.js reads, so a developer configures
// .env.local once and never injects variables manually. Existing process
// environment always wins: deployment keeps explicit injection.
function loadLocalEnv() {
  if (!existsSync('.env.local')) return
  process.loadEnvFile('.env.local')
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`))
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}`))
      else resolve()
    })
  })
}

async function runNpm(args) {
  return run(
    platform() === 'win32' ? 'cmd.exe' : npmCommand,
    platform() === 'win32' ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] : args,
  )
}

async function main() {
  loadLocalEnv()
  await run('docker', ['compose', 'up', '-d', 'postgres', 'redis'])
  await runNpm(['run', 'db:migrate'])

  const port = process.env.PORT || '3000'
  startLocalServices(['dev', '--hostname', '127.0.0.1', '--port', port], {
    ...process.env,
    ...(platform() === 'win32' ? { NEXUS_DESKTOP_ORIGIN: 'http://127.0.0.1:' + port } : {}),
  })
}

main().catch((error) => {
  console.error(`[dev] ${error.message}`)
  process.exitCode = 1
})
