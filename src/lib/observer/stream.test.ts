import { mkdtemp, writeFile, appendFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readJsonl } from './stream'
import { decideOwnedAccess } from '../domain-access-control'
import { spawnSync } from 'node:child_process'

it('runs the actual Node24 CLI entrypoint without module format errors', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/observer-codex.ts', '--help'], {
    encoding: 'utf8',
  })
  expect(run.status).toBe(0)
  expect(run.stdout).toContain('codex-rollout-v1')
})

it('retries partial UTF-8 tails and ignores corrupt/oversized lines without retaining content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'observer-stream-')),
    file = path.join(dir, 'rollout.jsonl')
  try {
    const first = '{"type":"未知"}\n',
      tail = '{"type":"next"}'
    await writeFile(file, first + tail.slice(0, -2))
    const seen: unknown[] = []
    const one = await readJsonl(file, 0, (await stat(file)).size, async (e) => {
      seen.push(e)
    })
    expect(one.offset).toBe(Buffer.byteLength(first))
    expect(one.warnings).toBe(1)
    await appendFile(file, tail.slice(-2) + '\n{corrupt}\n' + 'x'.repeat(8 * 1024 * 1024 + 1) + '\n{"type":"end"}\n')
    const two = await readJsonl(file, one.offset, (await stat(file)).size, async (e) => {
      seen.push(e)
    })
    expect(two.offset).toBe((await stat(file)).size)
    expect(two.warnings).toBe(2)
    expect(seen).toEqual([{ type: '未知' }, { type: 'next' }, { type: 'end' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('rejects subscription routing even if caller advertises allowed operations', () => {
  expect(
    decideOwnedAccess(
      {
        tenantId: 't',
        projectTenantId: 't',
        ownerId: 'u',
        actorId: 'u',
        projectId: 'p',
        connectionId: 'c',
        operation: 'chat',
      },
      {
        mode: 'subscription_interactive',
        proxyStatus: 'customer-controlled-only',
        provider: 'openai',
        operations: ['chat'],
      },
    ),
  ).toEqual({ allowed: false, reason: 'server_proxy_not_allowed' })
})
