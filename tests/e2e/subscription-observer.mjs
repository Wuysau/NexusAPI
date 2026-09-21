import assert from 'node:assert/strict'

export async function subscriptionObserverE2E(page, db, origin) {
  const id = `observer-e2e-${Date.now()}`
  await db.query(
    "INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,'tenant-dev','org-dev','Observer E2E')",
    [id],
  )
  await db.query(
    `INSERT INTO external_observed_usage(tenant_id,organization_id,usage_source,authority,external_session_id,external_event_id,occurred_at,provider,subscription_product,model,input_tokens,cached_input_tokens,output_tokens,total_tokens,project_id,project_name,matched_root,attributed_at,parser_version)
    VALUES('tenant-dev','org-dev','codex_local','client_observed',$1,$1,now()-interval '1 minute','openai','openai_codex','observer-model',20,0,5,25,$1,'Observer E2E','/fixture',now(),'codex-rollout-v1')`,
    [id],
  )
  await page.goto(`${origin}/projects/${id}/analytics`, { waitUntil: 'networkidle' })
  const panel = page.getByRole('region', { name: '项目用量分析' })
  await panel.getByRole('cell', { name: 'Observer E2E', exact: true }).waitFor()
  const selectSource = async (value) => {
    const response = page.waitForResponse(
      (r) => r.url().includes('/api/billing?') && new URL(r.url()).searchParams.get('usageSource') === value,
    )
    await panel.getByRole('combobox', { name: '用量来源', exact: true }).selectOption(value)
    const res = await response
    assert.equal(res.status(), 200)
    return (await res.json()).analytics
  }
  const observed = await selectSource('codex_local')
  assert.equal(observed.totals.observedEvents, '1')
  assert.equal(observed.totals.sessions, '1')
  assert.equal(observed.totals.requests, '0')
  assert.equal(observed.totals.tokens.reasoning.total, null)
  assert.deepEqual(observed.totals.money, [])
  await panel.getByText(/Codex 本地 · 客户端观测/).waitFor()
  assert.match(await panel.innerText(), /观测事件/)
  for (const group of ['model', 'provider', 'subscription', 'day', 'usageSource']) {
    const response = page.waitForResponse(
      (r) => r.url().includes('/api/billing?') && new URL(r.url()).searchParams.get('groupBy') === group,
    )
    await panel.getByLabel('分组').selectOption(group)
    assert.equal((await response).status(), 200)
    await panel.getByRole('cell', { name: '合计', exact: true }).waitFor()
  }
  const gateway = await selectSource('gateway')
  assert.equal(gateway.totals.observedEvents, '0')
  await panel.getByText('所选范围暂无项目用量', { exact: true }).waitFor()
  await selectSource('all')
  await page.screenshot({ path: '.test-artifacts/subscription-observer-e2e.png', fullPage: true })
}
