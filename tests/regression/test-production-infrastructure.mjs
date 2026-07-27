// e2e test for production-infrastructure plan
// Run: node test-production-infrastructure.mjs

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
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  // ====================================================================
  // /api/status — enhanced with memory check
  // ====================================================================
  console.log('\n📊 /api/status — enhanced with memory')
  // Need to be on a page for fetch to work
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  const statusRes = await page.evaluate(async () => {
    const r = await fetch('/api/status')
    return r.json()
  })
  check('status returns 200', statusRes.status === 'ok', `status: ${statusRes.status}`)
  check('status has db check', !!statusRes.checks?.db, `checks: ${Object.keys(statusRes.checks ?? {})}`)
  check('status has redis check', !!statusRes.checks?.redis)
  check('status has memory check', !!statusRes.checks?.memory)
  check('memory check returns ok or message', statusRes.checks?.memory?.ok !== undefined)
  check('status includes version', !!statusRes.version)
  check('status includes uptime', typeof statusRes.uptime === 'number')

  // ====================================================================
  // /api/admin/metrics — admin only
  // ====================================================================
  console.log('\n🔐 /api/admin/metrics — admin only')
  // Unauthenticated → 403
  const unauthRes = await page.evaluate(async () => {
    const r = await fetch('/api/admin/metrics')
    return { status: r.status }
  })
  check('unauthenticated gets 403', unauthRes.status === 403, `status: ${unauthRes.status}`)

  // Sign in as admin
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  const metricsRes = await page.evaluate(async () => {
    const r = await fetch('/api/admin/metrics', { credentials: 'include' })
    return { status: r.status, body: await r.json() }
  })
  check('admin metrics returns 200', metricsRes.status === 200, `status: ${metricsRes.status}`)
  check('metrics has inProcess section', !!metricsRes.body.inProcess, `body: ${JSON.stringify(metricsRes.body).slice(0, 100)}`)
  check('metrics has db section', !!metricsRes.body.db)
  check('metrics has server section', !!metricsRes.body.server)
  check('inProcess has searches counter', typeof metricsRes.body.inProcess.searches === 'number')
  check('db has totalUsers', typeof metricsRes.body.db.totalUsers === 'number')
  check('server has nodeVersion', !!metricsRes.body.server.nodeVersion)

  // ====================================================================
  // /admin/metrics — admin UI page
  // ====================================================================
  console.log('\n🔧 /admin/metrics — admin UI page')
  await page.goto(`${BASE}/admin/metrics`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="admin-metrics-page"]', { timeout: 5000 })
  check('admin metrics page loads', true)

  const inProcessSection = await page.$('[data-testid="metrics-inprocess"]')
  check('shows in-process section', !!inProcessSection)
  const dbSection = await page.$('[data-testid="metrics-db"]')
  check('shows db section', !!dbSection)
  const serverSection = await page.$('[data-testid="metrics-server"]')
  check('shows server section', !!serverSection)

  // Should have at least the search metric card
  const searchesCard = await page.$('[data-testid="metric-card-searches"]')
  check('has searches metric card', !!searchesCard)
  const usersCard = await page.$('[data-testid="metric-card-total-users"]')
  check('has total users card', !!usersCard)

  await page.screenshot({ path: '/tmp/builderhunt-admin-metrics.png', fullPage: true })

  // ====================================================================
  // Sidebar has Metrics link
  // ====================================================================
  console.log('\n🔗 Sidebar has Metrics link')
  const metricsLink = await page.$('[data-testid="admin-nav-metrics"]')
  check('sidebar has metrics link', !!metricsLink)

  // ====================================================================
  // Search cache still works (in-memory fallback since no Redis)
  // ====================================================================
  console.log('\n🔍 Search cache (in-memory fallback)')
  await page.goto(`${BASE}/explore?q=react`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  const cards = await page.$$('article[data-testid^="person-card-"]')
  check('explore renders cards with in-memory cache', cards.length > 0, `count: ${cards.length}`)

  // ====================================================================
  // Status page still works with new memory check
  // ====================================================================
  console.log('\n🌐 /status — public status page')
  await page.context().clearCookies()
  await page.goto(`${BASE}/status`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="status-overall"]', { timeout: 5000 })
  // The new memory check might not show in the status page since I only added it to API
  // Just verify the page still loads
  const statusH1 = await page.textContent('h1')
  check('status page h1 still loads', statusH1?.includes('System status') ?? false, `h1: ${statusH1}`)

  await browser.close()

  console.log('\n' + '='.repeat(60))
  console.log(`Total: ${pass + fail} | ✅ ${pass} | ❌ ${fail}`)
  console.log('='.repeat(60))

  writeFileSync('/tmp/builderhunt-prod-infra-results.txt',
    results.join('\n') + `\n\nTotal: ${pass + fail} | ✅ ${pass} | ❌ ${fail}\n`)

  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
