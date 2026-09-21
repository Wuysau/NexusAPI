import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
const base = process.env.CI_BASE_SHA
const validBase = base && /^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base)
const args = validBase
  ? ['diff', '--name-only', base, 'HEAD', '--']
  : ['ls-files', '--cached', '--others', '--exclude-standard']
const diff = spawnSync('git', args, { encoding: 'utf8' })
if (diff.status !== 0) throw new Error('Cannot inspect CI change scope')
const paths = [...new Set(diff.stdout.trim().split('\n').filter(Boolean))]
const conditions = {
  database_changed: paths.some((p) => p.startsWith('drizzle/') || p === 'src/db/schema.ts'),
  public_behavior_changed: paths.some((p) => p.startsWith('src/app/') || p.startsWith('src/components/')),
  gateway_changed: paths.some((p) => p.startsWith('services/gateway/') || p.startsWith('packages/contracts/')),
}
const plan = {
  changed_paths: paths,
  detected_conditions: conditions,
  executed_conditions: { database_changed: true, public_behavior_changed: true, gateway_changed: true },
  policy: 'Run every gate conservatively; scope detection never skips validation.',
}
mkdirSync('.test-artifacts/ci', { recursive: true })
writeFileSync('.test-artifacts/ci/change-plan.json', JSON.stringify(plan, null, 2) + '\n')
console.log('Source scope inspected; all conditional gates required')
