import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { prepareObserverPathPicker } from './observer-path-picker.mjs'

export async function workspaceManagementE2E(page, db, origin) {
  const suffix = Date.now()
  const name = 'Workspace UI ' + suffix
  await page.goto(origin + '/projects', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '创建项目', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '创建项目', exact: true })
  await dialog.getByLabel('项目名称', { exact: true }).fill(name)
  await dialog.getByLabel('工作目录（可选）', { exact: true }).fill('/workspace-ui/' + suffix)
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  let card = page.getByRole('article', { name, exact: true })
  await card.waitFor()
  await page.reload({ waitUntil: 'networkidle' })
  await card.getByText('/workspace-ui/' + suffix, { exact: true }).waitFor()
  const project = (
    await db.query('SELECT id,policy_version FROM projects WHERE tenant_id=$1 AND name=$2', ['tenant-dev', name])
  ).rows[0]
  assert.ok(project)
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '编辑项目', exact: true })
  await dialog.getByLabel('项目名称', { exact: true }).fill(name + ' renamed')
  await dialog.getByRole('button', { name: '保存修改' }).click()
  await dialog.waitFor({ state: 'hidden' })
  card = page.getByRole('article', { name: name + ' renamed', exact: true })
  await card.waitFor()
  await page.screenshot({ path: '.test-artifacts/workspace-projects-e2e.png', fullPage: true })

  await page.goto(origin + '/connections', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '添加连接', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '添加连接', exact: true })
  await dialog.getByLabel('绑定项目（可选）', { exact: true }).selectOption(project.id)
  const created = page.waitForResponse((r) => r.url().endsWith('/api/connections') && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '添加连接', exact: true }).click()
  const response = await created
  assert.equal(response.status(), 201)
  const connection = (await response.json()).connection
  await dialog.waitFor({ state: 'hidden' })
  let connectionCard = page.getByRole('article', { name: 'OpenAI Codex ' + connection.id, exact: true })
  await connectionCard.getByText('待采集', { exact: true }).waitFor()
  await page.reload({ waitUntil: 'networkidle' })
  await connectionCard.getByText(name + ' renamed', { exact: true }).waitFor()
  const verifyPicker = await prepareObserverPathPicker(page)
  await connectionCard.getByRole('button', { name: '配置与详情' }).click()
  dialog = page.getByRole('dialog', { name: 'OpenAI Codex · 连接详情' })
  await dialog
    .locator('summary')
    .filter({ hasText: /^本地同步配置$/ })
    .click()
  await verifyPicker(dialog)
  await dialog.getByLabel('本机 Codex 记录路径', { exact: true }).fill('/local/codex/sessions')
  const downloaded = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '下载 Observer 配置' }).click()
  const config = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'))
  assert.equal(config.providers[0].connectionId, connection.id)
  assert.equal(config.tenantId, 'tenant-dev')
  assert.ok(config.roots.some((r) => r.projectId === project.id))
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await page.screenshot({ path: '.test-artifacts/workspace-connections-e2e.png', fullPage: true })
  for (const route of ['projects', 'connections']) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(origin + '/' + route, { waitUntil: 'networkidle' })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      route + ' mobile overflow',
    )
    await page.screenshot({ path: '.test-artifacts/workspace-' + route + '-mobile.png', fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  connectionCard = page.getByRole('article', { name: 'OpenAI Codex ' + connection.id, exact: true })
  await connectionCard.getByRole('button', { name: '撤销连接', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '撤销连接', exact: true })
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await connectionCard.getByRole('button', { name: '撤销连接', exact: true }).click()
  await dialog.getByRole('button', { name: '确认撤销', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await connectionCard.getByText('已撤销', { exact: true }).waitFor()
  assert.equal(await connectionCard.getByRole('button', { name: '撤销连接', exact: true }).count(), 0)

  await page.goto(origin + '/projects', { waitUntil: 'networkidle' })
  card = page.getByRole('article', { name: name + ' renamed', exact: true })
  await card.getByRole('link', { name: '用量分析' }).click()
  await page.getByRole('region', { name: '项目用量分析' }).waitFor()
  await page.goto(origin + '/projects', { waitUntil: 'networkidle' })
  await card.getByRole('button', { name: '归档', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '归档项目', exact: true })
  await dialog.getByRole('button', { name: '确认归档' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await card.waitFor({ state: 'hidden' })
  assert.equal(
    (await db.query('SELECT status FROM projects WHERE tenant_id=$1 AND id=$2', ['tenant-dev', project.id])).rows[0]
      .status,
    'archived',
  )
}
