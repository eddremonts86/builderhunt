/**
 * Measures how tall the landing page is, and photographs it (plan: phase-2/08).
 *
 * Sibling of `dashboard-baseline.ts`, with a different question. That one asks how heavy an
 * application shell is; this one asks how many screens tall a marketing page has become — the metric
 * that notices a page growing one defensible section at a time until nobody reaches the call to
 * action. Bytes never notice: three text sections weigh nothing.
 *
 * Writes `metrics-<date>.json` for `check-landing-budget.ts` to enforce, plus a screenshot per
 * viewport per persona, so a review can see what the number describes.
 *
 * Usage:
 *   LANDING_WALK_BASE_URL=http://localhost:3010 pnpm tsx --env-file-if-exists=.env scripts/audit/landing-walk.ts
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { chromium } from 'playwright'

import { USER_SEGMENTS } from '../../src/shared/lib/user-segments'

const OUTPUT_DIR = 'docs/ui-audit/evidence/landing-baseline'
const BASE_URL = (process.env.LANDING_WALK_BASE_URL ?? process.env.SAAS_REVIEW_BASE_URL ?? 'http://localhost:3010').replace(/\/$/, '')

/**
 * Desktop 1440 and mobile 375.
 *
 * The spec says "mobile 320" in one line and the budget was measured at 375; 375 is what the rest of
 * this repository treats as the phone (`responsive-qa-checklist.md`, the Playwright `mobile` project),
 * so a second number here would produce a measurement nothing else can be compared against.
 */
const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900, colorScheme: 'light' as const, dir: 'desktop-light' },
  { label: 'desktop', width: 1440, height: 900, colorScheme: 'dark' as const, dir: 'desktop-dark' },
  { label: 'mobile', width: 375, height: 812, colorScheme: 'light' as const, dir: 'mobile-375' },
]

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  const stamp = new Date().toISOString().slice(0, 10)
  /** Highest measurement per label wins: the budget is a ceiling, so the tallest render is the honest one. */
  const viewportHeights: Record<string, number> = {}

  try {
    for (const viewport of VIEWPORTS) {
      const dir = join(OUTPUT_DIR, viewport.dir)
      await mkdir(dir, { recursive: true })
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: viewport.colorScheme,
        // The page animates on scroll; a reduced-motion context makes two runs comparable.
        reducedMotion: 'reduce',
      })
      const page = await context.newPage()

      for (const persona of USER_SEGMENTS) {
        await page.goto(`${BASE_URL}/?persona=${persona}`, { waitUntil: 'networkidle' })
        const ratio = await page.evaluate(
          () => document.documentElement.scrollHeight / window.innerHeight,
        )
        viewportHeights[viewport.label] = Math.max(viewportHeights[viewport.label] ?? 0, ratio)
        await page.screenshot({ path: join(dir, `${persona}.png`), fullPage: true })
        console.log(`  ${viewport.dir}/${persona}: ${ratio.toFixed(2)} viewports`)
      }
      await context.close()
    }

    const metricsPath = join(OUTPUT_DIR, `metrics-${stamp}.json`)
    await writeFile(
      metricsPath,
      `${JSON.stringify({ capturedAt: new Date().toISOString(), baseUrl: BASE_URL, viewportHeights }, null, 2)}\n`,
      'utf8',
    )
    console.log(`\nwrote ${metricsPath}`)
    for (const [label, value] of Object.entries(viewportHeights)) console.log(`  ${label}: ${value.toFixed(2)} viewports`)
  } finally {
    await browser.close()
  }
}

main().catch((error: unknown) => {
  console.error(`landing walk failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  process.exit(1)
})
