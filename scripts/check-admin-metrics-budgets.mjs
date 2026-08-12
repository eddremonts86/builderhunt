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
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Every `.ts`/`.tsx` under the metrics UI directory, tests excluded. */
async function metricsUiFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return metricsUiFiles(path)
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : []
    }),
  )
  return nested.flat()
}

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

/**
 * 6. No destructive or outward-facing operation on the Command Center.
 *
 * The plan's release-gate task says to "confirm destructive/outward-facing operations are absent from the Command
 * Center", and the reason is specific to what this page is: a summary read at 02:00 by somebody under time
 * pressure, where every number is a link to somewhere that can act. A button that *does* something next to a
 * number that says something is wrong gets pressed as though it were the fix.
 *
 * So the metrics page and its sections may only read. Mutations live on the canonical detail pages, which have
 * their own confirmations and their own audit rows. This reads the client modules rather than the routes, because
 * the routes are already sealed to GET by `check-api-route-methods` — what this catches is a widget growing a
 * "retry this" button.
 */
const METRICS_UI_DIR = 'src/modules/admin/metrics'

/**
 * The one endpoint a metrics widget may write to: this admin's own console preferences.
 *
 * ## Why an exception exists at all
 *
 * The rule above is about *platform* state — "destructive or outward-facing", in the plan's words — and its
 * concrete danger is a button that acts sitting beside a number that says something is wrong, pressed as though
 * it were the fix. `PUT /api/admin/preferences` is neither destructive nor outward-facing: it writes one row keyed
 * on the acting admin, it changes only where *their own* console opens next time, and it is refused for a
 * different user by construction — the route takes no `userId` in either direction. Nobody presses "open here by
 * default" believing it will restart a worker.
 *
 * There is also nowhere else for it to live. The rule sends actions to "the canonical detail page", and the
 * canonical page for *this page's* landing view is this page. A control on some other screen saying "open metrics
 * at Reliability" would be harder to find and harder to reason about than the thing it configures.
 *
 * ## Why it is a single literal and not a pattern
 *
 * An allowlist of one exact path, checked on the same statement as the method, so it cannot widen by accident.
 * `/api/admin/**` would have admitted every billing and abuse mutation the rule exists to keep off this page, and
 * a relaxation written to let one change through is the kind that quietly becomes a hole. Adding a second entry
 * here should feel like the decision it is.
 *
 * The cost is real and worth naming rather than arguing away: any button at all erodes the "this page only reads"
 * property that makes it safe to skim at 02:00. Two buttons, both about the viewer's own view, is the budget.
 */
const PREFERENCES_ENDPOINT = '/api/admin/preferences'

const uiFiles = await metricsUiFiles(METRICS_UI_DIR)
for (const file of uiFiles) {
  const source = code(await readFile(file, 'utf8'))
  /**
   * Matched per `fetch(...)` call rather than per `method:` occurrence, so the method and its URL are judged
   * together. Scanning for `method:` alone and then asking whether the *file* mentions the preferences path would
   * pass a file that writes to preferences once and deletes a billing row somewhere below it.
   */
  const calls = [...source.matchAll(/fetch\(\s*(['"`])([^'"`]*)\1[\s\S]{0,400}?\)/g)]
  for (const call of calls) {
    const [statement, , url] = call
    const method = /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.exec(statement)
    if (!method) continue
    if (url === PREFERENCES_ENDPOINT) continue
    findings.push(
      `${file}: sends a ${method[1].toUpperCase()} to ${url || '(dynamic url)'} — the Command Center reads. A ` +
        'control that acts belongs on the canonical detail page, which has the confirmation and the audit row. ' +
        `Only ${PREFERENCES_ENDPOINT} is exempt, because it writes the viewer's own landing view and nothing else.`,
    )
  }

  /**
   * A mutating `method:` that no `fetch(<literal>)` accounted for is still a finding.
   *
   * Otherwise the exemption above could be sidestepped by building the URL in a variable — `fetch(endpoint, {
   * method: 'DELETE' })` — which this file's own history argues is worth guarding: the abort check in this same
   * script was once satisfied by an identifier appearing anywhere in the file, and deleting the real guard left
   * the gate green.
   */
  const declared = [...source.matchAll(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/gi)].length
  const accounted = calls.filter((call) => /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(call[0])).length
  if (declared > accounted) {
    findings.push(
      `${file}: ${declared - accounted} mutating request(s) whose URL is not a literal in the fetch call — the ` +
        'Command Center reads, and a dynamic URL cannot be checked against the one exempt endpoint.',
    )
  }
}

/**
 * 7. Nothing in the metrics modules logs a path, an id or a payload.
 *
 * "Redacted telemetry/logs" in the Verify line. The route-family allowlist keeps a raw path out of the *stored*
 * metric, and a `console.log` of the same value would put it in the server log instead — same identifier, different
 * sink, and the log is the one nobody audits. `console.error` with a caught error is allowed: that is the failure
 * itself, not data about a request.
 */
for (const [label, file] of [['sections', SECTIONS], ['hook', HOOK]]) {
  const source = label === 'sections' ? sections : hook
  const logs = [...source.matchAll(/console\.(log|info|warn|debug)\s*\(/g)]
  if (logs.length > 0) {
    findings.push(`${file}: ${logs.length} console.${logs[0][1]} call(s) — the metrics path must not log request data.`)
  }
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
    uiFilesScanned: uiFiles.length,
    mutationsOnCommandCenter: 0,
  }),
)
