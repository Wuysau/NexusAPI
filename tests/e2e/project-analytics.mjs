import assert from 'node:assert/strict'

/** Real DB → route → browser. Only the explicit 403 failure is fault-injected. */
export async function projectAnalyticsE2E(page, db, origin) {
  const prefix = `analytics-e2e-${Date.now()}`
  const nameA = `Analytics A ${prefix}`,
    nameB = `Analytics B ${prefix}`
  for (const [suffix, currency, reasoning] of [
    ['a', 'USD', null],
    ['b', 'CNY', 0],
  ]) {
    const id = `${prefix}-${suffix}`
    await db.query("INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,'tenant-dev','org-dev',$2)", [
      id,
      `Analytics ${suffix.toUpperCase()} ${prefix}`,
    ])
    await db.query(
      `INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind,status,started_at,charge_amount,charge_currency,gross_margin_amount)
      VALUES($1,'tenant-dev','org-dev','analytics-model','platform','completed',now()-interval '1 minute',1234567,$2,1234565)`,
      [id, currency],
    )
    await db.query(
      `INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,execution_mode,attribution_status)
      VALUES($1,'tenant-dev','org-dev',$1,$2,'managed','attributed')`,
      [id, `Analytics ${suffix.toUpperCase()} ${prefix}`],
    )
    const event = {
      schema_version: 2,
      tenant_id: 'tenant-dev',
      request_id: id,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 0,
        reasoning_tokens: reasoning,
        total_tokens: 120,
        estimated: false,
      },
    }
    await db.query(
      "INSERT INTO usage_events(id,tenant_id,request_id,event_id,event_type,payload) VALUES($1,'tenant-dev',$1,$1,'usage',$2)",
      [id, JSON.stringify({ event })],
    )
    await db.query(
      "INSERT INTO usage_records(id,tenant_id,request_id,usage_event_id,authoritative_metering,upstream_cost_amount,upstream_cost_currency) VALUES($1,'tenant-dev',$1,$1,$2,2,$3)",
      [id, JSON.stringify(event), currency],
    )
  }
  const errors = []
  const onError = (error) => errors.push(error.message)
  page.on('pageerror', onError)
  try {
    const initial = page.waitForResponse((r) => r.url().includes('/api/billing?') && r.request().method() === 'GET')
    await page.goto(origin + '/billing', { waitUntil: 'networkidle' })
    assert.equal((await initial).status(), 200)
    const panel = page.getByRole('region', { name: '项目用量分析' })
    await panel.getByRole('cell', { name: nameA, exact: true }).waitFor()
    assert.match(await panel.innerText(), /USD/)
    assert.match(await panel.innerText(), /CNY/)
    assert.match(await panel.getByRole('row').filter({ hasText: nameA }).innerText(), /未知/)
    const project = panel.getByRole('combobox', { name: '项目', exact: true })
    async function change(action, test) {
      const response = page.waitForResponse(
        (r) => r.url().includes('/api/billing?') && test(new URL(r.url()).searchParams),
      )
      await action()
      assert.equal((await response).status(), 200)
    }
    await change(
      () => project.selectOption(`${prefix}-a`),
      (p) => p.get('projectId') === `${prefix}-a`,
    )
    await panel.getByRole('cell', { name: nameA, exact: true }).waitFor()
    assert.equal(await panel.getByRole('cell', { name: nameB, exact: true }).count(), 0)
    await change(
      () => project.selectOption(`${prefix}-b`),
      (p) => p.get('projectId') === `${prefix}-b`,
    )
    await panel.getByRole('cell', { name: nameB, exact: true }).waitFor()
    const row = panel.getByRole('row').filter({ hasText: nameB })
    assert.equal(await row.locator('td').nth(6).innerText(), '0')
    for (const group of ['model', 'provider', 'executionMode', 'apiKey', 'connection', 'project']) {
      await change(
        () => panel.getByLabel('分组').selectOption(group),
        (p) => p.get('groupBy') === group,
      )
      await panel.getByRole('cell', { name: '合计', exact: true }).waitFor()
    }
    await change(
      () => panel.locator('input[type=date]').first().fill('2020-01-01'),
      (p) => p.get('from').startsWith('2019-12-31') || p.get('from').startsWith('2020-01-01'),
    )
    await change(
      () => panel.locator('input[type=date]').last().fill('2020-01-02'),
      (p) => p.get('to').startsWith('2020-01-02') || p.get('to').startsWith('2020-01-03'),
    )
    await panel.getByText('所选范围暂无项目用量', { exact: true }).waitFor()
    await page.screenshot({ path: '.test-artifacts/analytics-empty.png', fullPage: true })
    await page.route('**/api/billing?**', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Forbidden', code: 'forbidden' } }),
      }),
    )
    await project.selectOption(`${prefix}-a`)
    await panel.getByText('没有访问权限', { exact: true }).waitFor()
    assert.equal(await panel.getByRole('cell', { name: nameB, exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await page.unroute('**/api/billing?**')
    page.off('pageerror', onError)
  }
}
