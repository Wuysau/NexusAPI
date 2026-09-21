import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
const images = []
for (const [name, file] of [
  ['control', 'infra/Dockerfile'],
  ['gateway', 'services/gateway/Dockerfile'],
  ['worker', 'services/worker/Dockerfile'],
  ['budget', 'services/budget/Dockerfile'],
]) {
  const tag = `nexus-ci-${name}:verification`
  const built = spawnSync('docker', ['build', '-f', file, '-t', tag, '.'], { stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
  const result = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout.startsWith('sha256:')) throw new Error('Image digest unavailable')
  images.push({ name, dockerfile: file, image: tag, digest: result.stdout.trim() })
}
mkdirSync('.test-artifacts/ci', { recursive: true })
writeFileSync(
  '.test-artifacts/ci/image-digests.json',
  JSON.stringify({ commit: process.env.GITHUB_SHA || 'local-working-tree', images }, null, 2) + '\n',
)
console.log('Four deployable image builds passed; digests recorded')
