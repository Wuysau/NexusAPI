import 'dotenv/config'
import { chromium } from 'playwright'

const origin = process.env.TEST_ORIGIN || 'http://localhost:3000'
const adminToken = process.env.ADMIN_TOKEN || ''
const out = '.test-artifacts'

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

if (adminToken) await page.addInitScript((t) => sessionStorage.setItem('nexus-admin', t), adminToken)

await page.goto(origin, { waitUntil: 'networkidle' })
await page.getByText('OpenAI 官方渠道', { exact: true }).waitFor({ timeout: 15000 })
await page.screenshot({ path: `${out}/dashboard.png`, fullPage: true })
console.log('dashboard.png captured')

// Visit a couple of sections for a fuller picture.
for (const [label, locator] of [
  ['models', page.locator('nav').getByRole('button', { name: '模型广场' })],
  ['logs', page.locator('nav').getByRole('button', { name: '请求日志' })],
]) {
  await locator.click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/${label}.png`, fullPage: true })
  console.log(`${label}.png captured`)
}

if (errors.length) console.error('browser errors:', errors)
await browser.close()
