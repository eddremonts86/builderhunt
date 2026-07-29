// e2e test for pricing-and-billing plan
// Run: node test-pricing-and-billing.mjs

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
  // /pricing — public (plans/phase-1/30-stripe-billing-platform/tasks.md §9 task 3 — real
  // catalog.ts-driven page: Free/Pro/Pro Max/Team, real Stripe amounts, a pack
  // table, and an account-aware Checkout CTA — replaces the old $99 Team /
  // manual-payment content this script used to assert against.)
  // ====================================================================
  console.log('\n📋 /pricing — public pricing page')
  await page.goto(`${BASE}/pricing`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="pricing-page"]', { timeout: 5000 })
  const h1 = await page.textContent('h1')
  check('pricing h1 visible', h1 === 'Pricing', `h1: ${h1}`)

  // 4 tier cards
  const freeTier = await page.$('[data-testid="plan-free"]')
  const proTier = await page.$('[data-testid="plan-pro"]')
  const proMaxTier = await page.$('[data-testid="plan-pro_max"]')
  const teamTier = await page.$('[data-testid="plan-team"]')
  check('shows Free tier', !!freeTier)
  check('shows Pro tier', !!proTier)
  check('shows Pro Max tier', !!proMaxTier)
  check('shows Team tier', !!teamTier)

  // Team is the real catalog price ($199/mo), never the stale legacy $99.
  const teamBody = await page.textContent('[data-testid="plan-team"]')
  check('Team shows the real $199/mo catalog price, not the stale $99', teamBody?.includes('$199') ?? false, `body: ${teamBody?.slice(0, 120)}`)
  check('Team never shows the stale legacy $99 price', !(teamBody?.includes('$99') ?? true), `body: ${teamBody?.slice(0, 120)}`)

  // Billing period toggle
  const monthlyBtn = await page.$('[data-testid="period-monthly"]')
  const annualBtn = await page.$('[data-testid="period-annual"]')
  check('has monthly/annual toggle', !!monthlyBtn && !!annualBtn)

  // Click annual — price switches to the annual catalog amount and the /yr suffix.
  if (annualBtn) {
    await annualBtn.click()
    await page.waitForTimeout(300)
    const proBodyAnnual = await page.textContent('[data-testid="plan-pro"]')
    check('annual switches Pro to the annual price and /yr suffix', proBodyAnnual?.includes('$182') && proBodyAnnual?.includes('/yr'), `body: ${proBodyAnnual?.slice(0, 120)}`)
  }
  await monthlyBtn.click()
  await page.waitForTimeout(200)

  // Tax-exclusion, pack table, and plan-vs-pack distinction
  check('paid tiers note tax exclusion', (await page.textContent('[data-testid="plan-pro"]'))?.includes('applicable tax') ?? false)
  const packTable = await page.$('[data-testid="pricing-pack-table"]')
  check('has a credit pack table', !!packTable)
  const packBody = await page.textContent('[data-testid="pricing-packs"]')
  check('pack section explains no rollover / expiry', (packBody?.includes('never roll over') || packBody?.includes('no rollover')) ?? false, `body: ${packBody?.slice(0, 160)}`)

  // Comparison table
  const comparison = await page.$('[data-testid="pricing-features"]')
  check('has comparison table', !!comparison)

  // FAQ
  const faq = await page.$('[data-testid="pricing-faq"]')
  check('has FAQ', !!faq)
  const faqBody = await page.textContent('[data-testid="pricing-faq"]')
  check('FAQ no longer claims manual/no-Stripe billing', !(faqBody?.toLowerCase().includes('no stripe yet') ?? true), `body: ${faqBody?.slice(0, 160)}`)
  await page.screenshot({ path: '/tmp/builderhunt-pricing.png', fullPage: true })

  // ====================================================================
  // /pricing — signed out, request upgrade should prompt sign-in
  // ====================================================================
  console.log('\n🔐 Pricing as signed-out user')
  await signOut(page)
  await page.goto(`${BASE}/pricing`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const proCta = await page.$('[data-testid="pricing-cta-pro"]')
  check('Pro CTA visible when signed out', !!proCta)
  if (proCta) {
    await proCta.click()
    await page.waitForTimeout(1500)
    const msg = await page.textContent('[data-testid="pricing-msg"]')
    check('shows sign-in prompt when signed out', msg?.toLowerCase().includes('sign in') ?? false, `msg: ${msg}`)
  }

  // ====================================================================
  // /api/plans/me as signed-in user
  // ====================================================================
  console.log('\n🔐 Signed in: /api/plans/me')
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  const meRes = await page.evaluate(async () => {
    const r = await fetch('/api/plans/me', { credentials: 'include' })
    return r.json()
  })
  check('/api/plans/me returns plan', !!meRes.plan, `body: ${JSON.stringify(meRes).slice(0, 100)}`)
  check('/api/plans/me returns limits', !!meRes.limits)
  check('/api/plans/me returns pricing', !!meRes.pricing)

  // ====================================================================
  // /api/plans/request-upgrade as user
  //
  // Asserts the legacy self-service path still works — this script only runs against a dev
  // environment with STRIPE_BILLING_ENABLED=false (this repo's own default). Once that flag flips to
  // 'true' (plans/phase-1/30-stripe-billing-platform/tasks.md §10 "Retire legacy billing mutations after
  // canonical cutover"), this same request instead returns 409 with `migrationGuidance: true` and a
  // `checkoutUrl` — see `platform-billing.test.ts`'s `shouldBlockLegacyPlanMutations` and
  // `request-upgrade.test.ts`/`admin/plan-requests/index.test.ts` for that behavior's real coverage.
  // ====================================================================
  console.log('\n🛒 User requests upgrade to team')
  const requestRes = await page.evaluate(async () => {
    const r = await fetch('/api/plans/request-upgrade', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedPlan: 'team', message: 'e2e test request' }),
    })
    return { status: r.status, body: await r.json() }
  })
  check('request upgrade returns 200', requestRes.status === 200, `status: ${requestRes.status}`)
  check('request returns id', !!requestRes.body.id, `body: ${JSON.stringify(requestRes.body)}`)

  // Idempotent: submit again, should return same request
  const requestRes2 = await page.evaluate(async () => {
    const r = await fetch('/api/plans/request-upgrade', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedPlan: 'team' }),
    })
    return r.json()
  })
  check('second request is idempotent', requestRes2.alreadyPending === true, `body: ${JSON.stringify(requestRes2)}`)

  // ====================================================================
  // /admin/users — list & edit
  // ====================================================================
  console.log('\n🔧 /admin/users — admin user management')
  await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="admin-users-page"]', { timeout: 5000 })
  const userRows = await page.$$('[data-testid^="admin-user-row-"]')
  check('users page lists at least 1 user', userRows.length >= 1, `count: ${userRows.length}`)
  await page.screenshot({ path: '/tmp/builderhunt-admin-users.png', fullPage: true })

  // Edit the first user
  if (userRows.length > 0) {
    const editBtn = await page.$('[data-testid="admin-user-edit"]')
    check('edit button visible', !!editBtn)
    if (editBtn) {
      await editBtn.click()
      await page.waitForSelector('[data-testid="admin-user-save"]', { timeout: 3000 })
      await page.selectOption('[data-testid="admin-user-plan-select"]', 'pro')
      // Set ends at 30 days from now
      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      await page.fill('[data-testid="admin-user-ends-at"]', futureDate)
      await page.fill('[data-testid="admin-user-reason"]', 'e2e test')
      await page.click('[data-testid="admin-user-save"]')
      await page.waitForTimeout(1500)
      const success = await page.$('[data-testid="admin-users-success"]')
      check('admin user save shows success', !!success)
    }
  }

  // ====================================================================
  // /admin/plan-requests — list & resolve
  // ====================================================================
  console.log('\n🔧 /admin/plan-requests — admin queue')
  await page.goto(`${BASE}/admin/plan-requests`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="admin-plan-requests-page"]', { timeout: 5000 })
  const requestRows = await page.$$('[data-testid^="plan-request-row-"]')
  check('plan requests page lists at least 1 request', requestRows.length >= 1, `count: ${requestRows.length}`)
  await page.screenshot({ path: '/tmp/builderhunt-admin-plan-requests.png', fullPage: true })

  // Approve the first request
  if (requestRows.length > 0) {
    const approveBtn = await page.$('[data-testid="plan-request-approve"]')
    check('approve button visible', !!approveBtn)
    if (approveBtn) {
      await approveBtn.click()
      await page.waitForTimeout(2000)
      // After approval, pending should be empty or count reduced
      const remaining = await page.$$('[data-testid^="plan-request-row-"]')
      check('approve removes from pending', remaining.length < requestRows.length, `before: ${requestRows.length}, after: ${remaining.length}`)
    }
  }

  // ====================================================================
  // /settings/billing — user view
  // ====================================================================
  console.log('\n🔧 /settings/billing — user billing view')
  await page.goto(`${BASE}/settings/billing`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="billing-settings-page"]', { timeout: 5000 })
  const currentPlan = await page.$('[data-testid="current-plan"]')
  check('billing page shows current plan', !!currentPlan)
  const usage = await page.$('[data-testid="usage-section"]')
  check('billing page shows usage section', !!usage)
  const usageSavedSearches = await page.$('[data-testid="usage-savedSearches"]')
  check('billing page shows saved searches usage', !!usageSavedSearches)
  await page.screenshot({ path: '/tmp/builderhunt-billing-settings.png', fullPage: true })

  // ====================================================================
  // Non-admin gets 403
  // ====================================================================
  console.log('\n🔐 Non-admin gets 403')
  await signOut(page)
  // Create a non-admin user
  await page.goto(`${BASE}/auth/sign-up`, { waitUntil: 'networkidle' })
  const testEmail = `e2e_billing_${Date.now()}@test.com`
  await page.fill('input[type="text"]', 'E2E Billing Test')
  await page.fill('input[type="email"]', testEmail)
  await page.fill('input[type="password"]', 'TestPass1234!')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(2000)
  // Try to access admin endpoints
  const adminRes = await page.evaluate(async () => {
    const r = await fetch('/api/admin/users', { credentials: 'include' })
    return r.status
  })
  check('non-admin gets 403 on /api/admin/users', adminRes === 403, `status: ${adminRes}`)

  await browser.close()

  console.log('\n' + '='.repeat(60))
  console.log(`Total: ${pass + fail} | ✅ ${pass} | ❌ ${fail}`)
  console.log('='.repeat(60))

  writeFileSync('/tmp/builderhunt-pricing-results.txt',
    results.join('\n') + `\n\nTotal: ${pass + fail} | ✅ ${pass} | ❌ ${fail}\n`)

  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
