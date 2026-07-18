// e2e test for legal-and-compliance plan
// Run: node test-legal-and-compliance.mjs

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
  // Clean up test data before running so the 24h throttle doesn't make
  // us flaky. The data export endpoint enforces 1 export per 24h per user.
  try {
    const { execSync } = await import('child_process')
    execSync('docker exec builderhunt-db psql -U postgres -d builderhunt -c "DELETE FROM data_export_requests;" 2>/dev/null', { stdio: 'ignore' })
  } catch {
    // docker not available — proceed anyway, test may flake on re-runs
  }

  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  // ====================================================================
  // PUBLIC: legal pages
  // ====================================================================

  // ====================================================================
  // PUBLIC: legal pages
  // ====================================================================
  console.log('\n📋 /legal/terms — Terms of Service')
  await page.goto(`${BASE}/legal/terms`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="legal-terms"]', { timeout: 5000 })
  const termsH1 = await page.textContent('h1')
  check('terms h1 visible', termsH1?.includes('Terms of Service'), `h1: ${termsH1}`)
  const termsBody = await page.textContent('[data-testid="legal-terms"]')
  check('terms includes acceptance section', termsBody?.includes('Acceptance') ?? false)
  check('terms includes governing law', (termsBody?.includes('Governing law') || termsBody?.includes('governed')) ?? false)
  await page.screenshot({ path: '/tmp/builderhunt-legal-terms.png', fullPage: true })

  console.log('\n📋 /legal/privacy — Privacy Policy')
  await page.goto(`${BASE}/legal/privacy`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="legal-privacy"]', { timeout: 5000 })
  const privacyH1 = await page.textContent('h1')
  check('privacy h1 visible', privacyH1?.includes('Privacy Policy'), `h1: ${privacyH1}`)
  const privacyBody = await page.textContent('[data-testid="legal-privacy"]')
  check('privacy mentions GDPR', privacyBody?.includes('GDPR') ?? false)
  check('privacy mentions CCPA', privacyBody?.includes('CCPA') ?? false)
  check('privacy has subprocessors', privacyBody?.includes('Subprocessor') ?? false)
  await page.screenshot({ path: '/tmp/builderhunt-legal-privacy.png', fullPage: true })

  console.log('\n📋 /legal/cookies — Cookie Policy')
  await page.goto(`${BASE}/legal/cookies`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="legal-cookies"]', { timeout: 5000 })
  const cookiesBody = await page.textContent('[data-testid="legal-cookies"]')
  check('cookies lists bh_session', cookiesBody?.includes('bh_session') ?? false)
  check('cookies lists bh_cookie_consent', cookiesBody?.includes('bh_cookie_consent') ?? false)
  const cookieTable = await page.$('[data-testid="cookie-row-bh_session"]')
  check('cookie table has bh_session row', !!cookieTable)
  await page.screenshot({ path: '/tmp/builderhunt-legal-cookies.png', fullPage: true })

  console.log('\n📋 /legal/imprint — Imprint')
  await page.goto(`${BASE}/legal/imprint`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="legal-imprint"]', { timeout: 5000 })
  const imprintCard = await page.$('[data-testid="imprint-card"]')
  check('imprint has entity card', !!imprintCard)
  const imprintBody = await page.textContent('[data-testid="legal-imprint"]')
  check('imprint lists DMCA contact', imprintBody?.includes('dmca@builderhunt.dev') ?? false)
  check('imprint lists privacy contact', imprintBody?.includes('privacy@builderhunt.dev') ?? false)

  // ====================================================================
  // PUBLIC: cookie banner
  // ====================================================================
  console.log('\n🍪 Cookie banner on first visit')
  // Clear localStorage to simulate first visit
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.removeItem('bh_cookie_consent'))
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const banner = await page.$('[data-testid="cookie-banner"]')
  check('cookie banner appears on first visit', !!banner)
  const acceptAllBtn = await page.$('[data-testid="cookie-banner-accept-all"]')
  check('cookie banner has accept all button', !!acceptAllBtn)
  const essentialBtn = await page.$('[data-testid="cookie-banner-essential"]')
  check('cookie banner has essential button', !!essentialBtn)
  const customizeBtn = await page.$('[data-testid="cookie-banner-customize-btn"]')
  check('cookie banner has customize button', !!customizeBtn)
  await page.screenshot({ path: '/tmp/builderhunt-cookie-banner.png', fullPage: true })

  // Test customize flow
  if (customizeBtn) {
    await customizeBtn.click()
    await page.waitForSelector('[data-testid="cookie-banner-customize"]', { timeout: 3000 })
    const functionalCb = await page.$('[data-testid="cookie-banner-functional"]')
    check('customize shows functional checkbox', !!functionalCb)
  }

  // Click accept all
  await page.click('[data-testid="cookie-banner-accept-all"]')
  await page.waitForTimeout(500)
  const banner2 = await page.$('[data-testid="cookie-banner"]')
  check('cookie banner gone after accept', !banner2)
  const consentStored = await page.evaluate(() => window.localStorage.getItem('bh_cookie_consent'))
  check('consent stored in localStorage', !!consentStored && consentStored.includes('"essential":true'))

  // Reload — banner should NOT reappear
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const banner3 = await page.$('[data-testid="cookie-banner"]')
  check('cookie banner does not reappear on reload', !banner3)

  // ====================================================================
  // PUBLIC: footer legal links
  // ====================================================================
  console.log('\n📋 Footer legal links')
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  check('footer has terms link', !!(await page.$('[data-testid="footer-terms"]')))
  check('footer has privacy link', !!(await page.$('[data-testid="footer-privacy"]')))
  check('footer has cookies link', !!(await page.$('[data-testid="footer-cookies"]')))
  check('footer has imprint link', !!(await page.$('[data-testid="footer-imprint"]')))
  check('footer has do-not-sell link', !!(await page.$('[data-testid="footer-do-not-sell"]')))

  // ====================================================================
  // SIGN IN as admin
  // ====================================================================
  console.log('\n🔐 Signing in as admin')
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  check('admin sign in succeeded', page.url().includes('/dashboard') || page.url().includes('/admin'))

  // TOS modal may or may not appear depending on whether admin already accepted v1.0
  // To make it appear, we'd need to delete the consent record. Skip strict assertion.

  // ====================================================================
  // /api/consent — accept TOS
  // ====================================================================
  console.log('\n🔐 /api/consent — record consent')
  const consentStatus = await page.evaluate(async () => {
    const r = await fetch('/api/consent', { credentials: 'include' })
    return r.json()
  })
  check('consent API returns required versions',
    !!consentStatus.required && consentStatus.required.tos === 'v1.0',
    `required: ${JSON.stringify(consentStatus.required)}`)

  // ====================================================================
  // Privacy settings page
  // ====================================================================
  console.log('\n🔧 /settings/privacy — privacy & data UI')
  await page.goto(`${BASE}/settings/privacy`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="privacy-settings-page"]', { timeout: 5000 })
  check('privacy settings page loads', true)
  const exportSection = await page.$('[data-testid="export-section"]')
  check('has export section', !!exportSection)
  const deleteSection = await page.$('[data-testid="delete-section"]')
  check('has delete section', !!deleteSection)
  const requestExportBtn = await page.$('[data-testid="request-export-btn"]')
  check('has request export button', !!requestExportBtn)
  await page.screenshot({ path: '/tmp/builderhunt-privacy-settings.png', fullPage: true })

  // ====================================================================
  // /api/me/data-export — request export
  // ====================================================================
  console.log('\n🔧 /api/me/data-export — request data export')
  const exportRes = await page.evaluate(async () => {
    const r = await fetch('/api/me/data-export', { method: 'POST', credentials: 'include' })
    return { status: r.status, body: await r.json() }
  })
  check('export request returns 200', exportRes.status === 200, `status: ${exportRes.status}`)
  check('export returns id', !!exportRes.body.id, `body: ${JSON.stringify(exportRes.body)}`)

  if (exportRes.body.id) {
    // Fetch the export to verify it has the data
    const exportData = await page.evaluate(async (id) => {
      const r = await fetch(`/api/me/data-export/${id}`, { credentials: 'include' })
      return { status: r.status, body: await r.json() }
    }, exportRes.body.id)
    check('export detail returns 200', exportData.status === 200)
    check('export status is ready', exportData.body.status === 'ready')
    check('export has user data', !!exportData.body.payload?.user, 'no user in payload')
    check('export has exportedAt', !!exportData.body.payload?.exportedAt)
  }

  // ====================================================================
  // /api/me/delete-account — schedule deletion
  // ====================================================================
  console.log('\n🔧 /api/me/delete-account — schedule deletion')
  const deletionRes = await page.evaluate(async () => {
    const r = await fetch('/api/me/delete-account', { method: 'POST', credentials: 'include' })
    return { status: r.status, body: await r.json() }
  })
  check('deletion request returns 200', deletionRes.status === 200, `status: ${deletionRes.status}`)
  check('deletion returns gracePeriodEndsAt', !!deletionRes.body.gracePeriodEndsAt)

  // Verify pending deletion shows in UI
  await page.goto(`${BASE}/settings/privacy`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const warning = await page.$('[data-testid="deletion-warning"]')
  check('deletion warning visible in UI', !!warning)
  const cancelBtn = await page.$('[data-testid="cancel-deletion-btn"]')
  check('cancel deletion button visible', !!cancelBtn)
  await page.screenshot({ path: '/tmp/builderhunt-deletion-pending.png', fullPage: true })

  // Cancel deletion (click outside the TOS modal if present)
  if (cancelBtn) {
    try {
      const tosModal = await page.$('[data-testid="tos-modal"]')
      if (tosModal) {
        await page.click('[data-testid="tos-modal-accept"]')
        await page.waitForTimeout(1000)
      }
      await cancelBtn.click({ timeout: 5000 })
      await page.waitForTimeout(1500)
      const warning2 = await page.$('[data-testid="deletion-warning"]')
      check('deletion warning gone after cancel', !warning2)
    } catch (e) {
      check('deletion warning gone after cancel', false, String(e).slice(0, 80))
    }
  }

  // ====================================================================
  // Non-admin access: anyone can view legal pages (public)
  // ====================================================================
  console.log('\n🔐 Legal pages are public')
  await page.context().clearCookies()
  await page.goto(`${BASE}/legal/terms`, { waitUntil: 'networkidle' })
  check('terms page accessible while signed out', page.url().includes('/legal/terms'))

  await browser.close()

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log(`Total: ${pass + fail} | ✅ ${pass} | ❌ ${fail}`)
  console.log('='.repeat(60))

  writeFileSync('/tmp/builderhunt-legal-results.txt',
    results.join('\n') + `\n\nTotal: ${pass + fail} | ✅ ${pass} | ❌ ${fail}\n`)

  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
