/**
 * Visual regression baseline for the public surfaces (plan: audit-visual-system).
 *
 * Public routes only, deliberately: they render without a session, so this
 * suite needs no disposable database, no seeded fixtures and no per-worker
 * server. That keeps it fast and, more importantly, keeps a screenshot diff
 * meaning "the design changed" rather than "the fixture data changed".
 *
 * Three sources of false diffs are pinned before every capture:
 *
 * 1. **Time** — `installFixedBrowserClock` freezes the page clock, so relative
 *    dates ("2 days ago") and any date-stamped copy render identically.
 * 2. **Motion** — entry animations settle at different points between runs.
 *    `prefers-reduced-motion` is emulated, which the app already honours (see
 *    the reduced-motion block in `globals.css`), and animations are also
 *    zeroed via CSS so anything not covered by that block still lands.
 * 3. **Fonts** — a capture taken before the webfont swaps in is a diff against
 *    every later run. `document.fonts.ready` gates each shot.
 *
 * Baselines are platform-specific: Playwright names them per project *and*
 * per OS, so the macOS files a developer generates locally never collide with
 * the Linux files CI compares against. Regenerate with `--update-snapshots`.
 */
import { expect, test } from 'playwright/test'
import { installFixedBrowserClock } from '../harness/clock'
import { gotoHydrated } from '../harness/browser'

/** Routes that render fully for an anonymous visitor. */
const PUBLIC_ROUTES = [
  { path: '/', name: 'landing' },
  { path: '/pricing', name: 'pricing' },
  { path: '/roadmap', name: 'roadmap' },
  { path: '/changelog', name: 'changelog' },
  { path: '/legal/terms', name: 'legal-terms' },
  { path: '/legal/privacy', name: 'legal-privacy' },
  { path: '/auth/sign-in', name: 'sign-in' },
  { path: '/auth/sign-up', name: 'sign-up' },
] as const

/**
 * Small enough to absorb antialiasing differences between runs on the same
 * platform, tight enough that a shifted control or a changed token still
 * fails. Raise this only with a measured reason, never to silence a diff.
 */
const MAX_DIFF_PIXEL_RATIO = 0.01

async function prepare(page: import('playwright/test').Page, path: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installFixedBrowserClock(page)
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }`,
  })
  await gotoHydrated(page, path)
  await page.evaluate(() => document.fonts.ready)
}

test.describe('public surfaces — desktop', () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route.name} matches its baseline`, async ({ page }) => {
      await prepare(page, route.path)
      await expect(page).toHaveScreenshot(`${route.name}.png`, {
        fullPage: true,
        maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
        animations: 'disabled',
      })
    })
  }
})

test.describe('public surfaces — mobile', () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route.name} matches its baseline @mobile-only`, async ({ page }) => {
      await prepare(page, route.path)
      await expect(page).toHaveScreenshot(`${route.name}.png`, {
        fullPage: true,
        maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
        animations: 'disabled',
      })
    })
  }
})
