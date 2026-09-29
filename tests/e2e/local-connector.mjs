// Run after local-connector.test.ts against its dedicated fixture database and a Next dev server.
import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import pg from 'pg'
import { chromium } from 'playwright'

if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.includes('connector_test'))
  throw new Error('Dedicated connector_test database required')
const origin = process.env.TEST_ORIGIN ?? 'http://127.0.0.1:3217'
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const password = randomBytes(24).toString('base64url')
const salt = randomBytes(16)
const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })
await db.connect()
await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [
  `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`,
  'connector-owner',
])
await db.end()
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(origin + '/connections')
  await page.getByLabel('邮箱', { exact: true }).fill('connector@example.invalid')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: '添加连接', exact: true }).first().waitFor()
  await page.getByRole('button', { name: '添加连接', exact: true }).first().click()
  const create = page.getByRole('dialog')
  await create.locator('select').first().selectOption('local_sidecar')
  await create.getByLabel('绑定项目（可选）', { exact: true }).selectOption('connector-project')
  await create.getByRole('button', { name: '添加连接', exact: true }).click()
  await page.getByRole('button', { name: '配置与详情', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('连接器模型 ID', { exact: true }).fill('qwen2.5:7b\nllama3.2:3b')
  await dialog.getByRole('button', { name: '保存模型并生成一次性配对令牌 / 轮换身份', exact: true }).click()
  await dialog.getByText('仅本次显示', { exact: false }).waitFor()
  const token = await dialog
    .locator('code')
    .filter({ hasText: /^nxpair_/ })
    .textContent()
  assert.match(token, /^nxpair_[A-Za-z0-9_-]{43}$/)
  await dialog.getByRole('button', { name: '已保存，隐藏令牌', exact: true }).click()
  assert.equal(
    await dialog
      .locator('code')
      .filter({ hasText: /^nxpair_/ })
      .count(),
    0,
  )
  await dialog.getByText('本机安装、配置与启动', { exact: true }).click()
  await mkdir('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/local-connector.png', fullPage: true })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: '配置与详情', exact: true }).first().click()
  assert.equal(
    await page
      .getByRole('dialog')
      .locator('code')
      .filter({ hasText: /^nxpair_/ })
      .count(),
    0,
  )
  assert.deepEqual(errors, [])
  console.log(
    'PASS browser: create local connector, configure multiple models, one-time pairing, hide/reload token, install instructions; no browser errors',
  )
} finally {
  await browser.close()
}
