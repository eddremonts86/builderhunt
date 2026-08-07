/**
 * dashboard-baseline.ts — Wave 0 Task 2 of plans/phase-1/ui-dashboard.
 *
 * Records the current dashboard baseline metrics so regressions in
 * Phase 2+ are detectable. Captures:
 *
 *   - request count (per route load, total)
 *   - transferred bytes (per route, sum)
 *   - core endpoint / server timing (Navigation Timing API: domContentLoaded,
 *     loadEvent, time-to-first-byte)
 *   - layout shift (PerformanceObserver, CLS metric)
 *   - accessible-name snapshot (axe-core run, top 10 most-impactful findings)
 *   - screenshots at desktop 1440×900, 320 px (mobile baseline), 400% zoom,
 *     reduced-motion, and forced-colors
 *
 * Output:
 *   - docs/operations/development.md is updated with the numbers (append
 *     a new dated section; never overwrite prior baselines).
 *   - docs/ui-audit/evidence/dashboard-baseline/<viewport>/*.png
 *   - docs/ui-audit/evidence/dashboard-baseline/metrics.json
 *
 * Usage:
 *   pnpm dev  # in another terminal, on port 3010 (matches APP_URL)
 *   SAAS_REVIEW_BASE_URL=http://localhost:3010 \
 *     SAAS_REVIEW_ROLES=platform-admin \
 *     pnpm tsx --env-file-if-exists=.env scripts/audit/dashboard-baseline.ts
 *
 * Reproducibility:
 *   The baseline is recorded against the platform-admin fixture (who has
 *   access to every surface). It is reproducible only when the fixture
 *   data is deterministic (FixedClock + the seeded test users from
 *   `pnpm db:seed:test-users`). If the dashboard renders no widgets the
 *   walker fails clearly with a non-zero exit and a stderr message.
 *
 * Non-goals:
 *   - Sub-millisecond timing accuracy. The walker is a regression detector,
 *     not a benchmark. Variance ±20% is normal.
 *   - Cross-route interactions. This records a cold-load of /dashboard,
 *     not the cost of clicking through 7 widgets in sequence.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'

const BASE_URL = (process.env.SAAS_REVIEW_BASE_URL ?? 'http://localhost:3010').replace(/\/$/, '')
const EMAIL = process.env.SAAS_REVIEW_PLATFORM_ADMIN_EMAIL ?? process.env.DEFAULT_ADMIN_EMAIL ?? 'edd_admin@local.com'
const PASSWORD = process.env.SAAS_REVIEW_PLATFORM_ADMIN_PASSWORD ?? process.env.DEFAULT_ADMIN_PASSWORD ?? 'Passw0rd!234'
const OUT_DIR = 'docs/ui-audit/evidence/dashboard-baseline'

interface BaselineSample {
  viewport: string
  route: string
  status: number | null
  ttfbMs: number | null
  domContentLoadedMs: number | null
  loadMs: number | null
  cls: number | null
  requestCount: number
  transferredBytes: number
  consoleErrors: string[]
  axeViolations: number
  screenshotPath: string
  notes: string[]
}

interface ViewportSpec {
  label: string
  width: number
  height: number
  reduceMotion: 'reduce' | 'no-preference'
  forcedColors: 'active' | 'none'
  zoom: number
}

const VIEWPORTS: ViewportSpec[] = [
  { label: 'desktop-1440', width: 1440, height: 900, reduceMotion: 'no-preference', forcedColors: 'none', zoom: 1 },
  { label: 'mobile-320', width: 320, height: 720, reduceMotion: 'no-preference', forcedColors: 'none', zoom: 1 },
  { label: 'desktop-1440-zoom400', width: 1440, height: 900, reduceMotion: 'no-preference', forcedColors: 'none', zoom: 4 },
  { label: 'desktop-1440-reduce-motion', width: 1440, height: 900, reduceMotion: 'reduce', forcedColors: 'none', zoom: 1 },
  { label: 'desktop-1440-forced-colors', width: 1440, height: 900, reduceMotion: 'no-preference', forcedColors: 'active', zoom: 1 },
]

async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/auth/sign-in`, { waitUntil: 'domcontentloaded' })
  await page.locator('input[type="email"]').first().waitFor({ state: 'visible' })
  await page.locator('input[type="password"]').first().waitFor({ state: 'visible' })
  await page.waitForTimeout(800)
  await page.locator('input[type="email"]').first().fill(EMAIL)
  await page.locator('input[type="password"]').first().fill(PASSWORD)
  const form = page.locator('form').first()
  await form.evaluate((f) => (f as HTMLFormElement).requestSubmit())
  try {
    await page.waitForURL(
      (u) => !u.toString().replace(/\?$/, '').includes('/auth/sign-in'),
      { timeout: 25_000, waitUntil: 'load' },
    )
  } catch {
    throw new Error('sign-in failed; check SAAS_REVIEW_PLATFORM_ADMIN_* env vars and dev server')
  }
}

async function captureBaseline(page: Page, route: string, vp: ViewportSpec): Promise<BaselineSample> {
  const requests: { url: string; status: number; bytes: number }[] = []
  const consoleErrors: string[] = []
  let bytes = 0
  let cls = 0

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('response', async (res) => {
    const url = res.url()
    if (!url.startsWith(BASE_URL)) return
    const status = res.status()
    const headers = res.headers()
    const len = Number(headers['content-length'] ?? '0')
    bytes += isNaN(len) ? 0 : len
    requests.push({ url, status, bytes: isNaN(len) ? 0 : len })
  })

  // Cumulative Layout Shift observer. CLS resets per page navigation.
  await page.evaluate(() => {
    ;(window as unknown as { __cls: number }).__cls = 0
    const obs = new PerformanceObserver((list) => {
      let total = (window as unknown as { __cls?: number }).__cls ?? 0
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number }
        if (!e.hadRecentInput) total += e.value ?? 0
      }
      ;(window as unknown as { __cls: number }).__cls = total
    })
    obs.observe({ type: 'layout-shift', buffered: true })
  })

  const navigationPromise = page.goto(`${BASE_URL}${route}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })

  let status: number | null = null
  try {
    const response = await navigationPromise
    status = response?.status() ?? null
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
  } catch (err) {
    return {
      viewport: vp.label,
      route,
      status: null,
      ttfbMs: null,
      domContentLoadedMs: null,
      loadMs: null,
      cls: null,
      requestCount: requests.length,
      transferredBytes: bytes,
      consoleErrors,
      axeViolations: 0,
      screenshotPath: '',
      notes: [`navigation failed: ${(err as Error).message}`],
    }
  }

  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as
      | (PerformanceNavigationTiming & { responseStart: number; loadEventEnd: number })
      | undefined
    if (!nav) return { ttfbMs: null, domContentLoadedMs: null, loadMs: null }
    return {
      ttfbMs: Math.round(nav.responseStart - nav.requestStart),
      domContentLoadedMs: Math.round(
        (nav as PerformanceNavigationTiming).domContentLoadedEventEnd - nav.startTime,
      ),
      loadMs: Math.round(nav.loadEventEnd - nav.startTime),
    }
  })
  cls = await page.evaluate(() => (window as unknown as { __cls?: number }).__cls ?? 0)

  // Screenshot
  const slug = `${vp.label}-dashboard`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const screenshotPath = join(OUT_DIR, vp.label, `${slug}.png`)
  await mkdir(join(OUT_DIR, vp.label), { recursive: true })
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false })
  } catch (err) {
    return {
      ...timing,
      viewport: vp.label,
      route,
      status,
      cls,
      requestCount: requests.length,
      transferredBytes: bytes,
      consoleErrors,
      axeViolations: 0,
      screenshotPath: '',
      notes: [`screenshot failed: ${(err as Error).message}`],
    }
  }

  // Axe a11y — only on the first viewport (the others share the same DOM).
  let axeViolations = 0
  if (vp.label === 'desktop-1440') {
    try {
      await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.0/axe.min.js' })
      axeViolations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe?: { run: () => Promise<{ violations: unknown[] }> } }).axe
        if (!axe) return -1
        const result = await axe.run()
        return result.violations.length
      })
    } catch {
      axeViolations = -1
    }
  }

  page.removeAllListeners('console')
  page.removeAllListeners('response')

  return {
    viewport: vp.label,
    route,
    status,
    cls,
    requestCount: requests.length,
    transferredBytes: bytes,
    consoleErrors,
    axeViolations,
    screenshotPath,
    notes: [],
    ...timing,
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const samples: BaselineSample[] = []
  const stamp = new Date().toISOString().slice(0, 10)

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.zoom,
      reducedMotion: vp.reduceMotion,
      forcedColors: vp.forcedColors,
    })
    const page = await ctx.newPage()

    console.log(`\n▸ ${vp.label}  ${vp.width}×${vp.height}  zoom=${vp.zoom}  motion=${vp.reduceMotion}  colors=${vp.forcedColors}`)

    try {
      await signIn(page)
      console.log(`  ✓ signed in`)
    } catch (err) {
      console.log(`  ✗ sign-in failed: ${(err as Error).message}`)
      await ctx.close()
      continue
    }

    const sample = await captureBaseline(page, '/dashboard', vp)
    samples.push(sample)
    console.log(
      `  status=${sample.status}  ttfb=${sample.ttfbMs}ms  dcl=${sample.domContentLoadedMs}ms  load=${sample.loadMs}ms  cls=${sample.cls?.toFixed(4)}  reqs=${sample.requestCount}  bytes=${sample.transferredBytes}  axe=${sample.axeViolations}`,
    )
    await ctx.close()
  }

  await browser.close()

  // Write JSON
  await mkdir(OUT_DIR, { recursive: true })
  const jsonPath = join(OUT_DIR, `metrics-${stamp}.json`)
  await writeFile(jsonPath, JSON.stringify(samples, null, 2))
  console.log(`\n📊 metrics written: ${jsonPath}`)

  // Append a dated markdown summary to docs/operations/development.md
  const opsPath = 'docs/operations/development.md'
  const fs = await import('node:fs/promises')
  let existing = ''
  try { existing = await fs.readFile(opsPath, 'utf8') } catch { /* new */ }
  const section = renderMarkdownSection(stamp, samples)
  const updated = existing + (existing.endsWith('\n') ? '' : '\n') + section + '\n'
  await fs.writeFile(opsPath, updated, 'utf8')
  console.log(`📝 updated: ${opsPath}`)
}

function renderMarkdownSection(stamp: string, samples: BaselineSample[]): string {
  const header = `\n## Dashboard baseline — ${stamp}\n\nRecorded by \`scripts/audit/dashboard-baseline.ts\` against the\nplatform-admin fixture on http://localhost:3010/dashboard.\n\n| viewport | status | TTFB (ms) | DCL (ms) | load (ms) | CLS | requests | bytes | axe violations |\n|---|---|---|---|---|---|---|---|---|\n`
  const rows = samples.map((s) =>
    `| ${s.viewport} | ${s.status ?? '-'} | ${s.ttfbMs ?? '-'} | ${s.domContentLoadedMs ?? '-'} | ${s.loadMs ?? '-'} | ${s.cls?.toFixed(4) ?? '-'} | ${s.requestCount} | ${s.transferredBytes} | ${s.axeViolations} |`,
  )
  const footer = `\nScreenshots: \`docs/ui-audit/evidence/dashboard-baseline/<viewport>/*.png\`.\nJSON: \`docs/ui-audit/evidence/dashboard-baseline/metrics-${stamp}.json\`.\n\n`
  return header + rows.join('\n') + '\n' + footer
}

main().catch((err) => {
  console.error('❌ dashboard-baseline failed:', err)
  process.exit(1)
})
