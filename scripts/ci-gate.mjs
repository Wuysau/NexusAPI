import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { captureSource } from './ci-source.mjs'
export { captureSource } from './ci-source.mjs'

const scripts = {
  ci: 'ci:validate',
  format: 'format:check',
  lint: 'lint',
  typecheck: 'typecheck',
  unit: 'test:unit',
  contract: 'test:contract',
  migration: 'db:migration:verify',
  integration: 'test:integration',
  'security-tests': 'test:security',
  security: 'security:check',
  secrets: 'secrets:scan',
  build: 'build',
  services: 'services:build',
  compose: 'compose:verify',
  go: 'ci:go',
  images: 'ci:images',
  e2e: 'ci:e2e',
  plan: 'ci:plan',
  sbom: 'ci:sbom',
  'secret-plane': 'secrets:verify:fixture',
  negative: 'ci:negative',
}
export function testCounts(output) {
  const text = output.replace(/\u001b\[[0-9;]*m/g, '')
  const vitest = /Tests\s+([^\n]+)/.exec(text)
  if (vitest)
    return Object.fromEntries(
      ['passed', 'failed', 'skipped'].map((k) => [
        k,
        Number(new RegExp(`(\\d+) ${k}`).exec(vitest[1])?.[1] ?? 0) +
          (k === 'skipped' ? Number(/(\d+) todo/.exec(vitest[1])?.[1] ?? 0) : 0),
      ]),
    )
  const e2e = /(\d+)\/(\d+) (?:e2e flows|secret-plane checks) passed/.exec(text)
  if (e2e) return { passed: Number(e2e[1]), failed: Number(e2e[2]) - Number(e2e[1]), skipped: 0 }
  if (/^\s*--- (?:PASS|FAIL|SKIP):/m.test(text))
    return Object.fromEntries(
      [
        ['passed', 'PASS'],
        ['failed', 'FAIL'],
        ['skipped', 'SKIP'],
      ].map(([key, word]) => [key, [...text.matchAll(new RegExp(`^\\s*--- ${word}:`, 'gm'))].length]),
    )
  return null
}
export function redact(text, env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 8 && /TOKEN|SECRET|PASSWORD|DATABASE_URL|ENCRYPTION_KEY|SIGNING_KEY/.test(key))
      text = text.split(value).join('[redacted]')
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[redacted-database-url]')
}
export function runGate(gate) {
  if (gate !== 'install' && !scripts[gate]) throw new Error('Unknown CI gate')
  mkdirSync('.test-artifacts/ci', { recursive: true })
  const command = gate === 'install' ? 'npm ci' : `npm run ${scripts[gate]}`
  const started = new Date().toISOString(),
    before = Date.now()
  const source = captureSource()
  // The shell receives only the fixed allowlisted command above, never caller text.
  const child =
    process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        })
      : spawnSync('npm', gate === 'install' ? ['ci'] : ['run', scripts[gate]], {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        })
  const output = redact((child.stdout || '') + (child.stderr || '') + (child.error?.message || ''))
  const tests = testCounts(output)
  let exitCode = child.status ?? 1
  if (
    ['unit', 'contract', 'integration', 'migration', 'security-tests', 'e2e', 'go', 'secret-plane'].includes(gate) &&
    (!tests || tests.passed === 0 || tests.failed !== 0 || tests.skipped !== 0)
  )
    exitCode = 1
  const commit =
    process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || 'unknown'
  const sourceAfter = captureSource()
  const receipt = {
    gate,
    command,
    commit,
    build_id: `${commit}:${source.sha256}`,
    source,
    source_after: sourceAfter,
    source_changed_during_gate: source.sha256 !== sourceAfter.sha256,
    run_id: process.env.GITHUB_RUN_ID || 'local',
    attempt: process.env.GITHUB_RUN_ATTEMPT || '1',
    started_at: started,
    duration_ms: Date.now() - before,
    exit_code: exitCode,
    process_exit_code: child.status,
    status: exitCode === 0 ? 'passed' : 'failed',
    tests,
    environment: { platform: process.platform, node: process.version },
    log: `${gate}.log`,
  }
  if (existsSync(`.test-artifacts/ci/${gate}.json`)) {
    mkdirSync('.test-artifacts/ci/history', { recursive: true })
    const history = `.test-artifacts/ci/history/${gate}-${Date.now()}`
    copyFileSync(`.test-artifacts/ci/${gate}.json`, `${history}.json`)
    if (existsSync(`.test-artifacts/ci/${gate}.log`)) copyFileSync(`.test-artifacts/ci/${gate}.log`, `${history}.log`)
  }
  writeFileSync(`.test-artifacts/ci/${gate}.log`, output)
  writeFileSync(`.test-artifacts/ci/${gate}.json`, JSON.stringify(receipt, null, 2) + '\n')
  console.log(
    `${gate}: exit${exitCode}${tests ? ` passed=${tests.passed} failed=${tests.failed} skipped=${tests.skipped}` : ''}`,
  )
  if (exitCode) console.error(output.slice(-6000))
  return exitCode
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = runGate(process.argv[2])
