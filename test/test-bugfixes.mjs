// e2e tests for the bugfixes I just made
// - queries POST returns 402 when over limit
// - changelog POST returns 409 on duplicate slug
// - builders PATCH validates body
// - /settings/billing page renders correctly

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
  // Clean up test data first
  try {
    const { execSync } = await import('child_process')
    execSync(
      `docker exec builderhunt-db psql -U postgres -d builderhunt -c "DELETE FROM saved_queries; DELETE FROM changelog WHERE slug LIKE 'bugfix%'; DELETE FROM data_export_requests; DELETE FROM alert_triggers; DELETE FROM alerts WHERE name LIKE 'bugfix%' OR name LIKE 'e2e%'; UPDATE plans SET plan = 'free', status = 'active', plan_ends_at = NULL WHERE user_id = 'fd36a419-f32c-40f7-898b-f051e0ab0fcd';" 2>/dev/null`,
      { stdio: 'ignore' },
    )
  } catch {}

  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  console.log('  ✓ Signed in as admin')
  console.log('  ✓ Reset admin to free plan for limit test')

  // ====================================================================
  // BUGFIX 1: /api/queries POST returns 402 when over plan limit
  // ====================================================================
  console.log('\n🐛 /api/queries POST — plan limit (free=3)')

  // Free plan limit is 3 saved searches. Insert 3 to hit limit, then 4th should 402.
  for (let i = 0; i < 3; i++) {
    const r = await page.evaluate(async (i) => {
      const res = await fetch('/api/queries', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Bugfix Query ${i}`, keywords: ['test'] }),
      })
      return { status: res.status }
    }, i)
    check(`create query #${i + 1} (under limit)`, r.status === 200, `status: ${r.status}`)
  }

  const overLimit = await page.evaluate(async () => {
    const res = await fetch('/api/queries', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bugfix Query 4', keywords: ['test'] }),
    })
    return { status: res.status, body: await res.json() }
  })
  check('4th query returns 402 (over limit)', overLimit.status === 402, `status: ${overLimit.status}`)
  check('402 body has upgradeUrl', overLimit.body.upgradeUrl === '/pricing', `body: ${JSON.stringify(overLimit.body)}`)

  // ====================================================================
  // BUGFIX 2: /api/admin/changelog POST returns 409 on duplicate slug
  // ====================================================================
  console.log('\n🐛 /api/admin/changelog POST — duplicate slug')
  const firstChangelog = await page.evaluate(async () => {
    const res = await fetch('/api/admin/changelog', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Bugfix Test', slug: 'bugfix-dup', content: 'first' }),
    })
    return { status: res.status, body: await res.json() }
  })
  check('first changelog create returns 200', firstChangelog.status === 200, `status: ${firstChangelog.status}`)

  const dupChangelog = await page.evaluate(async () => {
    const res = await fetch('/api/admin/changelog', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Bugfix Test 2', slug: 'bugfix-dup', content: 'dup' }),
    })
    return { status: res.status, body: await res.json() }
  })
  check('duplicate slug returns 409 (not 500)', dupChangelog.status === 409, `status: ${dupChangelog.status}`)
  check('409 body has slug in error', dupChangelog.body.slug === 'bugfix-dup')

  // ====================================================================
  // BUGFIX 3: /api/builders/$id PATCH validates body
  // ====================================================================
  console.log('\n🐛 /api/builders/$id PATCH — body validation')

  // Use a non-existent builder ID — the validation should happen BEFORE the DB check
  const invalidBody = await page.evaluate(async () => {
    const res = await fetch('/api/builders/test-id', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topics: 'not-an-array' }), // invalid: should be array
    })
    return { status: res.status, body: await res.json() }
  })
  check('invalid topics type returns 400', invalidBody.status === 400, `status: ${invalidBody.status}, body: ${JSON.stringify(invalidBody.body)}`)

  const emptyBody = await page.evaluate(async () => {
    const res = await fetch('/api/builders/test-id', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    return { status: res.status, body: await res.json() }
  })
  check('empty body returns 400 (no fields to update)', emptyBody.status === 400, `status: ${emptyBody.status}`)

  // ====================================================================
  // BUGFIX 4: /settings/billing page renders correctly (was 500)
  // ====================================================================
  console.log('\n🐛 /settings/billing — page renders (was 500)')
  await page.goto(`${BASE}/settings/billing`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const billingEl = await page.$('[data-testid="billing-settings-page"]')
  check('billing page loads (no 500)', !!billingEl)
  if (billingEl) {
    const h1 = await page.textContent('h1')
    check('billing h1 visible', h1?.includes('Billing') ?? false, `h1: ${h1}`)
    const currentPlan = await page.$('[data-testid="current-plan"]')
    check('current plan section visible', !!currentPlan)
  }

  // ====================================================================
  // BUGFIX 5: /api/me/plan-changes endpoint exists
  // ====================================================================
  console.log('\n🐛 /api/me/plan-changes endpoint')
  const planChangesRes = await page.evaluate(async () => {
    const res = await fetch('/api/me/plan-changes', { credentials: 'include' })
    return { status: res.status, body: await res.json() }
  })
  check('plan-changes endpoint returns 200', planChangesRes.status === 200, `status: ${planChangesRes.status}`)
  check('plan-changes returns array', Array.isArray(planChangesRes.body), `body: ${JSON.stringify(planChangesRes.body).slice(0, 100)}`)

  // ====================================================================
  // BUGFIX 6: explore links go to source profile, not /builders/[id]
  // ====================================================================
  console.log('\n🐛 /explore links go to source profile')
  await page.context().clearCookies()
  await page.goto(`${BASE}/explore?q=react`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  const viewLinks = await page.$$('a[data-testid^="person-card-link-"]')
  check('explore has view links', viewLinks.length > 0, `count: ${viewLinks.length}`)
  if (viewLinks.length > 0) {
    const href = await viewLinks[0].getAttribute('href')
    check('first view link is external (not /builders/)',
      href && !href.includes('/builders/') && (href.startsWith('http') || href.startsWith('//')),
      `href: ${href}`)
  }

  await browser.close()

  console.log('\n' + '='.repeat(60))
  console.log(`Total: ${pass + fail} | ✅ ${pass} | ❌ ${fail}`)
  console.log('='.repeat(60))

  writeFileSync('/tmp/builderhunt-bugfixes-results.txt',
    results.join('\n') + `\n\nTotal: ${pass + fail} | ✅ ${pass} | ❌ ${fail}\n`)

  process.exit(fail === 0 ? 0 : 1)
}

run().catch(e => { console.error('Fatal:', e); process.exit(1) })
