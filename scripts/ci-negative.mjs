import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
const directory = '.test-artifacts/ci-negative'
mkdirSync(directory, { recursive: true })
writeFileSync(`${directory}/Dockerfile`, 'THIS_IS_NOT_A_DOCKERFILE\n')
const docker = spawnSync('docker', ['build', '-f', `${directory}/Dockerfile`, directory], { encoding: 'utf8' })
assert.notEqual(docker.status, 0, 'Broken Dockerfile unexpectedly succeeded')
assert.match(docker.stderr || '', /unknown instruction|parse error/i, 'Docker must execute and reject actual syntax')
writeFileSync(`${directory}/bad.ts`, 'const badlyFormatted={a:1,b:2};\n')
writeFileSync(`${directory}/empty.ignore`, '')
const format = spawnSync(
  process.execPath,
  [
    'node_modules/prettier/bin/prettier.cjs',
    '--check',
    '--ignore-path',
    `${directory}/empty.ignore`,
    `${directory}/bad.ts`,
  ],
  { encoding: 'utf8' },
)
assert.equal(format.status, 1, 'Formatter must reject actual invalid formatting')
assert.match((format.stdout || '') + (format.stderr || ''), /Code style issues/)
mkdirSync('.test-artifacts/ci', { recursive: true })
writeFileSync(
  '.test-artifacts/ci/negative-cases.json',
  JSON.stringify(
    {
      docker: { exit_code: docker.status, reason: 'Actual Docker parser rejects invalid instruction' },
      format: { exit_code: format.status, reason: 'Actual formatter rejects changed source' },
      task_and_migration:
        'Contract/integration suites exercise invalid Task states and real migration rollback failures',
    },
    null,
    2,
  ) + '\n',
)
console.log('2/2 deliberate gate failures rejected')
