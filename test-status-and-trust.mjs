// e2e test for status-and-trust plan
// Run: node test-status-and-trust.mjs
// Requires: dev server running on http://localhost:3000, admin user seeded

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

async function signOut(page) {
  await page.context().clearCookies()
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
}

async function run() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  // ====================================================================
  // PUBLIC: /status page
  // ====================================================================
  console.log('\n📋 /status — public status page')
  await page.goto(`${BASE}/status`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="status-overall"]', { timeout: 5000 })
  const statusText = await page.textContent('[data-testid="status-overall"]')
  check('renders status overall card', !!statusText, 'empty status card')
  check('shows "All systems operational" or degraded', /All systems|Some systems/.test(statusText ?? ''))
  const dbRow = await page.$('[data-testid="status-row-db"]')
  check('shows database component row', !!dbRow)
  const redisRow = await page.$('[data-testid="status-row-redis"]')
  check('shows redis component row', !!redisRow)
  await page.screenshot({ path: '/tmp/builderhunt-status.png', fullPage: true })

  // ====================================================================
  // PUBLIC: /changelog list
  // ====================================================================
  console.log('\n📋 /changelog — public changelog list')
  await page.goto(`${BASE}/changelog`, { waitUntil: 'networkidle' })
  await page.waitForSelector('h1', { timeout: 5000 })
  const h1 = await page.textContent('h1')
  check('changelog h1 visible', h1 === 'Changelog', `got "${h1}"`)
  // Empty state or entries
  const empty = await page.$('text=No changelog entries yet')
  const entries = await page.$$('[data-testid="changelog-entry"]')
  check('changelog shows empty state or entries', !!empty || entries.length > 0)
  await page.screenshot({ path: '/tmp/builderhunt-changelog-list.png', fullPage: true })

  // ====================================================================
  // PUBLIC: /roadmap list (just check page loads, columns checked later after admin creates item)
  // ====================================================================
  console.log('\n📋 /roadmap — public roadmap list')
  await page.goto(`${BASE}/roadmap`, { waitUntil: 'networkidle' })
  await page.waitForSelector('h1', { timeout: 5000 })
  const rh1 = await page.textContent('h1')
  check('roadmap h1 visible', rh1 === 'Roadmap', `got "${rh1}"`)
  await page.screenshot({ path: '/tmp/builderhunt-roadmap-public.png', fullPage: true })

  // ====================================================================
  // FOOTER: trust links
  // ====================================================================
  console.log('\n📋 Footer — trust links on landing')
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  const statusLink = await page.$('[data-testid="footer-status"]')
  check('footer has status link', !!statusLink)
  const clLink = await page.$('[data-testid="footer-changelog"]')
  check('footer has changelog link', !!clLink)
  const rmLink = await page.$('[data-testid="footer-roadmap"]')
  check('footer has roadmap link', !!rmLink)
  await page.screenshot({ path: '/tmp/builderhunt-footer.png', fullPage: true })

  // ====================================================================
  // SIGN IN as admin
  // ====================================================================
  console.log('\n🔐 Signing in as admin')
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  check('admin sign in succeeded', page.url().includes('/dashboard') || page.url().includes('/admin') || page.url().includes('/onboarding'))

  // ====================================================================
  // ADMIN: /admin/incidents — list, create, resolve
  // ====================================================================
  console.log('\n🔧 /admin/incidents — admin incident management')
  await page.goto(`${BASE}/admin/incidents`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="admin-incidents-page"]', { timeout: 5000 })
  check('admin incidents page loads', true)
  // Click "New incident"
  await page.click('[data-testid="admin-incident-new"]')
  await page.waitForSelector('[data-testid="admin-incident-form"]', { timeout: 3000 })
  await page.fill('[data-testid="admin-incident-title"]', 'E2E Test Incident — DB slow')
  await page.fill('[data-testid="admin-incident-description"]', 'Investigation triggered by automated e2e test')
  await page.selectOption('[data-testid="admin-incident-severity"]', 'minor')
  await page.click('[data-testid="admin-incident-component-database"]')
  await page.click('[data-testid="admin-incident-save"]')
  await page.waitForTimeout(1500)
  const newRow = await page.$('text=E2E Test Incident')
  check('new incident appears in list', !!newRow)
  await page.screenshot({ path: '/tmp/builderhunt-admin-incidents.png', fullPage: true })

  // Resolve the incident
  const resolveBtn = await page.$('[data-testid="admin-incident-resolve"]')
  if (resolveBtn) {
    await resolveBtn.click()
    await page.waitForTimeout(1500)
    const resolvedBadge = await page.$('text=resolved')
    check('incident moves to resolved state', !!resolvedBadge)
  } else {
    check('resolve button found', false, 'no resolve button')
  }

  // ====================================================================
  // ADMIN: /admin/changelog — create entry
  // ====================================================================
  console.log('\n🔧 /admin/changelog — admin changelog management')
  await page.goto(`${BASE}/admin/changelog`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="admin-changelog-page"]', { timeout: 5000 })
  await page.click('[data-testid="admin-changelog-new"]')
  await page.waitForSelector('[data-testid="admin-changelog-form"]', { timeout: 3000 })
  await page.fill('[data-testid="admin-changelog-title"]', 'E2E Test Changelog Entry')
  await page.fill('[data-testid="admin-changelog-content"]', '## What we shipped\n\nAn automated e2e test published this entry to verify the changelog pipeline.\n\n- Test feature 1\n- Test feature 2')
  await page.fill('[data-testid="admin-changelog-slug"]', 'e2e-test-entry')
  await page.click('[data-testid="admin-changelog-tag-feature"]')
  await page.click('[data-testid="admin-changelog-save"]')
  await page.waitForTimeout(1500)
  const clEntry = await page.$('text=E2E Test Changelog Entry')
  check('changelog entry created', !!clEntry)
  await page.screenshot({ path: '/tmp/builderhunt-admin-changelog.png', fullPage: true })

  // Verify it appears on public changelog
  await page.goto(`${BASE}/changelog`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const publicCl = await page.$('text=E2E Test Changelog Entry')
  check('changelog entry visible publicly', !!publicCl)

  // Visit detail page
  const readMore = await page.$('a[href*="e2e-test-entry"]')
  if (readMore) {
    await Promise.all([
      page.waitForURL(/changelog\/e2e-test-entry/, { timeout: 5000 }),
      readMore.click(),
    ])
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    const detailH1 = await page.textContent('h1')
    check('changelog detail page renders', detailH1?.includes('E2E Test'), `h1: ${detailH1}`)
  } else {
    check('changelog read more link found', false)
  }

  // ====================================================================
  // ADMIN: /admin/roadmap — create + vote
  // ====================================================================
  console.log('\n🔧 /admin/roadmap — admin roadmap management')
  await page.goto(`${BASE}/admin/roadmap`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="admin-roadmap-page"]', { timeout: 5000 })
  await page.click('[data-testid="admin-roadmap-new"]')
  await page.waitForSelector('[data-testid="admin-roadmap-form"]', { timeout: 3000 })
  await page.fill('[data-testid="admin-roadmap-title"]', 'E2E Test Roadmap Item')
  await page.fill('[data-testid="admin-roadmap-description"]', 'A roadmap item added by automated e2e test')
  await page.selectOption('[data-testid="admin-roadmap-status"]', 'planned')
  await page.fill('[data-testid="admin-roadmap-estimate"]', 'Q4 2026')
  await page.click('[data-testid="admin-roadmap-save"]')
  await page.waitForTimeout(1500)
  const rmEntry = await page.$('text=E2E Test Roadmap Item')
  check('roadmap item created', !!rmEntry)
  await page.screenshot({ path: '/tmp/builderhunt-admin-roadmap.png', fullPage: true })

  // Verify it appears on public roadmap and can be voted on
  await page.goto(`${BASE}/roadmap`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const publicRm = await page.$('text=E2E Test Roadmap Item')
  check('roadmap item visible publicly', !!publicRm)
  // Verify 3 columns now exist
  const colHeaders = await page.$$eval('h2', (els) => els.map((e) => e.textContent?.trim() ?? ''))
  check('shows 3 columns (Planned, In progress, Shipped)',
    colHeaders.includes('Planned') && colHeaders.includes('In progress') && colHeaders.includes('Shipped'),
    `headers: ${colHeaders.join(', ')}`)
  // Vote
  const voteBtn = await page.$('[data-testid="roadmap-vote-btn"]')
  if (voteBtn) {
    await voteBtn.click()
    await page.waitForTimeout(1000)
    check('vote button clicked', true)
  } else {
    check('vote button found', false)
  }

  // ====================================================================
  // ADMIN: non-admin gets 403
  // ====================================================================
  console.log('\n🔐 Non-admin access blocked')
  await signOut(page)
  // Create a non-admin user first
  await page.goto(`${BASE}/auth/sign-up`, { waitUntil: 'networkidle' })
  const testEmail = `e2e_user_${Date.now()}@test.com`
  await page.fill('input[type="text"]', 'E2E Test User')
  await page.fill('input[type="email"]', testEmail)
  await page.fill('input[type="password"]', 'TestPass1234!')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(2000)
  // Try to access admin endpoint
  const apiRes = await page.evaluate(async () => {
    const r = await fetch('/api/admin/incidents', { credentials: 'include' })
    return { status: r.status }
  })
  check('non-admin gets 403 on admin endpoint', apiRes.status === 403, `status: ${apiRes.status}`)
  // Try to access admin UI
  await page.goto(`${BASE}/admin/incidents`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const errText = await page.textContent('body')
  check('non-admin gets error on admin UI', /Unauthorized|Forbidden/.test(errText ?? '') || !errText?.includes('New incident'),
    `body: ${errText?.slice(0, 100)}`)

  await browser.close()

  // ====================================================================
  // Summary
  // ====================================================================
  console.log('\n' + '='.repeat(60))
  console.log(`Total: ${pass + fail} | ✅ ${pass} | ❌ ${fail}`)
  console.log('='.repeat(60))

  writeFileSync('/tmp/builderhunt-status-and-trust-results.txt',
    results.join('\n') + `\n\nTotal: ${pass + fail} | ✅ ${pass} | ❌ ${fail}\n`)

  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
