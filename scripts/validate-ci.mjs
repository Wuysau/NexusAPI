import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

export const requiredCIGates = [
  'install',
  'plan',
  'ci',
  'format',
  'lint',
  'typecheck',
  'unit',
  'contract',
  'migration',
  'integration',
  'security-tests',
  'security',
  'secrets',
  'build',
  'services',
  'compose',
  'go',
  'images',
  'e2e',
  'sbom',
  'secret-plane',
  'negative',
]

export function validateWorkflow(source) {
  let data
  try {
    data = yaml.load(source, { schema: yaml.CORE_SCHEMA })
  } catch (error) {
    return [`Invalid/duplicate YAML mapping: ${error.reason}`]
  }
  const errors = [],
    job = data?.jobs?.verification
  if (!job || !Array.isArray(job.steps)) return ['Missing verification job and executable steps']
  if (Object.hasOwn(job, 'if')) errors.push('Required verification job cannot be conditional')
  const seen = []
  for (const step of job.steps) {
    if (step['continue-on-error']) errors.push('continue-on-error cannot waive a required gate')
    if (step.run) {
      if (step.run.includes('ci-gate.mjs') && !/^node scripts\/ci-gate\.mjs [a-z0-9-]+$/.test(step.run.trim()))
        errors.push('Required gate must use an exact fixed command')
      if (/\|\|\s*true|passWithNoTests/.test(step.run)) errors.push('Required gate failure may not be suppressed')
      for (const match of step.run.matchAll(/node scripts\/ci-gate\.mjs ([a-z0-9-]+)/g)) {
        seen.push(match[1])
        if (Object.hasOwn(step, 'if')) errors.push(`Required ${match[1]} gate cannot be conditional`)
      }
    }
  }
  for (const gate of requiredCIGates) if (!seen.includes(gate)) errors.push(`Missing required gate: ${gate}`)
  if (seen.indexOf('migration') >= seen.indexOf('integration'))
    errors.push('Real migration must run before integration')
  if (seen.indexOf('migration') >= seen.indexOf('e2e')) errors.push('Real migration must run before e2e')
  if (job['continue-on-error']) errors.push('Job continue-on-error cannot waive required gates')
  for (const service of ['postgres', 'redis'])
    if (!job.services?.[service]?.options?.includes('--health-cmd')) errors.push(`Missing healthy ${service} fixture`)
  if (
    !job.steps.some(
      (s) =>
        s.uses?.startsWith('actions/upload-artifact@') &&
        s.if === 'always()' &&
        s.with?.['if-no-files-found'] === 'error' &&
        s.with?.['include-hidden-files'] === true &&
        s.with?.path === '.test-artifacts/ci/',
    )
  )
    errors.push('Missing always-uploaded required evidence')
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = validateWorkflow(readFileSync('.github/workflows/ci.yml', 'utf8'))
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else console.log('PASS: unique YAML mappings, mandatory executable CI gates and evidence upload')
}
