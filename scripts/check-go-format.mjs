import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Optional directory is used by the gate's isolated regression fixture.
const cwd = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../services/gateway/', import.meta.url))
const result = spawnSync('gofmt', ['-l', '.'], { cwd, encoding: 'utf8' })
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) process.stderr.write(`${result.error.message}\n`)
process.exitCode = result.error || result.status !== 0 || result.stdout.trim() ? 1 : 0
