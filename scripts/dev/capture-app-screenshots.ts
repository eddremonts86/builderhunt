/**
 * capture-app-screenshots.ts — real screenshots of the running app, for the blog.
 *
 * Marketing content that shows a mockup instead of the product is a small lie
 * that ages badly: the mockup keeps promising a UI that shipped differently.
 * This drives a real browser against a real dev server, signs in as the seeded
 * admin, and writes WebP files into `public/images/blog/`, so re-running it
 * after a redesign refreshes every post at once.
 *
 * Usage:
 *   pnpm dev                     # in another terminal (any port)
 *   pnpm content:screenshots     # APP_URL/PORT from .env, or SHOTS_BASE_URL=…
 *
 * Options (env):
 *   SHOTS_BASE_URL   base URL to shoot (default: APP_URL, else http://localhost:3000)
 *   SHOTS_ONLY       comma-separated shot names, to re-take just those
 *   SHOTS_KEEP_PNG   keep the intermediate PNG next to the WebP
 *
 * Not part of CI: it needs a running server with a seeded admin, and the images
 * it produces are committed artefacts reviewed by eye.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import sharp from 'sharp'
import { chromium, type Page } from 'playwright'

const BASE_URL = (process.env.SHOTS_BASE_URL ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL = process.env.DEFAULT_ADMIN_EMAIL ?? 'edd_admin@local.com'
const PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD ?? 'Passw0rd!234'
const OUT_DIR = join(process.cwd(), 'public', 'images', 'blog')
const ONLY = process.env.SHOTS_ONLY?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
const KEEP_PNG = process.env.SHOTS_KEEP_PNG === 'true'

/** Output width in CSS pixels. The blog body column is ~800px, so this is ~2x. */
const OUT_WIDTH = 1440

interface Shot {
  name: string
  path: string
  /** Element that proves the page rendered its data, not just its shell. */
  waitFor?: string
  /** Authenticated pages are shot after sign-in. */
  auth?: boolean
  /** Pixels to scroll before shooting, for a section below the fold. */
  scrollY?: number
  /** Extra interaction — typing a query, opening a panel. */
  prepare?: (page: Page) => Promise<void>
  /** Extra selectors to hide before shooting, on top of the global overlays. */
  hide?: string[]
  viewport?: { width: number; height: number }
  fullPage?: boolean
}

const SHOTS: Shot[] = [
  {
    name: 'landing-hero',
    path: '/',
    waitFor: 'h1',
  },
  {
    name: 'explore',
    path: '/explore?q=rust',
    waitFor: 'h1',
    // The public explorer runs a real federated search; give the slowest
    // source time to answer before shooting an empty state.
    prepare: (page) => page.waitForTimeout(6000),
  },
  {
    name: 'pricing',
    path: '/pricing',
    waitFor: 'h1',
  },
  {
    name: 'changelog',
    path: '/changelog',
    waitFor: '[data-testid="changelog-entry"]',
  },
  {
    name: 'changelog-entry',
    path: '/changelog/pro-max-credits-and-packs',
    waitFor: '[data-testid="changelog-body"] table',
  },
  {
    name: 'roadmap',
    path: '/roadmap',
    waitFor: '[data-testid="roadmap-page"] article',
    // Show only the roadmap this repository defines. A developer database
    // accumulates rows typed in by hand during QA, and those are not part of
    // the product — production has exactly the file-managed set, so the image
    // should too. `content-roadmap-` is the deterministic id prefix that
    // `content/roadmap/*.md` owns (see platform-content-source.ts).
    hide: ['[data-testid^="roadmap-item-"]:not([data-testid^="roadmap-item-content-roadmap-"])'],
  },
  {
    name: 'dashboard',
    path: '/dashboard',
    auth: true,
    waitFor: 'h1',
    // The recommendations tile loads after the shell; without this the shot
    // catches "Loading recommendations…".
    prepare: (page) => page.waitForTimeout(5000),
  },
  {
    name: 'search',
    path: '/search',
    auth: true,
    waitFor: 'h1',
    prepare: async (page) => {
      const input = page.locator('input[type="search"], input[type="text"]').first()
      await input.fill('postgres performance')
      await input.press('Enter')
      await page.waitForTimeout(9000)
    },
  },
  {
    name: 'alerts',
    path: '/alerts',
    auth: true,
    waitFor: 'h1',
  },
  {
    name: 'sprints',
    path: '/sprints',
    auth: true,
    waitFor: 'h1',
  },
  {
    name: 'calendar',
    path: '/calendar',
    auth: true,
    waitFor: 'h1',
  },
  {
    name: 'admin-content',
    path: '/admin/content?tab=roadmap',
    auth: true,
    waitFor: '[data-testid="admin-roadmap-filters"]',
  },
]

/**
 * Navigate and wait for React to be live.
 *
 * `html[data-hydrated]` is written from a `useEffect` in `HydrationSignal`, so
 * its presence is proof of the hydration commit rather than a guess at it.
 * Without this wait, filling the sign-in form types into pre-hydration DOM and
 * the click submits the form natively — which lands back on /auth/sign-in?
 * with no error shown, and looks exactly like a wrong password.
 */
async function gotoHydrated(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 })
}

/**
 * Hides the cookie banner for the duration of the shot instead of answering it.
 *
 * Clicking through it would record a consent decision in the database on behalf
 * of whoever owns the seeded admin account, and the banner is not the thing any
 * of these images is documenting. Hiding is cosmetic and leaves no state.
 *
 * Done as a DOM write immediately before the screenshot rather than as CSS
 * injected at init: the banner mounts after hydration, and a stylesheet added
 * before the framework takes over `<head>` does not reliably survive it.
 */
const OVERLAY_SELECTORS = ['[data-testid="cookie-banner"]']

async function hideElements(page: Page, selectors: string[]) {
  await page.evaluate((list) => {
    for (const selector of list) {
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        el.style.setProperty('display', 'none', 'important')
      }
    }
  }, selectors)
}

async function signIn(page: Page) {
  await gotoHydrated(page, `${BASE_URL}/auth/sign-in`)
  // Already authenticated sessions are bounced straight out of /auth.
  if (!page.url().includes('/auth/sign-in')) return
  await page.fill('#email', EMAIL)
  await page.fill('#password', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 30_000 })
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // 2x so text stays crisp after the downscale to OUT_WIDTH.
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    // Motion-heavy pages otherwise get caught mid-animation.
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()

  const wanted = SHOTS.filter((s) => ONLY.length === 0 || ONLY.includes(s.name))
  const needsAuth = wanted.some((s) => s.auth)
  if (needsAuth) {
    console.log(`🔑  signing in as ${EMAIL}`)
    await signIn(page)
  }

  const written: string[] = []
  for (const shot of wanted) {
    if (shot.viewport) await page.setViewportSize(shot.viewport)
    else await page.setViewportSize({ width: 1440, height: 900 })

    process.stdout.write(`📸  ${shot.name} … `)
    try {
      await gotoHydrated(page, `${BASE_URL}${shot.path}`)
      if (shot.waitFor) await page.waitForSelector(shot.waitFor, { timeout: 25_000 })
      if (shot.prepare) await shot.prepare(page)
      if (shot.scrollY) {
        await page.evaluate((y) => window.scrollTo(0, y), shot.scrollY)
        await page.waitForTimeout(400)
      }
      // Fonts settle after layout; a shot taken too early catches fallback metrics.
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(500)
      await hideElements(page, [...OVERLAY_SELECTORS, ...(shot.hide ?? [])])

      const png = await page.screenshot({ fullPage: shot.fullPage ?? false })
      const pngPath = join(OUT_DIR, `${shot.name}.png`)
      const webpPath = join(OUT_DIR, `${shot.name}.webp`)
      await writeFile(pngPath, png)
      await sharp(png).resize({ width: OUT_WIDTH }).webp({ quality: 82, effort: 6 }).toFile(webpPath)
      if (!KEEP_PNG) await rm(pngPath, { force: true })
      written.push(`${shot.name}.webp`)
      console.log('ok')
    } catch (err) {
      // One unreachable page must not lose the other eleven shots.
      console.log(`FAILED — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    }
  }

  await browser.close()
  console.log(`\n✅  ${written.length}/${wanted.length} written to public/images/blog/`)
  if (written.length < wanted.length) process.exitCode = 1
}

main().catch((err) => {
  console.error('❌  screenshot capture failed:', err)
  process.exit(1)
})
