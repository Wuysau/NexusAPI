import { spawnSync } from 'node:child_process'
import { copyFile, cp } from 'node:fs/promises'
import { build } from 'esbuild'
import { checkControlArtifact } from './check-control-artifact.mjs'
import { materializeControlRuntime } from './materialize-control-runtime.mjs'

// Build workers import database modules, but never need a live database or its
// credentials. This value is child-process-only, not a runtime image ENV.
const result = spawnSync(process.execPath, ['node_modules/next/dist/bin/next', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: 'postgresql://build:build@127.0.0.1:1/build_only' },
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
await build({
  entryPoints: ['src/lib/config.ts'],
  outfile: '.next/standalone/control-config.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
})
await copyFile('scripts/start-control.cjs', '.next/standalone/start-control.cjs')
await cp('.next/static', '.next/standalone/.next/static', { recursive: true })
await materializeControlRuntime()
await checkControlArtifact('.next/standalone')
