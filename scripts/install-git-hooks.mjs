import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const hookPath = path.join(root, '.githooks')
const current = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
  cwd: root,
  encoding: 'utf8',
}).stdout.trim()

if (current && path.resolve(root, current) !== hookPath) {
  throw new Error(`Existing core.hooksPath is ${current}; leaving it unchanged`)
}

execFileSync('git', ['config', '--local', 'core.hooksPath', hookPath], { cwd: root })
process.stdout.write(`Nexus post-commit hook installed from ${hookPath}\n`)
