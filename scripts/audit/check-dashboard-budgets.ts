/**
 * check-dashboard-budgets.ts — Wave 7 task 3 (performance budget enforcement).
 *
 * Reads the most recent baseline JSON from
 *   docs/ui-audit/evidence/dashboard-baseline/metrics-*.json
 * and fails (exit 1) when any viewport violates a budget.
 *
 * Budgets (mirror docs/operations/development.md):
 *   - TTFB cold   < 200 ms  (fail > 400 ms)
 *   - DCL         < 600 ms  (fail > 1000 ms)
 *   - load        < 800 ms  (fail > 1500 ms)
 *   - CLS         < 0.05    (fail > 0.1)
 *   - requests    < 100     (fail > 200)
 *   - bytes       < 5 MB    desktop / < 3 MB mobile  (fail > 10 MB)
 *   - axe         0         (fail on any)
 *
 * Usage:
 *   # local check (assumes dashboard-baseline already ran)
 *   pnpm tsx --env-file-if-exists=.env scripts/audit/check-dashboard-budgets.ts
 *
 *   # full pass (records baseline then enforces)
 *   SAAS_REVIEW_BASE_URL=http://localhost:3010 \
 *     scripts/audit/dashboard-baseline.ts && \
 *     scripts/audit/check-dashboard-budgets.ts
 *
 *   # CI: same, exit code non-zero on violation
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASELINE_DIR = 'docs/ui-audit/evidence/dashboard-baseline'

interface Budget {
  metric: 'ttfbMs' | 'domContentLoadedMs' | 'loadMs' | 'cls' | 'requestCount' | 'transferredBytes' | 'axeViolations'
  warn: number
  fail: number
  /** Bytes budgets differ by viewport; null = single value. */
  perViewportBytes?: Record<string, { warn: number; fail: number }>
}

const BUDGETS: Budget[] = [
  { metric: 'ttfbMs', warn: 200, fail: 400 },
  { metric: 'domContentLoadedMs', warn: 600, fail: 1000 },
  { metric: 'loadMs', warn: 800, fail: 1500 },
  { metric: 'cls', warn: 0.05, fail: 0.1 },
  { metric: 'requestCount', warn: 100, fail: 200 },
  {
    metric: 'transferredBytes',
    warn: 5_000_000,
    fail: 10_000_000,
    perViewportBytes: { 'mobile-320': { warn: 3_000_000, fail: 10_000_000 } },
  },
  { metric: 'axeViolations', warn: 0, fail: 0 }, // 0 warn = same as 0 fail; intentional hard ceiling
]

interface BaselineSample {
  viewport: string
  status: number | null
  ttfbMs: number | null
  domContentLoadedMs: number | null
  loadMs: number | null
  cls: number | null
  requestCount: number
  transferredBytes: number
  consoleErrors: string[]
  axeViolations: number
}

interface BudgetViolation {
  viewport: string
  metric: string
  value: number
  warn: number
  fail: number
}

async function loadLatestBaseline(): Promise<{ file: string; samples: BaselineSample[] }> {
  const files = await readdir(BASELINE_DIR)
  const metricsFiles = files.filter((f) => /^metrics-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
  if (metricsFiles.length === 0) {
    throw new Error(`no metrics-*.json files in ${BASELINE_DIR}; run dashboard-baseline.ts first`)
  }
  const latest = metricsFiles[metricsFiles.length - 1]
  const content = await readFile(join(BASELINE_DIR, latest), 'utf8')
  return { file: join(BASELINE_DIR, latest), samples: JSON.parse(content) as BaselineSample[] }
}

function evaluate(samples: BaselineSample[]): {
  violations: BudgetViolation[]
  warnings: BudgetViolation[]
} {
  const violations: BudgetViolation[] = []
  const warnings: BudgetViolation[] = []

  for (const sample of samples) {
    for (const budget of BUDGETS) {
      const value = sample[budget.metric] as number | null
      if (value === null || value === undefined) continue

      let warn = budget.warn
      let fail = budget.fail
      if (budget.metric === 'transferredBytes' && budget.perViewportBytes) {
        const override = budget.perViewportBytes[sample.viewport]
        if (override) {
          warn = override.warn
          fail = override.fail
        }
      }

      if (value > fail) {
        violations.push({ viewport: sample.viewport, metric: budget.metric, value, warn, fail })
      } else if (value > warn) {
        warnings.push({ viewport: sample.viewport, metric: budget.metric, value, warn, fail })
      }
    }
  }

  return { violations, warnings }
}

function fmt(v: BudgetViolation): string {
  return `${v.viewport.padEnd(28)}  ${v.metric.padEnd(22)}  value=${v.value}  fail>${v.fail}  warn>${v.warn}`
}

async function main() {
  const { file, samples } = await loadLatestBaseline()
  console.log(`📊 reading: ${file}`)
  console.log(`    ${samples.length} viewport(s): ${samples.map((s) => s.viewport).join(', ')}`)

  const { violations, warnings } = evaluate(samples)

  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} warning(s) (over warn budget, under fail budget):`)
    for (const v of warnings) console.log(`   ${fmt(v)}`)
  }

  if (violations.length > 0) {
    console.log(`\n❌ ${violations.length} violation(s) (over fail budget):`)
    for (const v of violations) console.log(`   ${fmt(v)}`)
    console.log(`\nbudget check FAILED`)
    process.exit(1)
  }

  console.log(`\n✓ all viewports within budget`)
}

main().catch((err) => {
  console.error('❌ budget check failed:', err)
  process.exit(1)
})
