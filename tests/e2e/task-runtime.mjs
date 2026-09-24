import assert from 'node:assert/strict'

// Mocked control-plane responses exercise the browser contract without launching Codex.
export async function taskRuntimeE2E(page, origin) {
  const writes = []
  let failed = false
  let policy = null
  const baseTask = {
    projectId: 'project-ui',
    cwd: 'D:/registered/workspace',
    activeTool: 'codex',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-22T00:00:00Z',
    pauseReason: null,
    nextResetAt: null,
    handoffs: 0,
    resourceSwitchCount: 0,
    transitions: [],
    history: [],
    sessions: [],
    usage: [{ connectionId: 'conn-a', totalTokens: null }],
  }
  const tasks = [
    {
      ...baseTask,
      id: 'task-running',
      originalGoal: '完成安全交接界面',
      status: 'running',
      activeResource: 'conn-a',
      activeSession: 'session-a',
      resourceSwitchCount: 1,
      transitions: [
        {
          id: 'transition-1',
          source_connection_id: 'conn-b',
          target_connection_id: 'conn-a',
          source_conversation_id: 'session-a',
          target_conversation_id: 'session-a',
          switch_type: 'runtime_restart',
          reason: 'quota_exhausted',
          created_at: '2026-09-22T00:00:00Z',
        },
      ],
    },
    {
      ...baseTask,
      id: 'task-paused',
      originalGoal: '等待资源恢复',
      status: 'paused',
      activeResource: null,
      activeSession: null,
      pauseReason: 'no_available_resource',
      nextResetAt: '2100-01-01T00:00:00Z',
    },
  ]
  await page.context().addCookies([{ name: 'nexus_csrf', value: 'task-ui-csrf', url: origin }])
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const fulfill = (json, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) })
    if (path === '/api/auth/session')
      return fulfill({
        authenticated: true,
        user: { id: 'ui-user', email: 'ui@example.test', name: 'UI Test' },
        organization: { id: 'ui-org', tenantId: 'ui-tenant', name: 'UI Test', slug: 'ui-test' },
        role: 'owner',
        capabilities: ['project:read', 'project:update', 'credential:read'],
        freshAuth: true,
        sessionExpiresAt: '2100-01-01T00:00:00Z',
        environment: 'test',
      })
    if (path === '/api/projects')
      return fulfill({
        projects: [{ id: 'project-ui', name: '界面验证项目', workspaceRoots: ['D:/registered/workspace'] }],
      })
    if (path === '/api/connections')
      return fulfill({
        connections: ['conn-a', 'conn-b'].map((id) => ({
          id,
          provider: 'openai',
          status: 'active',
          project_id: 'project-ui',
          revoked_at: null,
        })),
      })
    if (path === '/api/task-runtime' && method === 'GET') {
      if (failed) return fulfill({ error: { code: 'unavailable', message: '测试网络错误' } }, 503)
      return fulfill({
        policy,
        tasks,
        resources:
          policy?.candidates.map((candidate) => ({
            ...candidate,
            provider: 'openai',
            product: 'codex',
            resourceType: 'official_subscription',
            executionMode: 'local',
            availability: 'available',
            quotaState: 'available',
            usedPercent: 10,
            resetAt: '2100-01-01T00:00:00Z',
          })) ?? [],
      })
    }
    if (method !== 'GET') {
      assert.equal(request.headers()['x-csrf-token'], 'task-ui-csrf')
      const body = request.postDataJSON()
      writes.push({ path, method, body })
      if (path === '/api/task-runtime/policy') {
        assert.equal(method, 'PUT')
        assert.equal(body.projectId, 'project-ui')
        policy = body.policy
      }
      return fulfill({ ok: true })
    }
    return fulfill({})
  })
  await page.goto(origin + '/tasks')
  await page.getByRole('heading', { name: '完成安全交接界面' }).waitFor()
  await page.getByRole('button', { name: '编辑策略' }).click()
  let dialog = page.getByRole('dialog', { name: '路由策略' })
  await dialog.getByLabel('策略名称').fill('交接验证策略')
  for (const [index, id] of ['conn-a', 'conn-b'].entries()) {
    await dialog.getByRole('button', { name: '添加候选资源' }).click()
    const group = dialog.getByRole('group', { name: `候选资源 ${index + 1}` })
    await group.getByRole('combobox').first().selectOption(id)
    await group.getByLabel('Profile 引用').fill('profile-' + id)
    await group.getByLabel('优先级').fill(String(index + 1))
  }
  const first = dialog.getByRole('group', { name: '候选资源 1' })
  await first.getByText('兼容性设置', { exact: true }).click()
  await first.getByLabel('能力（逗号分隔）').fill('coding,tool_calling,long_context')
  await first.getByLabel('允许的模型（留空不限，逗号分隔）').fill('model-a,model-b')
  await dialog.getByLabel('任务模型（留空不限）').fill('model-a')
  await dialog.getByRole('button', { name: '保存策略' }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(policy.candidates[0].allowedModels, ['model-a', 'model-b'])
  assert.deepEqual(policy.candidates[0].capabilities, ['coding', 'tool_calling', 'long_context'])
  await page.getByRole('button', { name: '切换资源', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '切换资源' })
  await dialog.getByLabel('目标资源').selectOption('conn-b')
  await dialog.getByRole('button', { name: '提交切换' }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(writes.find((w) => w.path.endsWith('/switch'))?.body, { targetConnectionId: 'conn-b' })
  await page.getByRole('button', { name: '恢复任务', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '恢复任务' })
  await dialog.getByRole('button', { name: '确认恢复' }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(writes.find((w) => w.path.endsWith('/resume'))?.body, {})
  await page.screenshot({ path: '.test-artifacts/task-runtime-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
    '390px page overflow',
  )
  await page.getByRole('button', { name: '编辑策略' }).click()
  dialog = page.getByRole('dialog', { name: '路由策略' })
  assert.equal(
    await dialog.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
    '390px policy dialog overflow',
  )
  await page.screenshot({ path: '.test-artifacts/task-runtime-policy-mobile.png', fullPage: true })
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  failed = true
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '测试网络错误' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '恢复任务', exact: true }).isDisabled(), true)
  await page.screenshot({ path: '.test-artifacts/task-runtime-error-mobile.png', fullPage: true })
  return {
    checks: [
      'policy create and comma lists',
      'CSRF PUT/POST',
      'safe switch',
      'resume',
      '390px layout',
      'stale-data mutation lock',
    ],
    writes: writes.length,
  }
}
