import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Windows CI/development uses real Linux race detection, not a CGO-disabled substitute.
const directory = resolve('services/gateway')
const docker = process.platform === 'win32' || process.env.GATEWAY_CHECK_DOCKER === '1'
const fixture = process.env.GATEWAY_BUDGET_INTEGRATION_DATABASE_URL
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
const checks = docker
  ? [
      [
        'docker',
        [
          'run',
          '--rm',
          ...(fixture
            ? ['--network', 'host', '-e', 'GATEWAY_BUDGET_INTEGRATION_DATABASE_URL', '-e', 'GATEWAY_BUDGET_FIXTURE_URL']
            : []),
          '-e',
          'GOPROXY=https://goproxy.cn,direct',
          '-v',
          mount,
          '-w',
          working,
          '-e',
          'GOPROXY=https://goproxy.cn,direct',
          'golang@sha256:f44f6e88636cfb311f9ebace870ded69d943f227bb3cb27d32ffd84ea18c43ea',
          'go',
          'test',
          '-race',
          ...(fixture ? ['-count=1', '-v'] : []),
          './...',
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
      ['go', ['test', '-race', './...']],
      ['golangci-lint', ['run', '--max-issues-per-linter=0', '--max-same-issues=0']],
    ]
for (const [command, args] of checks) {
  const result = spawnSync(command, args, { cwd: directory, stdio: 'inherit', env: goEnv })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}
