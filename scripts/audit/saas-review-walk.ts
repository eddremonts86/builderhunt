/**
 * saas-review-walk.ts — Phase 2 walker for the /saas-review flow.
 *
 * For every role in `SAAS_REVIEW_USERS_JSON` (or the per-role SAAS_REVIEW_*
 * fallback), signs in and visits every route in the route inventory. Captures
 * a desktop screenshot, console errors/warnings, and failed network requests
 * per (role, route). Writes evidence under `docs/ui-audit/evidence/<role>/`.
 *
 * Read-only: does not modify the app. The findings are surfaced into a
 * summary JSON so Phase 3 can score without re-running the walker.
 *
 * Usage:
 *   pnpm dev  # in another terminal
 *   pnpm tsx --env-file-if-exists=.env scripts/audit/saas-review-walk.ts
 *
 * Options (env):
 *   SAAS_REVIEW_BASE_URL     (default http://localhost:3000)
 *   SAAS_REVIEW_ROLES        comma-separated subset of owner,admin,member,platform-admin
 *   SAAS_REVIEW_VIEWPORTS    desktop-light (default) | desktop-dark | both
 *   SAAS_REVIEW_ROUTES_FILE  path to the inventory MD; defaults to docs/ui-audit/route-inventory.md
 *   SAAS_REVIEW_EVIDENCE_DIR path to evidence dir; defaults to docs/ui-audit/evidence
 *
 * Non-goals:
 *   - Mobile capture (375px). Add a second pass if needed.
 *   - State provocation (empty/loading/error/permission). Audit-only.
 *   - State coverage of dynamic params. We use real IDs from the DB.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page, type Browser, type ConsoleMessage, type Request } from 'playwright'

interface TestUser {
  email: string
  password: string
  name: string
}

interface RoleConfig {
  role: 'owner' | 'admin' | 'member' | 'platform-admin'
  user: TestUser
}

const BASE_URL = (process.env.SAAS_REVIEW_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const ROLES_FILTER = (process.env.SAAS_REVIEW_ROLES ?? 'owner,admin,member,platform-admin')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
// Viewport selector. Default `desktop-light`. `both` runs the walker twice
// per route, once at 1440×900 (light) and once at 1440×900 with `.dark` on
// `<html>`. Other valid values: `desktop-dark`, `mobile-375`, `tablet-768`.
// `mobile-375` + `tablet-768` use device emulation; they don't capture dark
// automatically.
const VIEWPORTS = (process.env.SAAS_REVIEW_VIEWPORTS ?? 'desktop-light')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as Array<
  'desktop-light' | 'desktop-dark' | 'both' | 'mobile-375' | 'tablet-768'
>
const ROUTES_FILE = process.env.SAAS_REVIEW_ROUTES_FILE ?? 'docs/ui-audit/route-inventory.md'
const EVIDENCE_DIR = process.env.SAAS_REVIEW_EVIDENCE_DIR ?? 'docs/ui-audit/evidence'

// Console / network errors whose stack starts in one of these substrings are
// walker artefacts, not product defects. The walker closes the browser context
// ~5 s post-`domcontentloaded`, aborting any in-flight TanStack-Start serverFn.
// A real user never hits that race. Filter them so they don't pollute
// `walk-summary.json`.
const WALKER_ARTEFACT_SUBSTRINGS = [
  '@tanstack/start-client-core',
  'serverFnFetcher',
]

function isWalkerArtefact(message: string): boolean {
  return WALKER_ARTEFACT_SUBSTRINGS.some((s) => message.includes(s))
}

function readUser(role: 'owner' | 'admin' | 'member' | 'platform-admin'): TestUser {
  if (role === 'platform-admin') {
    return {
      email: process.env.DEFAULT_ADMIN_EMAIL ?? 'edd_admin@local.com',
      password: process.env.DEFAULT_ADMIN_PASSWORD ?? 'Passw0rd!234',
      name: 'Platform admin',
    }
  }
  return {
    email:
      process.env[`SAAS_REVIEW_${role.toUpperCase()}_EMAIL`] ?? `saas-review-${role}@test.local`,
    password:
      process.env[`SAAS_REVIEW_${role.toUpperCase()}_PASSWORD`] ?? `SaasReview!${role[0].toUpperCase()}${role.slice(1)}#1`,
    name: role,
  }
}

function getRoleConfig(): RoleConfig[] {
  return ROLES_FILTER.map((role) => ({
    role: role as RoleConfig['role'],
    user: readUser(role as RoleConfig['role']),
  }))
}

/**
 * Parse the route inventory markdown into a flat list of (route, file) pairs.
 * Skips tables that are clearly not UI screens (sitemaps, legal) and any row
 * that doesn't include a `src/routes/...` file reference.
 */
async function loadRoutes(): Promise<Array<{ route: string; file: string }>> {
  const text = await readFile(join(process.cwd(), ROUTES_FILE), 'utf8')
  const rows: Array<{ route: string; file: string }> = []

  // Each row in the inventory is `| /route | src/routes/... | ... |`. Match
  // the first two columns.
  const rowRe = /^\|\s*(`?)([^|`]+)\1\s*\|\s*(`?)([^|`]+)\3\s*\|/gm
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(text)) !== null) {
    const route = m[2].trim()
    const file = m[4].trim()
    if (!route.startsWith('/')) continue
    if (!file.startsWith('src/routes/')) continue
    if (file.endsWith('.ts')) continue // API routes
    rows.push({ route, file })
  }
  return rows
}

async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto(`${BASE_URL}/auth/sign-in`, { waitUntil: 'domcontentloaded' })

  // React hydration in the dev server is slow (Vite is rebundling on first
  // hit). If we click before hydration completes, the browser does the
  // native form GET to /auth/sign-in?email=…&password=… instead of running
  // the React onSubmit. Wait for the form to be interactive: a controlled
  // input that round-trips through React state proves the listeners are
  // attached. A 1s settle is a belt-and-braces second guard.
  await page.locator('input[type="email"]').first().waitFor({ state: 'visible' })
  await page.locator('input[type="password"]').first().waitFor({ state: 'visible' })
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined)
  await page.waitForTimeout(1_000)

  await page.locator('input[type="email"]').first().fill(user.email)
  await page.locator('input[type="password"]').first().fill(user.password)

  // Capture all API responses to debug sign-in failures. The walker only
  // needs /api/auth/* in the error message; logging everything helps when
  // a middleware or proxy is the actual cause.
  const authResponses: Array<{ status: number; body: string; url: string }> = []
  const onAuthResponse = async (r: import('playwright').Response) => {
    if (r.url().startsWith(BASE_URL) && r.url().includes('/api/')) {
      const text = await r.text().catch(() => '<no body>')
      authResponses.push({ status: r.status(), body: text.slice(0, 300), url: r.url() })
    }
  }
  page.on('response', onAuthResponse)

  // Capture page errors so we can see what signInEmail threw.
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`)
  })

  // Prefer the form's requestSubmit() over a button click — it fires the
  // submit event the way React expects, even if hydration timing is tight.
  const form = page.locator('form').first()
  await form.evaluate((f) => (f as HTMLFormElement).requestSubmit())

  try {
    await page.waitForURL(
      (u) => !u.toString().replace(/\?$/, '').includes('/auth/sign-in'),
      { timeout: 25_000, waitUntil: 'load' },
    )
  } catch {
    const errorText = await page
      .locator('[role="alert"], .text-bh-danger')
      .first()
      .textContent()
      .catch(() => null)
    const authDetail = authResponses
      .filter((r) => r.url.includes('/api/auth'))
      .map((r) => `${r.status} ${r.url} ${r.body}`)
      .join(' | ')
    throw new Error(
      `sign-in did not navigate away from /auth/sign-in within 25s${
        errorText ? ` — UI error: ${errorText.trim()}` : ''
      }${authDetail ? ` — auth API: ${authDetail}` : ''}${
        pageErrors.length ? ` — page errors: ${pageErrors.slice(0, 3).join(' | ')}` : ''
      }`,
    )
  } finally {
    page.off('response', onAuthResponse)
  }
}

interface RouteFinding {
  route: string
  file: string
  status: number | null
  finalUrl: string
  consoleErrors: string[]
  consoleWarnings: string[]
  failedRequests: string[]
  screenshotLight?: string
  screenshotDark?: string
  redirected: boolean
  notes: string[]
}

async function visitRoute(
  page: Page,
  route: string,
  evidenceDir: string,
  captureDark: boolean,
): Promise<RouteFinding> {
  const consoleErrors: string[] = []
  const consoleWarnings: string[] = []
  const failedRequests: string[] = []
  const notes: string[] = []

  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      // Drop walker artefacts (saas-review F7 + fix-ui-ux C14).
      if (!isWalkerArtefact(text)) consoleErrors.push(text)
    }
    else if (msg.type() === 'warning') consoleWarnings.push(msg.text())
  }
  const onRequest = (req: Request) => {
    // We can't intercept failures here, only log; failures surface as 4xx/5xx
    // responses, captured below.
  }
  const onResponse = async (res: import('playwright').Response) => {
    if (res.status() >= 400 && res.url().startsWith(BASE_URL)) {
      // Skip walker artefacts: serverFn aborts land as net::ERR_FAILED with no URL.
      const failedLine = `${res.status()} ${res.url()}`
      if (!isWalkerArtefact(failedLine)) failedRequests.push(failedLine)
    }
  }

  page.on('console', onConsole)
  page.on('request', onRequest)
  page.on('response', onResponse)

  let status: number | null = null
  let finalUrl = ''
  let redirected = false

  try {
    const response = await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    status = response?.status() ?? null
    finalUrl = page.url()
    redirected = finalUrl.replace(/\/$/, '') !== `${BASE_URL}${route}`.replace(/\/$/, '')

    // Give React a moment to hydrate, then settle. Short and bounded.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
  } catch (err) {
    notes.push(`navigation failed: ${(err as Error).message}`)
  }

  // Light screenshot
  const slug = route.replace(/^\//, '').replace(/\//g, '_').replace(/[^a-zA-Z0-9_-]/g, '') || 'root'
  const lightPath = join(evidenceDir, `${slug}.light.png`)
  try {
    await page.screenshot({ path: lightPath, fullPage: false })
  } catch (err) {
    notes.push(`screenshot (light) failed: ${(err as Error).message}`)
  }

  // Optional dark capture
  let darkPath: string | undefined
  if (captureDark) {
    try {
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.waitForTimeout(200)
      darkPath = join(evidenceDir, `${slug}.dark.png`)
      await page.screenshot({ path: darkPath, fullPage: false })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
    } catch (err) {
      notes.push(`screenshot (dark) failed: ${(err as Error).message}`)
    }
  }

  page.off('console', onConsole)
  page.off('request', onRequest)
  page.off('response', onResponse)

  return {
    route,
    file: '',
    status,
    finalUrl,
    consoleErrors,
    consoleWarnings,
    failedRequests,
    screenshotLight: lightPath,
    screenshotDark: darkPath,
    redirected,
    notes,
  }
}

interface ViewportSpec {
  width: number
  height: number
  // True when the viewport should additionally capture `.dark.png`.
  dark: boolean
  label: string
}

function expandViewports(): ViewportSpec[] {
  const out: ViewportSpec[] = []
  for (const v of VIEWPORTS) {
    if (v === 'desktop-light') out.push({ width: 1440, height: 900, dark: false, label: 'desktop-light' })
    else if (v === 'desktop-dark') out.push({ width: 1440, height: 900, dark: true, label: 'desktop-dark' })
    else if (v === 'both') {
      out.push({ width: 1440, height: 900, dark: false, label: 'desktop-light' })
      out.push({ width: 1440, height: 900, dark: true, label: 'desktop-dark' })
    }
    else if (v === 'mobile-375') out.push({ width: 375, height: 812, dark: false, label: 'mobile-375' })
    else if (v === 'tablet-768') out.push({ width: 768, height: 1024, dark: false, label: 'tablet-768' })
    else throw new Error(`Unknown SAAS_REVIEW_VIEWPORTS value: ${v}`)
  }
  return out.length > 0 ? out : [{ width: 1440, height: 900, dark: false, label: 'desktop-light' }]
}

async function main() {
  const roles = getRoleConfig()
  const routes = await loadRoutes()
  const browser: Browser = await chromium.launch({ headless: true })
  const viewports = expandViewports()

  console.log(`🛰  saas-review walk — ${roles.length} role(s) × ${routes.length} routes × ${viewports.length} viewport(s)`)
  console.log(`  base: ${BASE_URL}`)
  console.log(`  evidence: ${EVIDENCE_DIR}/<role>/<viewport>/`)
  console.log(`  viewports: ${viewports.map((v) => v.label).join('+')}`)

  const summary: Record<string, RouteFinding[]> = {}

  for (const { role, user } of roles) {
    for (const vp of viewports) {
      const roleDir = join(process.cwd(), EVIDENCE_DIR, role, vp.label)
      await mkdir(roleDir, { recursive: true })

      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
      })
      const page = await ctx.newPage()

      console.log(`\n▸ ${role.padEnd(14)} ${user.email}  [${vp.label}]`)

      try {
        await signIn(page, user)
        console.log(`  ✓ signed in`)
      } catch (err) {
        console.log(`  ✗ sign-in failed: ${(err as Error).message}`)
        await ctx.close()
        continue
      }

      const roleFindings: Record<string, RouteFinding> = {}
      // Each (route) becomes a single finding per role×viewport combo;
      // if the same role runs multiple viewports, findings accumulate
      // under the role with viewport-suffixed route keys.
      let n = 0
      for (const { route, file } of routes) {
        n += 1
        const finding = await visitRoute(page, route, roleDir, vp.dark)
        finding.file = file
        const key = vp.label === 'desktop-light' ? route : `${route}@${vp.label}`
        roleFindings[key] = finding

        const status = finding.status === null ? 'XXX' : String(finding.status)
        const flags = [
          finding.consoleErrors.length > 0 ? `E${finding.consoleErrors.length}` : null,
          finding.failedRequests.length > 0 ? `N${finding.failedRequests.length}` : null,
          finding.redirected ? 'R' : null,
        ]
          .filter(Boolean)
          .join(' ')
        const flagStr = flags ? `  [${flags}]` : ''
        process.stdout.write(`  [${String(n).padStart(2)}/${routes.length}] ${route.padEnd(40)} ${status}${flagStr}\n`)
      }

      // Merge per-viewport findings into the role bucket.
      const existing = summary[role] ?? []
      summary[role] = existing.concat(Object.values(roleFindings))

      await ctx.close()
    }
  }

  await browser.close()

  const summaryPath = join(process.cwd(), EVIDENCE_DIR, 'walk-summary.json')
  await writeFile(summaryPath, JSON.stringify(summary, null, 2))
  console.log(`\n📝 Summary written: ${summaryPath}`)

  // Quick aggregate for the user
  let total = 0
  let errors = 0
  let redirects = 0
  let failed = 0
  for (const findings of Object.values(summary)) {
    for (const f of findings) {
      total += 1
      if (f.consoleErrors.length > 0) errors += 1
      if (f.redirected) redirects += 1
      if (f.status !== null && f.status >= 400) failed += 1
    }
  }
  console.log(`\n  routes walked:  ${total}`)
  console.log(`  console errors: ${errors} routes affected`)
  console.log(`  http failures:  ${failed} routes affected`)
  console.log(`  redirected:     ${redirects} routes (often an auth gate, not a bug)`)
}

main().catch((err) => {
  console.error('❌  saas-review-walk failed:', err)
  process.exit(1)
})
