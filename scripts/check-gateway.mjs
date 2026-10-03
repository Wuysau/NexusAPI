import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { healthRecoveryDatabaseURL } from './fixture-database.mjs'

// Windows CI/development uses real Linux race detection, not a CGO-disabled substitute.
const directory = resolve('services/gateway')
const docker = process.platform === 'win32' || process.env.GATEWAY_CHECK_DOCKER === '1'
const fixture = process.env.GATEWAY_BUDGET_INTEGRATION_DATABASE_URL
const healthFixture = process.env.GATEWAY_HEALTH_RECOVERY_DATABASE_URL
if (healthFixture) healthRecoveryDatabaseURL(healthFixture)
const goEnv = {
  ...process.env,
  GOPROXY: 'https://goproxy.cn,direct',
  ...(fixture && process.platform === 'win32'
    ? { GATEWAY_BUDGET_FIXTURE_URL: 'http://host.docker.internal:3311' }
    : {}),
}
const mount = `${resolve('.')}:/repo`
const working = '/repo/services/gateway'
const formatted = spawnSync(process.execPath, [resolve('scripts/check-go-format.mjs')], { stdio: 'inherit' })
if (formatted.status !== 0) process.exit(formatted.status ?? 1)
const vetted = spawnSync('go', ['vet', './...'], { cwd: directory, stdio: 'inherit', env: goEnv })
if (vetted.status !== 0) process.exit(vetted.status ?? 1)
const raceArgs = ['test', '-race', ...(fixture ? ['-tags', 'redisintegration', '-count=1', '-v'] : []), './...']
let healthDirectory
if (healthFixture && !docker) {
  healthDirectory = mkdtempSync(resolve(tmpdir(), 'nexus-health-race-'))
  goEnv.GATEWAY_HEALTH_RECOVERY_BINARY = resolve(healthDirectory, 'gateway')
  const built = spawnSync('go', ['build', '-o', goEnv.GATEWAY_HEALTH_RECOVERY_BINARY, '.'], {
    cwd: directory,
    stdio: 'inherit',
    env: goEnv,
  })
  if (built.status !== 0) {
    if (existsSync(goEnv.GATEWAY_HEALTH_RECOVERY_BINARY)) unlinkSync(goEnv.GATEWAY_HEALTH_RECOVERY_BINARY)
    rmdirSync(healthDirectory)
    process.exit(built.status ?? 1)
  }
}
const checks = docker
  ? [
      [
        'docker',
        [
          'run',
          '--rm',
          ...(fixture || healthFixture
            ? [
                '--network',
                'host',
                ...(fixture
                  ? ['-e', 'GATEWAY_BUDGET_INTEGRATION_DATABASE_URL', '-e', 'GATEWAY_BUDGET_FIXTURE_URL']
                  : []),
                ...(healthFixture
                  ? [
                      '-e',
                      'GATEWAY_HEALTH_RECOVERY_DATABASE_URL',
                      '-e',
                      'GATEWAY_HEALTH_RECOVERY_BINARY=/tmp/nexus-health-recovery-gateway',
                    ]
                  : []),
              ]
            : []),
          // Hosted checkouts belong to the runner UID; retain VCS stamping in
          // the root-owned container by trusting only this explicit mount.
          '-e',
          'GIT_CONFIG_COUNT=1',
          '-e',
          'GIT_CONFIG_KEY_0=safe.directory',
          '-e',
          'GIT_CONFIG_VALUE_0=/repo',
          '-e',
          'GOPROXY=https://goproxy.cn,direct',
          '-v',
          mount,
          '-w',
          working,
          '-e',
          'GOPROXY=https://goproxy.cn,direct',
          'golang@sha256:f44f6e88636cfb311f9ebace870ded69d943f227bb3cb27d32ffd84ea18c43ea',
          ...(healthFixture
            ? ['sh', '-c', 'go build -o "$GATEWAY_HEALTH_RECOVERY_BINARY" . && go ' + raceArgs.join(' ')]
            : ['go', ...raceArgs]),
        ],
      ],
      [
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${directory}:/work`,
          '-e',
          'GOPROXY=https://goproxy.cn,direct',
          '-w',
          '/work',
          'golangci/golangci-lint@sha256:ba07dffad130794ae79ebaa0056809d18c0168f3f846480ffd3eb6c04578b83d',
          'golangci-lint',
          'run',
          '--max-issues-per-linter=0',
          '--max-same-issues=0',
        ],
      ],
    ]
  : [
      ['go', raceArgs],
      ['golangci-lint', ['run', '--max-issues-per-linter=0', '--max-same-issues=0']],
    ]
try {
  for (const [command, args] of checks) {
    const result = spawnSync(command, args, { cwd: directory, stdio: 'inherit', env: goEnv })
    if (result.error) console.error(result.error.message)
    if (result.error || result.status !== 0) {
      process.exitCode = result.error ? 1 : (result.status ?? 1)
      break
    }
  }
} finally {
  if (healthDirectory) {
    unlinkSync(goEnv.GATEWAY_HEALTH_RECOVERY_BINARY)
    rmdirSync(healthDirectory)
  }
}
