import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexAdapter, normalizeRuntimeFailure } from './codex-adapter'

const roots: string[] = []
const adapters: CodexAdapter[] = []
const profiles = new WeakMap<CodexAdapter, { profileRef: string; home: string }>()
const targetProfiles = new WeakMap<CodexAdapter, { profileRef: string; home: string }>()
afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await expect.poll(() => adapter.inspect().state).not.toBe('running')
    await adapter.stop()
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(mode = 'complete', requestTimeoutMs = 2000) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-adapter-'))
  roots.push(root)
  const home = path.join(root, 'profile')
  const targetHome = path.join(root, 'target-profile')
  const cwd = path.join(root, 'workspace')
  await mkdir(home)
  await mkdir(targetHome)
  await mkdir(cwd)
  const script = `
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    const mode = ${JSON.stringify(mode)};
    let thread = false;
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') return send({id:m.id,result:{}});
      if (m.method === 'thread/start') {
        if (process.env.CODEX_HOME !== ${JSON.stringify(home)} || process.cwd() !== ${JSON.stringify(cwd)} ||
          process.env.NEXUS_TEST_SECRET || m.params.sandbox !== 'workspace-write' || m.params.approvalPolicy !== 'on-request' || m.params.approvalsReviewer !== 'user') process.exit(9);
        thread = true;
        return send({id:m.id,result:{thread:{id:'fixture-session'}}});
      }
      if (m.method === 'account/rateLimits/read') return send({id:m.id,result:{rateLimits:{primary:{usedPercent:7}},...(mode === 'observation' ? {accessToken:'SECRET_QUOTA_TOKEN'} : {})}});
      if (m.method === 'account/read') {
        if (m.params.refreshToken !== false) process.exit(13);
        return send({id:m.id,result:{account:mode === 'noaccount' ? null : {type:'chatgpt',email:'fixture@example.invalid',...(mode === 'observation' ? {accessToken:'SECRET_ACCOUNT_TOKEN',auth:{password:'SECRET_PASSWORD'}} : {})}}});
      }
      if (m.method === 'thread/read') {
        if (m.params.includeTurns !== false) process.exit(14);
        if (mode === 'cross-profile' && process.env.CODEX_HOME !== ${JSON.stringify(targetHome)}) process.exit(19);
        if (mode === 'probe-missing') return send({id:m.id,error:{code:-32600,data:{thread_error_code:'thread_not_found'},message:'not found'}});
        if (mode === 'probe-error') return send({id:m.id,error:{code:-32600,message:'configuration unavailable'}});
        return send({id:m.id,result:{thread:{id:mode === 'probe-mismatch' ? 'other-session' : 'fixture-session',cwd:${JSON.stringify(cwd)},turns:[]}}});
      }
      if (m.method === 'thread/resume') {
        if (m.params.excludeTurns !== true) process.exit(18);
        if (!m.params.cwd) {
          if (mode === 'cross-profile' && process.env.CODEX_HOME !== ${JSON.stringify(targetHome)}) process.exit(19);
          if (mode === 'probe-missing') return send({id:m.id,error:{code:-32600,data:{thread_error_code:'thread_not_found'},message:'not found'}});
          if (mode === 'probe-missing-rollout') return send({id:m.id,error:{code:-32600,message:'no rollout found for thread id fixture-session'}});
          if (mode === 'probe-error') return send({id:m.id,error:{code:-32600,message:'configuration unavailable'}});
          return send({id:m.id,result:{thread:{id:mode === 'probe-mismatch' ? 'other-session' : 'fixture-session',turns:[]}}});
        }
        if (m.params.cwd !== ${JSON.stringify(cwd)} || m.params.approvalPolicy !== 'on-request' || m.params.approvalsReviewer !== 'user' || m.params.sandbox !== 'workspace-write') process.exit(18);
        thread = true;
        return send({id:m.id,result:{thread:{id:mode === 'resume-mismatch' ? 'other-session' : 'fixture-session',turns:[]}}});
      }
      if (m.method === 'thread/turns/list') {
        if (m.params.threadId !== 'fixture-session' || m.params.limit !== 3 || m.params.itemsView !== 'notLoaded' || m.params.sortDirection !== 'desc' || m.params.cursor) process.exit(15);
        return send({id:m.id,result:{data:[{id:'recent-3'},{id:'recent-2'},{id:'recent-1'},{id:'forbidden-old-turn'}],nextCursor:'DO_NOT_FOLLOW'}});
      }
      if (m.method === 'thread/items/list') {
        if (m.params.threadId !== 'fixture-session' || m.params.sortDirection !== 'desc' || m.params.cursor || m.params.limit > 20) process.exit(16);
        const items = {
          'recent-3': [
            {type:'userMessage',id:'user',content:[{type:'text',text:'PRIVATE_USER_TEXT SECRET_API_KEY=secret'}]},
            {type:'agentMessage',id:'agent',text:'PRIVATE_ASSISTANT_TEXT Bearer secret .env.local'},
            {type:'commandExecution',id:'test-ok',status:'completed',exitCode:0,command:'npm.cmd run test:unit',aggregatedOutput:'SECRET_STDOUT'},
            {type:'commandExecution',id:'build-failed',status:'failed',exitCode:1,command:'npm run build',aggregatedOutput:'SECRET_BUILD_STDOUT'},
            {type:'commandExecution',id:'migration-pending',status:'inProgress',exitCode:null,command:'npm run db:migrate'},
            {type:'fileChange',id:'patch-ok',status:'completed',changes:[{path:'.env.local',diff:'SECRET_DIFF'}]},
          ],
          'recent-2': Array.from({length:12},(_,i)=>({type:'commandExecution',id:'sk-SECRET_ITEM_ID-'+i,status:'completed',exitCode:0,command:'curl -H "Authorization: Bearer SECRET_TOKEN" https://PRIVATE_URL',aggregatedOutput:'SECRET_OUTPUT'})),
          'recent-1': [
            {type:'commandExecution',id:'lint-ok',status:'completed',exitCode:0,command:'npm run lint'},
            {type:'commandExecution',id:'typecheck-ok',status:'completed',exitCode:0,command:'npm run typecheck'},
            {type:'commandExecution',id:'forbidden-old-item',status:'completed',exitCode:0,command:'npm run db:migrate'},
          ],
        }[m.params.turnId];
        if (!items) process.exit(17);
        return send({id:m.id,result:{data:items.map(item=>({turnId:m.params.turnId,item})),nextCursor:'DO_NOT_FOLLOW'}});
      }
      if (m.method === 'turn/start') {
        if (!thread || m.params.threadId !== 'fixture-session' || m.params.input[0].text !== 'goal' || m.params.sandboxPolicy.type !== 'workspaceWrite') process.exit(10);
        if (mode === 'reject') return send({id:m.id,error:{code:-32000,data:{codexErrorInfo:'rateLimitExceeded'},message:'SECRET'}});
        if (mode === 'timeout') return setTimeout(()=>send({method:'turn/completed',params:{threadId:'fixture-session',turn:{id:'turn-1',status:'completed'}}}),400);
        send({id:m.id,result:{turn:{id:'turn-1',status:'inProgress'}}});
        if (mode === 'exit') return setTimeout(()=>process.exit(4),40);
        if (mode === 'corrupt') {
          process.stdout.write('unparseable SECRET protocol payload\\n');
          return setTimeout(()=>process.exit(4),300);
        }
        if (mode === 'approval') return send({id:800,method:'item/commandExecution/requestApproval',params:{threadId:'fixture-session',command:'secret command'}});
        send({method:'item/completed',params:{threadId:'fixture-session',item:{type:'commandExecution',exitCode:1,aggregatedOutput:'quota exceeded in test assertion; SECRET'}}});
        setTimeout(()=>send({method:'turn/completed',params:{threadId:'fixture-session',turn:{id:'turn-1',status:mode === 'quota' ? 'failed':'completed',error:mode === 'quota' ? {codexErrorInfo:'usageLimitExceeded',message:'SECRET'}:null}}}),60);
      }
      if (m.id === 800) {
        if (m.result?.decision !== 'cancel') process.exit(11);
        send({method:'turn/completed',params:{threadId:'fixture-session',turn:{id:'turn-1',status:'interrupted'}}});
      }
    });`
  const adapter = new CodexAdapter({ executable: process.execPath, args: ['-e', script], requestTimeoutMs })
  adapters.push(adapter)
  profiles.set(adapter, { profileRef: 'profile-a', home })
  targetProfiles.set(adapter, { profileRef: 'profile-b', home: targetHome })
  await adapter.launch({ profileRef: 'profile-a', home }, cwd, null)
  return adapter
}

describe('Codex adapter', () => {
  it('resumes a persisted thread with the exact same id before accepting new turns', async () => {
    const adapter = await fixture()
    expect(await adapter.resumeSession('fixture-session')).toBe('fixture-session')
    expect(adapter.inspect()).toMatchObject({ state: 'idle', sessionId: 'fixture-session' })
    await adapter.submit('fixture-session', 'goal')
    await expect.poll(() => adapter.inspect().state).toBe('idle')
  })
  it('rejects a resume response that changes the conversation id', async () => {
    const adapter = await fixture('resume-mismatch')
    await expect(adapter.resumeSession('fixture-session')).rejects.toThrow('conversation_id_mismatch')
    expect(adapter.inspect().sessionId).toBeNull()
  })
  it('probes a target profile using metadata only and preserves the active session state', async () => {
    const adapter = await fixture()
    await adapter.startSession()
    expect(await adapter.canResumeConversation('fixture-session', profiles.get(adapter)!)).toBe(true)
    expect(adapter.inspect()).toMatchObject({ state: 'idle', sessionId: 'fixture-session' })
  })
  it('treats an ambiguous target read error as unknown rather than incompatible', async () => {
    const adapter = await fixture('probe-error')
    await expect(adapter.canResumeConversation('fixture-session', profiles.get(adapter)!)).rejects.toThrow(
      'runtime_request_failed',
    )
  })
  it('finds a thread in a separate local profile without changing the source runtime', async () => {
    const adapter = await fixture('cross-profile')
    await adapter.startSession()
    expect(await adapter.canResumeConversation('fixture-session', targetProfiles.get(adapter)!)).toBe(true)
    expect(adapter.inspect()).toMatchObject({ state: 'idle', sessionId: 'fixture-session' })
  })
  it('returns false for an explicit structured missing-thread result', async () => {
    const adapter = await fixture('probe-missing')
    expect(await adapter.canResumeConversation('fixture-session', targetProfiles.get(adapter)!)).toBe(false)
  })
  it('recognizes the installed app-server missing-rollout response for the exact thread', async () => {
    const adapter = await fixture('probe-missing-rollout')
    expect(await adapter.canResumeConversation('fixture-session', targetProfiles.get(adapter)!)).toBe(false)
  })
  it('can probe after the source process has stopped', async () => {
    const adapter = await fixture()
    await adapter.startSession()
    await adapter.stop()
    expect(await adapter.canResumeConversation('fixture-session', profiles.get(adapter)!)).toBe(true)
    expect(adapter.inspect().state).toBe('stopped')
  })
  it('reports unsupported in-place switching and migration explicitly', async () => {
    const adapter = await fixture()
    const target = profiles.get(adapter)!
    expect(await adapter.canSwitchResourceInPlace('fixture-session', target)).toBe(false)
    expect(await adapter.canMigrateConversation('fixture-session', target)).toBe(false)
    await expect(adapter.switchResourceInPlace('fixture-session', target)).rejects.toThrow(
      'in_place_switch_unsupported',
    )
  })
  it('normalizes resource observations without returning provider credentials or raw payloads', async () => {
    const adapter = await fixture('observation')
    const observation = await adapter.readResourceObservation()
    expect(observation).toEqual({
      source: 'codex_app_server',
      identity: '5e73ce6213fc49f6cd51b41974a53bc776a38bc6796f167e0b55e783868668db',
      account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: null },
      quotas: [
        {
          windowType: 'codex:default:primary',
          used: '7',
          remaining: '93',
          resetAt: null,
          metadata: {
            unit: 'percent',
            limitId: 'default',
            limitName: null,
            planType: null,
            credits: null,
            window: 'primary',
            windowDurationMins: null,
          },
        },
      ],
    })
    expect(JSON.stringify(observation)).not.toMatch(/SECRET|accessToken|password|rateLimits/)
  })
  it('reports missing profile authentication without creating a resource observation', async () => {
    const adapter = await fixture('noaccount')
    await expect(adapter.readResourceObservation()).rejects.toMatchObject({
      code: 'authentication_failure',
      reason: 'authentication_failure',
    })
  })
  it('launches an isolated profile, uses sandboxed protocol, and prohibits stopping a running turn', async () => {
    process.env.NEXUS_TEST_SECRET = 'must-not-inherit'
    try {
      const adapter = await fixture()
      expect(await adapter.startSession()).toBe('fixture-session')
      await adapter.submit('fixture-session', 'goal')
      await expect(adapter.stop()).rejects.toThrow('runtime_busy')
      await expect.poll(() => adapter.inspect().state).toBe('idle')
      const events = adapter.drainEvents()
      expect(events).toContainEqual({ type: 'turn_completed', sessionId: 'fixture-session' })
      expect(events.some((event) => event.type === 'session_failed')).toBe(false)
      expect(events.some((event) => event.type === 'progress')).toBe(false)
      expect(JSON.stringify(events)).not.toMatch(/SECRET|quota exceeded/)
      expect(await adapter.readQuota()).toEqual({ rateLimits: { primary: { usedPercent: 7 } } })
      expect(await adapter.readAccount()).toEqual({ account: { type: 'chatgpt', email: 'fixture@example.invalid' } })
    } finally {
      delete process.env.NEXUS_TEST_SECRET
    }
  })
  it('normalizes a structured quota failure and never stores diagnostics', async () => {
    const adapter = await fixture('quota')
    await adapter.startSession()
    await adapter.submit('fixture-session', 'goal')
    await expect.poll(() => adapter.inspect().state).toBe('failed')
    expect(adapter.drainEvents()).toContainEqual({
      type: 'session_failed',
      sessionId: 'fixture-session',
      reason: 'quota_exhausted',
    })
  })
  it('cancels approval requests and surfaces approval needs without granting execution', async () => {
    const adapter = await fixture('approval')
    await adapter.startSession()
    await adapter.submit('fixture-session', 'goal')
    await expect.poll(() => adapter.inspect().state).not.toBe('running')
    const events = adapter.drainEvents()
    expect(events).toContainEqual({ type: 'approval_required', sessionId: 'fixture-session' })
    expect(JSON.stringify(events)).not.toContain('secret command')
    expect(events.some((event) => event.type === 'turn_completed')).toBe(false)
  })
  it('keeps unknown process death out of resource failover reasons', async () => {
    const adapter = await fixture('exit')
    await adapter.startSession()
    await adapter.submit('fixture-session', 'goal')
    await expect.poll(() => adapter.inspect().state).toBe('failed')
    expect(adapter.drainEvents()).toContainEqual({
      type: 'session_failed',
      sessionId: 'fixture-session',
      reason: 'unknown',
    })
  })
  it('keeps a timed-out submit running until a confirmed safe boundary', async () => {
    const adapter = await fixture('timeout', 150)
    await adapter.startSession()
    await expect(adapter.submit('fixture-session', 'goal')).rejects.toThrow('runtime_timeout')
    expect(adapter.inspect().state).toBe('running')
    await expect(adapter.stop()).rejects.toThrow('runtime_busy')
    expect(adapter.drainEvents()).toEqual([])
    await expect.poll(() => adapter.inspect().state).toBe('idle')
  })
  it('retains process ownership after corrupt output until the runtime actually exits', async () => {
    const adapter = await fixture('corrupt')
    await adapter.startSession()
    expect(adapter.inspect().processId).toBeGreaterThan(0)
    await adapter.submit('fixture-session', 'goal')
    let events = adapter.drainEvents()
    await expect
      .poll(() => {
        events = [...events, ...adapter.drainEvents()]
        return events.some((event) => event.type === 'runtime_uncertain')
      })
      .toBe(true)
    expect(adapter.inspect().state).toBe('running')
    expect(adapter.inspect().processId).toBeGreaterThan(0)
    await expect(adapter.stop()).rejects.toThrow('runtime_busy')
    expect(events.some((event) => event.type === 'session_failed')).toBe(false)
    await expect.poll(() => adapter.inspect().state).toBe('failed')
    expect(adapter.inspect().processId).toBeUndefined()
    expect(adapter.drainEvents()).toContainEqual({
      type: 'session_failed',
      sessionId: 'fixture-session',
      reason: 'unknown',
    })
  })
  it('checkpoints bounded recent operation facts without prose, secrets, stdout, commands, or full history', async () => {
    const adapter = await fixture()
    await adapter.startSession()
    const context = await adapter.readContext()
    expect(context.completedWork).toHaveLength(16)
    expect(
      context.completedWork.some((line) => line.includes('category=test:unit') && line.includes('exitCode=0')),
    ).toBe(true)
    expect(context.completedWork.some((line) => line.includes('category=lint'))).toBe(true)
    expect(context.completedWork.some((line) => line.includes('category=typecheck'))).toBe(true)
    expect(context.completedWork.some((line) => line.includes('category=db:migrate'))).toBe(false)
    expect(context.knownFailures).toHaveLength(1)
    expect(context.knownFailures[0]).toMatch(/category=build.*exitCode=1/)
    expect(context.pendingWork).toHaveLength(1)
    expect(context.pendingWork[0]).toMatch(/category=db:migrate.*[Vv]erify.*[Dd]o not replay/)
    expect(context.decisions).toEqual([])
    expect(context.lastUserInstruction).toBeNull()
    expect(JSON.stringify(context)).not.toMatch(/SECRET|PRIVATE|Bearer|sk-|npm|curl|\.env|forbidden-old/)
    expect(JSON.stringify(context).length).toBeLessThan(6000)
  })
  it('normalizes a rejected turn RPC using structured error data', async () => {
    const adapter = await fixture('reject')
    await adapter.startSession()
    await expect(adapter.submit('fixture-session', 'goal')).rejects.toThrow('runtime_request_failed')
    expect(adapter.inspect().state).toBe('failed')
    expect(adapter.drainEvents()).toEqual([
      { type: 'session_failed', sessionId: 'fixture-session', reason: 'rate_limit' },
    ])
  })
  it('rejects global homes and a profile located inside the writable workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-profile-'))
    roots.push(root)
    const adapter = new CodexAdapter()
    const inherited = process.env.CODEX_HOME
    process.env.CODEX_HOME = root
    try {
      await expect(adapter.launch({ profileRef: 'global', home: root }, root, null)).rejects.toThrow(
        'shared_profile_forbidden',
      )
    } finally {
      if (inherited === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = inherited
    }
    await mkdir(path.join(root, 'profile'))
    await expect(
      adapter.launch({ profileRef: 'unsafe', home: path.join(root, 'profile') }, root, null),
    ).rejects.toThrow('profile_inside_workspace')
  })
})

it('trusts structured runtime errors and does not interpret test/build messages as resource failures', () => {
  expect(normalizeRuntimeFailure({ codexErrorInfo: 'usageLimitExceeded' })).toBe('quota_exhausted')
  expect(normalizeRuntimeFailure({ codexErrorInfo: 'rateLimitExceeded' })).toBe('rate_limit')
  expect(normalizeRuntimeFailure({ codexErrorInfo: 'unauthorized' })).toBe('authentication_failure')
  expect(normalizeRuntimeFailure({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } })).toBe(
    'provider_unavailable',
  )
  expect(normalizeRuntimeFailure({ codexErrorInfo: 'sandboxError', message: 'quota exhausted' })).toBe('unknown')
  expect(normalizeRuntimeFailure({ message: 'build failed: rate limit test' })).toBe('unknown')
  expect(normalizeRuntimeFailure({ code: 'insufficient_quota' })).toBe('quota_exhausted')
})
