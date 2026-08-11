/**
 * Static budgets for the Admin Metrics page (plan 57, Admin track — "Add Admin Metrics accessibility,
 * performance, and regression gates").
 *
 * The plan's Verify line lists things that must never pass CI. Three of them are decidable by reading the
 * source, and a static check is strictly better for those than a runtime one: it cannot be flaky, it names the
 * file, and it fails on the pull request that introduces the problem rather than on the deploy that exposes it.
 *
 * The ones that need a browser or a database — the p95 budgets, no overlapping request, no hidden polling — live
 * in `tests/e2e/admin-metrics-shell.spec.ts` and the unit suites, because they are properties of behaviour and
 * not of text.
 *
 * Usage: `node scripts/check-admin-metrics-budgets.mjs`
 */
import { readFile } from 'node:fs/promises'

const findings = []

const SECTIONS = 'src/shared/lib/admin-metrics/sections.ts'
const CONTRACTS = 'src/shared/lib/admin-metrics/contracts.ts'
const HOOK = 'src/modules/admin/metrics/useMetricSection.ts'

/**
 * Comments are stripped before anything is matched, and the first version of this check is why.
 *
 * `sections.ts` carries a paragraph explaining *why* it does not use `getBillingOperationsMetrics` — so a naive
 * search for the identifier failed the gate on the comment that documents the rule the gate enforces. A check
 * that punishes writing down the reason is worse than no check: the cheapest way to make it pass would have been
 * to delete the explanation.
 */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}

const sections = code(await readFile(SECTIONS, 'utf8'))
const contracts = code(await readFile(CONTRACTS, 'utf8'))
const hook = code(await readFile(HOOK, 'utf8'))

/**
 * 1. No billing sweep on the metrics path.
 *
 * `getBillingOperationsMetrics` walks every organization serially — one transaction and nine queries each — and
 * it was deliberately removed from `/api/admin/metrics` for that reason. A metrics section sits on a
 * thirty-second refresh timer, which is the most frequent path in the product, so re-importing it here would
 * undo that work invisibly: the page would still render, just slowly and at a cost nobody sees in review.
 */
if (/import[^;]*getBillingOperationsMetrics|getBillingOperationsMetrics\s*\(/.test(sections)) {
  findings.push(
    `${SECTIONS}: imports getBillingOperationsMetrics — that walks every organization and must not sit on the ` +
      'metrics refresh path. Use countBillingWebhookEventsByStatus, or /api/admin/billing/metrics on demand.',
  )
}

/**
 * 2. Every payload collection stays capped in the schema.
 *
 * The caps are the difference between a bounded response and one whose size is decided by how much data exists.
 * Asserting they are *present* rather than their values, because the numbers are a product decision and the
 * `.max()` is the mechanism — a collection that loses its cap is the regression, whatever the number was.
 */
for (const [name, pattern] of [
  ['values', /values:\s*z\s*\.array\([^)]*\)\s*\.max\(/],
  ['series', /series:\s*z\s*\.array\([^)]*\)\s*\.max\(/],
  ['ranked rows', /rankedRouteRowsSchema[\s\S]{0,400}?\.max\(/],
  ['action queue rows', /actionQueueRowsSchema[\s\S]{0,900}?\.max\(/],
  ['series buckets', /buckets:\s*z[\s\S]{0,300}?\.max\(/],
]) {
  if (!pattern.test(contracts)) {
    findings.push(`${CONTRACTS}: the ${name} collection has no \`.max()\` — its size would be decided by data.`)
  }
}

/**
 * 3. No ranged read wider than the closed range vocabulary.
 *
 * `ADMIN_METRIC_RANGES` exists so a caller cannot ask for eighteen months and get a sequential scan on the
 * busiest table in the product. A `range` parsed from a free string, or a `RANGE_MS` entry added without a
 * matching enum member, reintroduces exactly that.
 */
const rangeKeys = [...contracts.matchAll(/ADMIN_METRIC_RANGES\s*=\s*\[([^\]]+)\]/g)]
  .flatMap((match) => [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]))
const rangeMsKeys = [...sections.matchAll(/RANGE_MS:\s*Record<[^>]+>\s*=\s*\{([^}]+)\}/g)]
  .flatMap((match) => [...match[1].matchAll(/'([^']+)'\s*:/g)].map((entry) => entry[1]))
if (rangeKeys.length === 0) {
  findings.push(`${CONTRACTS}: could not find ADMIN_METRIC_RANGES — the range allowlist is the read bound.`)
} else if (rangeMsKeys.length > 0) {
  const extra = rangeMsKeys.filter((key) => !rangeKeys.includes(key))
  if (extra.length > 0) {
    findings.push(`${SECTIONS}: RANGE_MS has ${extra.join(', ')} with no matching ADMIN_METRIC_RANGES entry.`)
  }
}

/**
 * 4. The section fetch keeps its abort.
 *
 * "No overlapping request" is in the Verify line, and the mechanism is one `AbortController` per hook that
 * aborts the previous request before starting the next. Without it, switching section three times quickly leaves
 * three requests racing and whichever answers last wins — so the page can settle on the section you left. The
 * e2e spec proves the behaviour; this catches the removal of the mechanism in a diff.
 */
/**
 * Matched as a *sequence*, because there are two aborts and only one prevents the race.
 *
 * The hook aborts twice: once at the top of `load` to supersede the request in flight, and once in the effect's
 * cleanup so an unmounted section cannot settle state. A check for the identifier alone passes when the first one
 * is deleted — I confirmed that by deleting it, and the gate stayed green. So this looks for the abort *followed
 * by* a fresh controller within a few lines, which is the supersede specifically.
 */
if (!/\.abort\(\)[\s\S]{0,160}new AbortController\(\)/.test(hook)) {
  findings.push(
    `${HOOK}: no abort immediately before \`new AbortController()\` — concurrent section requests would race and ` +
      'the page could settle on the section the operator left.',
  )
}

/**
 * 5. Polling still respects a hidden tab.
 *
 * A backgrounded tab polling every thirty seconds queries the platform at nobody, forever. The unit suite proves
 * the behaviour at both edges; this makes deleting the listener a failed check rather than a silent regression.
 */
if (!/visibilitychange/.test(hook)) {
  findings.push(`${HOOK}: no visibilitychange listener — a hidden tab would keep polling.`)
}

if (findings.length > 0) {
  console.error(`${findings.length} admin-metrics budget problem(s):\n`)
  for (const finding of findings) console.error(`  - ${finding}`)
  process.exit(1)
}

console.log(
  JSON.stringify({
    ranges: rangeKeys.length,
    cappedCollections: 5,
    billingSweepOnMetricsPath: false,
  }),
)
