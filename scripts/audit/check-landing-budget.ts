/**
 * The landing page's size budget (plan: phase-2/08-homing-page-content-and-sections).
 *
 * ## Why viewport heights and not bytes
 *
 * `check-dashboard-budgets.ts` next door measures transfer and timing, which is the right question
 * for an application shell. A landing page's failure mode is different: it grows a section at a time,
 * each one defensible on its own, until nobody scrolls to the call to action. Bytes would not notice
 * — three text sections weigh almost nothing — so the metric is how many screens tall the page is.
 *
 * ## The budgets
 *
 * The spec measured the page before this plan at 7.2 viewports on desktop and 13.4 on mobile, and set
 * the ceiling at 1.5× each: **10.8 desktop, 20.1 mobile**. A run is over budget only past a 0.2
 * tolerance, because a heading wrapping onto a second line moves the number by a hundredth and that is
 * not a regression anybody should be paged about.
 *
 * ## It refuses rather than passes when there is no baseline
 *
 * A gate that silently succeeds because it found no data is worse than no gate: it reports green
 * every run and nobody notices the walker stopped producing files. Missing baseline is exit 1 with
 * the command that produces one.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASELINE_DIR = 'docs/ui-audit/evidence/landing-baseline'

/** From `spec.md` §Page-size budget: the pre-change measurement × 1.5. */
export const LANDING_BUDGETS = {
  desktop: 10.8,
  mobile: 20.1,
} as const

/** A heading wrapping is not a regression. Anything past this is. */
export const BUDGET_TOLERANCE = 0.2

export interface LandingMetrics {
  /** Page height ÷ viewport height, per viewport label. */
  viewportHeights: Partial<Record<'desktop' | 'mobile', number>>
  capturedAt?: string
}

export interface BudgetViolation {
  viewport: 'desktop' | 'mobile'
  measured: number
  budget: number
  over: number
}

/** Compares a measurement against the budgets. Pure, so the thresholds are testable without files. */
export function findViolations(metrics: LandingMetrics): BudgetViolation[] {
  const violations: BudgetViolation[] = []
  for (const viewport of ['desktop', 'mobile'] as const) {
    const measured = metrics.viewportHeights[viewport]
    if (measured === undefined) continue
    const budget = LANDING_BUDGETS[viewport]
    if (measured > budget + BUDGET_TOLERANCE) {
      violations.push({ viewport, measured, budget, over: Number((measured - budget).toFixed(2)) })
    }
  }
  return violations
}

/** The newest `metrics-*.json` in the baseline directory, or `null` when there is none. */
export async function newestMetricsFile(dir = BASELINE_DIR): Promise<string | null> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const candidates = entries.filter((name) => /^metrics-.*\.json$/.test(name)).sort()
  const newest = candidates.at(-1)
  return newest ? join(dir, newest) : null
}

async function main(): Promise<void> {
  const file = await newestMetricsFile()
  if (!file) {
    console.error(
      `landing budget: no metrics found in ${BASELINE_DIR}.\n`
        + '  Record one with: pnpm tsx --env-file-if-exists=.env scripts/audit/landing-walk.ts\n'
        + '  Refusing rather than passing — a gate that goes green on missing data is not a gate.',
    )
    process.exit(1)
  }

  const metrics = JSON.parse(await readFile(file, 'utf8')) as LandingMetrics
  const measured = metrics.viewportHeights ?? {}
  if (Object.keys(measured).length === 0) {
    console.error(`landing budget: ${file} carries no viewportHeights.`)
    process.exit(1)
  }

  const violations = findViolations(metrics)
  for (const viewport of ['desktop', 'mobile'] as const) {
    const value = measured[viewport]
    if (value === undefined) continue
    const mark = violations.some((v) => v.viewport === viewport) ? '✗' : '✓'
    console.log(`  ${mark} ${viewport.padEnd(8)} ${value.toFixed(2)} viewports (budget ${LANDING_BUDGETS[viewport]})`)
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(
        `landing budget: ${v.viewport} is ${v.measured.toFixed(2)} viewports, ${v.over} over the ${v.budget} budget.\n`
          + '  The page grows a section at a time, each defensible alone, until nobody reaches the CTA.\n'
          + '  Remove or shorten a section rather than raising the number here.',
      )
    }
    process.exit(1)
  }
  console.log(`landing budget: within budget (${file})`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`landing budget failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    process.exit(1)
  })
}
