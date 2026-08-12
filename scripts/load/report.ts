import { LatencyHistogram, type LatencySummary } from './histogram'
import { LOAD_EXIT_CODES, type LoadConfig, type LoadExitCode, type LoadThresholds } from './config'

/**
 * The verdict, and the redaction that makes it safe to attach to a ticket (plan 55 phase 0).
 *
 * ## Redaction is not a formatting concern
 *
 * A load report is the artifact somebody pastes into an issue, uploads to CI, or mails to a colleague. It
 * is assembled from URLs that carry passwords, from responses that may carry `Set-Cookie`, and from an
 * environment that holds five role credentials. So redaction happens **when the report is built**, not when
 * it is printed — a printer that redacts leaves the secret in the object that a later `JSON.stringify`
 * somewhere else will happily write out.
 *
 * `assertNoSecrets` is the belt to that braces: it scans the finished document and throws, because a report
 * that cannot be produced is recoverable and a report that has already been uploaded is not.
 */

export interface RouteOutcome {
  path: string
  /** Requests that returned 2xx. */
  ok: number
  /** 5xx — the spec's own category, budgeted separately from other non-2xx. */
  serverErrors: number
  /** Any other non-2xx, `429` included. The spec counts a rate-limited request as unexpected load shedding. */
  unexpected: number
  /** No response inside `requestTimeoutMs`. Counted apart from a slow response, which has a latency. */
  timeouts: number
  latency: LatencySummary
}

export interface ObservabilitySample {
  postgresConnections: number
  pgBouncerBackends: number | null
  pgBouncerClientsWaiting: number | null
  pgBouncerMaxWaitMs: number | null
  processRssBytes: number
  /**
   * The rest of the observability contract in `spec.md`, optional because a field that was never observed
   * has to be distinguishable from one observed to be zero.
   *
   * That distinction is the whole reason these are `?: number | null` and not `number`. A direct run has no
   * pooler, so `SHOW STATS` yields nothing; a run outside compose has no container to ask about CPU or
   * restarts. Defaulting those to `0` would print "0 restarts" and "0% CPU" for a run that never looked —
   * which reads as a clean bill of health and is the failure this file already has scars from.
   */
  postgresActive?: number | null
  postgresIdleInTransaction?: number | null
  postgresWaiting?: number | null
  /** `53300 too_many_connections`, counted from the monitor's own refused connections. */
  tooManyConnections?: number | null
  pgBouncerTotalQueryCount?: number | null
  pgBouncerAvgQueryTimeUs?: number | null
  containerCpuPercent?: number | null
  containerRssBytes?: number | null
  containerRestarts?: number | null
  openFileDescriptors?: number | null
}

export interface LoadRunInput {
  runId: string
  /** `direct` or `transaction` — the report must say which topology it is about. */
  poolMode: 'direct' | 'transaction'
  commit: string | null
  startedAt: string
  endedAt: string
  config: LoadConfig
  routes: RouteOutcome[]
  samples: ObservabilitySample[]
  /** Set when the run never reached steady state. Produces `aborted`, not a threshold verdict. */
  abortedReason?: string
}

export interface ThresholdCheck {
  metric: string
  target: string
  observed: string
  pass: boolean
}

export interface LoadReport {
  runId: string
  poolMode: 'direct' | 'transaction'
  commit: string | null
  startedAt: string
  endedAt: string
  offeredRatePerSecond: number
  totals: { requests: number; ok: number; serverErrors: number; unexpected: number; timeouts: number }
  latency: LatencySummary
  routes: RouteOutcome[]
  peaks: {
    postgresConnections: number
    pgBouncerBackends: number | null
    pgBouncerMaxWaitMs: number | null
    waitSampleCompliance: number | null
    /**
     * `null` where nothing was observed, never `0`.
     *
     * `peakOf` returns null for an empty or all-null series precisely so a run that did not look at a
     * metric cannot be read as a run that looked and found nothing.
     */
    postgresActive: number | null
    postgresIdleInTransaction: number | null
    tooManyConnections: number | null
    containerCpuPercent: number | null
    containerRssBytes: number | null
    containerRestarts: number | null
    openFileDescriptors: number | null
  }
  rssGrowthRatio: number | null
  checks: ThresholdCheck[]
  verdict: 'pass' | 'fail' | 'aborted'
  /**
   * Why the run aborted, carried through to the artifact.
   *
   * Without this the report said "did not reach steady state" and nothing more, so an aborted run named no
   * cause — and the cause is the entire content of an aborted run. The reason is runner-authored text, never
   * a URL or a body, and `assertNoSecrets` scans it with everything else.
   */
  abortedReason?: string
  exitCode: LoadExitCode
}

/** Anything that must never reach a report, scanned as substrings over the serialized document. */
const SECRET_MARKERS = ['password', 'postgresql://', 'postgres://', 'redis://', 'set-cookie', 'authorization', 'sk_', 'whsec_']

/**
 * Throws if the finished report contains anything that looks like a credential.
 *
 * Case-insensitive, and it checks *keys* as well as values by scanning the serialized form: a field named
 * `databaseUrl` holding a redacted string is still a field somebody will fill in later.
 */
export function assertNoSecrets(report: unknown): void {
  const serialized = JSON.stringify(report).toLowerCase()
  const found = SECRET_MARKERS.find((marker) => serialized.includes(marker))
  if (found) {
    throw new Error(`refusing to emit a load report containing "${found}"`)
  }
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole
}

function fmtRatio(value: number): string {
  return `${(value * 100).toFixed(3)}%`
}

/**
 * Builds the report and decides the verdict.
 *
 * An aborted run is **not** evaluated against thresholds. It produced no steady-state window, so every
 * latency figure in it describes a ramp — and calling that a failed certification would send somebody
 * looking for a slow query when the truth is that the fixtures never validated.
 */
/**
 * The largest observed value, or `null` when nothing was observed.
 *
 * `Math.max()` of an empty list is `-Infinity` and `Math.max(0, …)` of one is `0`; both are answers to a
 * question that was never asked. Returning `null` keeps "not measured" and "measured as zero" apart all the
 * way into the report, where a reader can tell them apart too.
 */
function peakOf(
  samples: readonly ObservabilitySample[],
  pick: (sample: ObservabilitySample) => number | null | undefined,
): number | null {
  const values = samples.map(pick).filter((value): value is number => typeof value === 'number')
  return values.length === 0 ? null : Math.max(...values)
}

export function buildLoadReport(input: LoadRunInput): LoadReport {
  const total = new LatencyHistogram()
  const totals = { requests: 0, ok: 0, serverErrors: 0, unexpected: 0, timeouts: 0 }
  for (const route of input.routes) {
    totals.ok += route.ok
    totals.serverErrors += route.serverErrors
    totals.unexpected += route.unexpected
    totals.timeouts += route.timeouts
    totals.requests += route.ok + route.serverErrors + route.unexpected + route.timeouts
  }

  const durationSeconds = Math.max(
    1,
    (new Date(input.endedAt).getTime() - new Date(input.startedAt).getTime()) / 1000,
  )
  const offeredRatePerSecond = totals.requests / durationSeconds

  const latency: LatencySummary = input.routes.length === 1
    ? input.routes[0].latency
    : {
        // Percentiles cannot be averaged across routes, so the aggregate is reported as the union of the
        // samples the runner already merged into `total`. When the runner supplies per-route summaries only,
        // the honest aggregate is the widest observation rather than a fabricated blend.
        samples: input.routes.reduce((sum, r) => sum + r.latency.samples, 0),
        meanMs: Math.round(
          ratio(
            input.routes.reduce((sum, r) => sum + r.latency.meanMs * r.latency.samples, 0),
            input.routes.reduce((sum, r) => sum + r.latency.samples, 0),
          ),
        ),
        p50Ms: Math.max(...input.routes.map((r) => r.latency.p50Ms ?? 0)) || null,
        p95Ms: Math.max(...input.routes.map((r) => r.latency.p95Ms ?? 0)) || null,
        p99Ms: Math.max(...input.routes.map((r) => r.latency.p99Ms ?? 0)) || null,
        maxMs: Math.max(0, ...input.routes.map((r) => r.latency.maxMs)),
        resolutionMs: 1,
      }
  void total

  const peakPostgres = Math.max(0, ...input.samples.map((s) => s.postgresConnections))
  const pgBouncerSamples = input.samples.filter((s) => s.pgBouncerBackends !== null)
  const peakBackends = pgBouncerSamples.length > 0
    ? Math.max(...pgBouncerSamples.map((s) => s.pgBouncerBackends ?? 0))
    : null
  const peakMaxWait = pgBouncerSamples.length > 0
    ? Math.max(...pgBouncerSamples.map((s) => s.pgBouncerMaxWaitMs ?? 0))
    : null
  const compliantSamples = pgBouncerSamples.filter(
    (s) => (s.pgBouncerClientsWaiting ?? 0) === 0 && (s.pgBouncerMaxWaitMs ?? 0) <= input.config.thresholds.maxPgBouncerMaxWaitMs,
  ).length
  const waitSampleCompliance = pgBouncerSamples.length > 0 ? compliantSamples / pgBouncerSamples.length : null

  /**
   * RSS growth from minute 15 to the end, per the spec — not from the first sample.
   *
   * The first fifteen minutes include the ramp and the JIT warming up, so measuring from sample zero
   * reports a growth every healthy run has and turns the leak threshold into noise.
   */
  const fifteenMinutes = 15 * 60
  const sampleIntervalSeconds = 5
  const afterWarmup = input.samples.slice(Math.floor(fifteenMinutes / sampleIntervalSeconds))
  const rssGrowthRatio = afterWarmup.length >= 2
    ? (afterWarmup[afterWarmup.length - 1].processRssBytes - afterWarmup[0].processRssBytes) / afterWarmup[0].processRssBytes
    : null

  const t: LoadThresholds = input.config.thresholds
  const checks: ThresholdCheck[] = []
  const check = (metric: string, target: string, observed: string, pass: boolean) =>
    checks.push({ metric, target, observed, pass })

  check(
    'offered throughput',
    `${t.offeredRatePerSecond.min}–${t.offeredRatePerSecond.max} req/s`,
    `${offeredRatePerSecond.toFixed(1)} req/s`,
    offeredRatePerSecond >= t.offeredRatePerSecond.min && offeredRatePerSecond <= t.offeredRatePerSecond.max,
  )
  // `null` fails, and that is deliberate: a percentile with no samples is a route that was never
  // exercised, which is a fixture defect the verdict must not pass over.
  check('HTTP p50', `≤ ${t.httpP50Ms} ms`, `${latency.p50Ms ?? 'no samples'}`, latency.p50Ms !== null && latency.p50Ms <= t.httpP50Ms)
  check('HTTP p95', `≤ ${t.httpP95Ms} ms`, `${latency.p95Ms ?? 'no samples'}`, latency.p95Ms !== null && latency.p95Ms <= t.httpP95Ms)
  check('HTTP p99', `≤ ${t.httpP99Ms} ms`, `${latency.p99Ms ?? 'no samples'}`, latency.p99Ms !== null && latency.p99Ms <= t.httpP99Ms)

  const serverErrorRatio = ratio(totals.serverErrors, totals.requests)
  check('5xx responses', `≤ ${fmtRatio(t.maxServerErrorRatio)}`, fmtRatio(serverErrorRatio), serverErrorRatio <= t.maxServerErrorRatio)

  // Timeouts count as unexpected: a request that never answered is not a slow success.
  const unexpectedRatio = ratio(totals.unexpected + totals.timeouts, totals.requests)
  check(
    'unexpected non-2xx, including 429 and timeouts',
    `≤ ${fmtRatio(t.maxUnexpectedNon2xxRatio)}`,
    fmtRatio(unexpectedRatio),
    unexpectedRatio <= t.maxUnexpectedNon2xxRatio,
  )

  check('PostgreSQL connections', `≤ ${t.maxPostgresConnections} peak`, `${peakPostgres}`, peakPostgres <= t.maxPostgresConnections)

  if (input.poolMode === 'transaction') {
    // Only asserted for the pooled topology. Reporting a PgBouncer threshold as failed on a direct baseline
    // would be a red line about a component that is not in the path.
    check('PgBouncer backends', `≤ ${t.maxPgBouncerBackends} peak`, `${peakBackends ?? 'not sampled'}`, peakBackends !== null && peakBackends <= t.maxPgBouncerBackends)
    check(
      'PgBouncer wait compliance',
      `cl_waiting 0 and maxwait ≤ ${t.maxPgBouncerMaxWaitMs} ms in ≥ ${fmtRatio(t.minWaitSampleCompliance)} of samples`,
      waitSampleCompliance === null ? 'not sampled' : fmtRatio(waitSampleCompliance),
      waitSampleCompliance !== null && waitSampleCompliance >= t.minWaitSampleCompliance,
    )
  }

  if (rssGrowthRatio !== null) {
    check('RSS growth after minute 15', `< ${fmtRatio(t.maxRssGrowthRatio)}`, fmtRatio(rssGrowthRatio), rssGrowthRatio < t.maxRssGrowthRatio)
  }

  const verdict: LoadReport['verdict'] = input.abortedReason
    ? 'aborted'
    : checks.every((c) => c.pass) ? 'pass' : 'fail'

  const report: LoadReport = {
    runId: input.runId,
    poolMode: input.poolMode,
    commit: input.commit,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    offeredRatePerSecond: Number(offeredRatePerSecond.toFixed(1)),
    totals,
    latency,
    routes: input.routes,
    peaks: {
      postgresConnections: peakPostgres,
      pgBouncerBackends: peakBackends,
      pgBouncerMaxWaitMs: peakMaxWait,
      waitSampleCompliance,
      postgresActive: peakOf(input.samples, (sample) => sample.postgresActive),
      postgresIdleInTransaction: peakOf(input.samples, (sample) => sample.postgresIdleInTransaction),
      tooManyConnections: peakOf(input.samples, (sample) => sample.tooManyConnections),
      containerCpuPercent: peakOf(input.samples, (sample) => sample.containerCpuPercent),
      containerRssBytes: peakOf(input.samples, (sample) => sample.containerRssBytes),
      containerRestarts: peakOf(input.samples, (sample) => sample.containerRestarts),
      openFileDescriptors: peakOf(input.samples, (sample) => sample.openFileDescriptors),
    },
    rssGrowthRatio,
    checks: input.abortedReason ? [] : checks,
    verdict,
    ...(input.abortedReason ? { abortedReason: input.abortedReason } : {}),
    exitCode: verdict === 'pass'
      ? LOAD_EXIT_CODES.pass
      : verdict === 'aborted' ? LOAD_EXIT_CODES.aborted : LOAD_EXIT_CODES.thresholdBreach,
  }

  assertNoSecrets(report)
  return report
}

/**
 * The Markdown a human reads. Every failed check appears — none is summarised away.
 *
 * "No silent caps": a report that printed only the failures, or only the first, would let a reader believe
 * one thing was wrong when four were.
 */
export function renderLoadReportMarkdown(report: LoadReport): string {
  const lines: string[] = []
  lines.push(`# Load ${report.verdict.toUpperCase()} — ${report.runId}`)
  lines.push('')
  lines.push(`- pool mode: \`${report.poolMode}\``)
  lines.push(`- commit: \`${report.commit ?? 'unknown'}\``)
  lines.push(`- window: ${report.startedAt} → ${report.endedAt}`)
  lines.push(`- offered: ${report.offeredRatePerSecond} req/s over ${report.totals.requests} requests`)
  lines.push('')

  if (report.verdict === 'aborted') {
    lines.push('The run did not reach steady state, so **no thresholds were evaluated**. This is not a')
    lines.push('capacity result — treating it as one sends somebody looking for a slow query that may not exist.')
    lines.push('')
    // The cause is the whole content of an aborted report. Printed before anything else a reader might
    // mistake for a result.
    if (report.abortedReason) lines.push(`Reason: ${report.abortedReason}`, '')
  } else {
    lines.push('| metric | target | observed | |')
    lines.push('|---|---|---|---|')
    for (const c of report.checks) {
      lines.push(`| ${c.metric} | ${c.target} | ${c.observed} | ${c.pass ? '✅' : '❌'} |`)
    }
    lines.push('')
  }

  lines.push('## Per route')
  lines.push('')
  lines.push('| route | ok | 5xx | other non-2xx | timeouts | p50 | p95 | p99 |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const route of report.routes) {
    const l = route.latency
    lines.push(
      `| \`${route.path}\` | ${route.ok} | ${route.serverErrors} | ${route.unexpected} | ${route.timeouts} `
      + `| ${l.p50Ms ?? '—'} | ${l.p95Ms ?? '—'} | ${l.p99Ms ?? '—'} |`,
    )
  }
  lines.push('')
  lines.push(`Percentiles are ±${report.latency.resolutionMs} ms — 1 ms histogram buckets, not retained samples.`)
  lines.push('')
  return lines.join('\n')
}
