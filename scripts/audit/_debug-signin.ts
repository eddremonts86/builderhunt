/**
 * _debug-signin.ts — one-shot sign-in debug. Not part of the audit. Used to
 * see what the auth form does when the walker fails to navigate.
 */
import { chromium } from 'playwright'

const BASE_URL = (process.env.SAAS_REVIEW_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL = process.env.SAAS_REVIEW_OWNER_EMAIL ?? 'saas-review-owner@test.local'
const PASSWORD = process.env.SAAS_REVIEW_OWNER_PASSWORD ?? 'SaasReview!Owner#1'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  page.on('console', (msg) => console.log(`  console.${msg.type()}: ${msg.text()}`))
  page.on('response', async (r) => {
    if (r.url().startsWith(BASE_URL) && r.url().includes('/api/auth')) {
      const text = await r.text().catch(() => '<no body>')
      console.log(`  AUTH api: ${r.status()} ${r.url()}\n    body: ${text.slice(0, 300)}`)
    }
  })
  page.on('response', (r) => {
    if (r.url().startsWith(BASE_URL) && r.url().includes('/api/')) {
      console.log(`  api: ${r.status()} ${r.url()}`)
    }
  })
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(BASE_URL)) console.log(`  reqfail: ${r.url()} ${r.failure()?.errorText}`)
  })

  console.log(`→ goto ${BASE_URL}/auth/sign-in`)
  await page.goto(`${BASE_URL}/auth/sign-in`, { waitUntil: 'domcontentloaded' })
  console.log(`  url: ${page.url()}`)

  console.log('→ fill form')
  await page.locator('input[type="email"]').first().fill(EMAIL)
  await page.locator('input[type="password"]').first().fill(PASSWORD)

  console.log('→ click submit')
  await page.locator('button[type="submit"]').first().click()

  console.log('→ wait 8s for any nav/state change')
  await page.waitForTimeout(8_000)
  console.log(`  url: ${page.url()}`)

  // Try to find any error message
  const error = await page
    .locator('[role="alert"], [role="status"], .text-bh-danger')
    .first()
    .textContent({ timeout: 1_000 })
    .catch(() => null)
  console.log(`  visible text: ${error?.trim() ?? '(none found)'}`)

  // Check localStorage / cookies
  const cookies = await ctx.cookies()
  console.log(`  cookies: ${cookies.length} — ${cookies.map((c) => c.name).join(', ')}`)

  await browser.close()
}

main().catch((err) => {
  console.error('debug-signin failed:', err)
  process.exit(1)
})
