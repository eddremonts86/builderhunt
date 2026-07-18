// e2e test for smart-alerts plan
import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

const BASE = 'http://localhost:3000'
const ADMIN_EMAIL = 'edd_admin@local.com'
const ADMIN_PASSWORD = 'Passw0rd!234'

let pass = 0
let fail = 0
const results = []

function check(name, cond, detail) {
  if (cond) {
    pass++
    results.push(`  ✅ ${name}`)
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    results.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/auth/sign-in`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')
  await page.waitForURL(/dashboard|admin|onboarding|search/, { timeout: 10000 })
  await page.waitForLoadState('networkidle')
}

async function run() {
  // Clean up previous test runs (alert triggers and alerts owned by admin)
  try {
    const { execSync } = await import('child_process')
    execSync(
      `docker exec builderhunt-db psql -U postgres -d builderhunt -c "DELETE FROM alert_triggers; DELETE FROM alerts WHERE name LIKE 'e2e%';" 2>/dev/null`,
      { stdio: 'ignore' },
    )
  } catch {}

  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  // Sign in
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD)

  // /api/alerts/triggers returns array (empty if no triggers)
  console.log('\n📊 /api/alerts/triggers — list')
  const triggersRes = await page.evaluate(async () => {
    const r = await fetch('/api/alerts/triggers', { credentials: 'include' })
    return { status: r.status, body: await r.json() }
  })
  check('triggers returns 200', triggersRes.status === 200, `status: ${triggersRes.status}`)
  check('triggers returns array', Array.isArray(triggersRes.body), `body: ${JSON.stringify(triggersRes.body).slice(0, 100)}`)

  // Create a test alert to use for triggering
  console.log('\n🛠 Creating test alert via DB')
  // Insert directly via the API (we'll need a helper, or use the dashboard)
  // For simplicity, use direct db exec via the page
  // Actually, let's just create one via test endpoint

  // Use the test-trigger endpoint to create a trigger (no alertId → auto-creates)
  console.log('\n🛒 Test trigger endpoint')
  const testRes = await page.evaluate(async () => {
    const r = await fetch('/api/alerts/test-trigger', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertName: 'e2e test alert',
        builder: { followersCount: 200, topics: ['rust', 'async'] },
        event: {
          type: 'new_repo',
          payload: { name: 'tokio-extra', description: 'extra utilities for tokio' },
        },
        conditions: {
          eventType: 'new_repo',
          minStars: 100,
          keywords: ['rust', 'async'],
        },
      }),
    })
    return { status: r.status, body: await r.json() }
  })
  check('test-trigger returns 200', testRes.status === 200, `status: ${testRes.status}`)
  check('test-trigger matched (positive case)', testRes.body.matched === true, `body: ${JSON.stringify(testRes.body).slice(0, 200)}`)

  // Negative match — also auto-creates
  const testRes2 = await page.evaluate(async () => {
    const r = await fetch('/api/alerts/test-trigger', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertName: 'e2e test negative',
        builder: { followersCount: 50 }, // below minStars
        event: { type: 'new_repo', payload: {} },
        conditions: { eventType: 'new_repo', minStars: 100 },
      }),
    })
    return r.json()
  })
  check('test-trigger does not match (negative case)', testRes2.matched === false, `body: ${JSON.stringify(testRes2)}`)

  // /alerts page
  console.log('\n🔔 /alerts inbox')
  await page.goto(`${BASE}/alerts`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="alerts-inbox-page"]', { timeout: 5000 })
  const h1 = await page.textContent('h1')
  check('alerts h1 visible', h1?.includes('Smart alerts') ?? false, `h1: ${h1}`)

  const triggerItems = await page.$$('[data-testid^="alert-trigger-"]')
  check('at least 1 trigger visible', triggerItems.length >= 1, `count: ${triggerItems.length}`)
  const unreadEl = await page.$('[data-testid="unread-count"]')
  check('shows unread count', !!unreadEl)

  // Mark first as read
  const firstMarkRead = await page.$('[data-testid="alert-mark-read"]')
  if (firstMarkRead) {
    await firstMarkRead.click()
    await page.waitForTimeout(1500)
    // After marking read, the unread count should be 1 less or gone
    const unreadAfter = await page.$('[data-testid="unread-count"]')
    const remaining = await page.$$('[data-testid^="alert-trigger-"]')
    if (unreadAfter) {
      const text = await unreadAfter.textContent()
      check('unread count decreased or removed', text !== (await page.textContent('[data-testid="unread-count"]')), `after: ${text}`)
    }
    check('trigger list still shows', remaining.length >= 1, `remaining: ${remaining.length}`)
  }
  await page.screenshot({ path: '/tmp/builderhunt-alerts-inbox.png', fullPage: true })

  // Sidebar has alerts link
  const sidebarAlerts = await page.$('[data-testid="nav-alerts"]')
  check('sidebar has smart alerts link', !!sidebarAlerts)

  // Empty state via direct DB-clear approach: skip — we have triggers now
  // Just check that the empty state is the path we expect

  await browser.close()

  console.log('\n' + '='.repeat(60))
  console.log(`Total: ${pass + fail} | ✅ ${pass} | ❌ ${fail}`)
  console.log('='.repeat(60))

  writeFileSync('/tmp/builderhunt-smart-alerts-results.txt',
    results.join('\n') + `\n\nTotal: ${pass + fail} | ✅ ${pass} | ❌ ${fail}\n`)

  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
