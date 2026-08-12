import { describe, expect, it } from 'vitest'
import { DEFAULT_LOAD_CONFIG, LOAD_EXIT_CODES, SMOKE_LOAD_CONFIG } from '../../../../scripts/load/config'
import { HISTOGRAM_CEILING_MS, LatencyHistogram } from '../../../../scripts/load/histogram'
import {
  assertNoSecrets,
  buildLoadReport,
  renderLoadReportMarkdown,
  type LoadRunInput,
  type ObservabilitySample,
  type RouteOutcome,
} from '../../../../scripts/load/report'

/**
 * Plan 55 phase 0 — the histogram and the verdict.
 *
 * Two things are being protected here. That the percentiles are honest, because every threshold decision
 * rests on them. And that the artifact is safe to attach to a ticket, because it is assembled from URLs
 * that carry passwords.
 */
describe('LatencyHistogram', () => {
  it('is constant-size regardless of run length', () => {
    // 3.2 million samples over a two-hour soak. Retaining them would consume the 10% RSS budget the report
    // is measuring, and grow monotonically for two hours — making every RSS figure a statement about the
    // runner rather than the app.
    const h = new LatencyHistogram()
    for (let i = 0; i < 200_000; i += 1) h.record(i % 900)
    expect(h.samples).toBe(200_000)
    expect(h.percentileMs(0.95)).toBeGreaterThan(0)
  })

  it('computes nearest-rank percentiles', () => {
    const h = new LatencyHistogram()
    for (let ms = 1; ms <= 100; ms += 1) h.record(ms)
    expect(h.percentileMs(0.5)).toBe(50)
    expect(h.percentileMs(0.95)).toBe(95)
    expect(h.percentileMs(0.99)).toBe(99)
    expect(h.percentileMs(1)).toBe(100)
  })

  it('rounds rather than floors, so percentiles are not biased fast', () => {
    // Flooring shifts every percentile down by up to a millisecond, systematically, in the direction that
    // makes a run look better than it was. On a threshold decision that is the wrong way to be wrong.
    const h = new LatencyHistogram()
    h.record(1.6)
    expect(h.percentileMs(1)).toBe(2)
  })

  it('caps at the request timeout, because anything slower is a timeout not a sample', () => {
    const h = new LatencyHistogram()
    h.record(99_999)
    expect(h.percentileMs(1)).toBe(HISTOGRAM_CEILING_MS)
  })

  it('returns null for an empty histogram rather than zero', () => {
    // Zero would read as "instant". A route with no samples was never exercised, which is a fixture defect
    // the report has to be able to show.
    const h = new LatencyHistogram()
    expect(h.percentileMs(0.95)).toBeNull()
    expect(h.summary().p95Ms).toBeNull()
  })

  it('merges without losing count, sum or max', () => {
    const a = new LatencyHistogram()
    const b = new LatencyHistogram()
    a.record(10); a.record(20)
    b.record(30)
    a.merge(b)
    expect(a.samples).toBe(3)
    expect(a.maxObservedMs).toBe(30)
    expect(Math.round(a.meanMs)).toBe(20)
  })

  it('rejects a percentile outside (0, 1]', () => {
    const h = new LatencyHistogram()
    for (const q of [0, -0.1, 1.01, 2]) expect(() => h.percentileMs(q)).toThrow(RangeError)
  })

  it('ignores a negative or non-finite duration instead of corrupting the buckets', () => {
    const h = new LatencyHistogram()
    h.record(-5); h.record(Number.NaN); h.record(Number.POSITIVE_INFINITY)
    expect(h.samples).toBe(0)
  })
})

function route(over: Partial<RouteOutcome> = {}): RouteOutcome {
  const h = new LatencyHistogram()
  for (let ms = 1; ms <= 100; ms += 1) h.record(ms)
  return { path: '/api/dashboard/overview', ok: 100, serverErrors: 0, unexpected: 0, timeouts: 0, latency: h.summary(), ...over }
}

function sample(over: Partial<ObservabilitySample> = {}): ObservabilitySample {
  return {
    postgresConnections: 40,
    pgBouncerBackends: 30,
    pgBouncerClientsWaiting: 0,
    pgBouncerMaxWaitMs: 0,
    processRssBytes: 200 * 1024 * 1024,
    ...over,
  }
}

function input(over: Partial<LoadRunInput> = {}): LoadRunInput {
  return {
    runId: 'load-20260811093000-smoke',
    poolMode: 'direct',
    commit: 'abc1234',
    startedAt: '2026-08-11T09:30:00.000Z',
    endedAt: '2026-08-11T09:30:30.000Z',
    config: SMOKE_LOAD_CONFIG,
    routes: [route()],
    samples: [sample(), sample()],
    ...over,
  }
}

describe('buildLoadReport', () => {
  it('passes a clean smoke run and returns exit code 0', () => {
    const report = buildLoadReport(input())
    expect(report.verdict).toBe('pass')
    expect(report.exitCode).toBe(LOAD_EXIT_CODES.pass)
    expect(report.checks.every((c) => c.pass)).toBe(true)
  })

  it('fails a p95 over budget and says so in the check, not only in the verdict', () => {
    const slow = new LatencyHistogram()
    for (let i = 0; i < 100; i += 1) slow.record(2_000)
    const report = buildLoadReport(input({ routes: [route({ latency: slow.summary() })] }))
    expect(report.verdict).toBe('fail')
    expect(report.exitCode).toBe(LOAD_EXIT_CODES.thresholdBreach)
    const p95 = report.checks.find((c) => c.metric === 'HTTP p95')
    expect(p95?.pass).toBe(false)
    expect(p95?.observed).toBe('2000')
  })

  it('counts timeouts as unexpected, not as slow successes', () => {
    // A request that never answered is not a success with a latency. Folding it into the latency figures
    // would make a run that timed out look faster than one that answered slowly.
    const report = buildLoadReport(input({ routes: [route({ ok: 0, timeouts: 100 })] }))
    const check = report.checks.find((c) => c.metric.startsWith('unexpected non-2xx'))
    expect(check?.pass).toBe(false)
    expect(report.totals.timeouts).toBe(100)
  })

  it('treats a route with no samples as a failure rather than a pass', () => {
    // A percentile of `null` is a fixture defect. Passing it over is how a certification certifies an
    // endpoint that was never called.
    const empty = new LatencyHistogram().summary()
    const report = buildLoadReport(input({ routes: [route({ ok: 0, latency: empty })] }))
    expect(report.verdict).toBe('fail')
    expect(report.checks.find((c) => c.metric === 'HTTP p95')?.observed).toBe('no samples')
  })

  it('does not evaluate thresholds for an aborted run', () => {
    /**
     * The distinction the exit codes exist for.
     *
     * An aborted run produced no steady-state window, so its latency figures describe a ramp. Calling that
     * a failed certification sends somebody looking for a slow query when the fixtures never validated.
     */
    const report = buildLoadReport(input({ abortedReason: 'fixture validation failed on /api/recommendations' }))
    expect(report.verdict).toBe('aborted')
    expect(report.exitCode).toBe(LOAD_EXIT_CODES.aborted)
    expect(report.checks).toEqual([])
  })

  it('asserts PgBouncer thresholds only for the pooled topology', () => {
    // A red line about a component that is not in the path would make a direct baseline unreadable.
    const direct = buildLoadReport(input({ poolMode: 'direct' }))
    expect(direct.checks.some((c) => c.metric.startsWith('PgBouncer'))).toBe(false)

    const pooled = buildLoadReport(input({ poolMode: 'transaction', config: DEFAULT_LOAD_CONFIG }))
    expect(pooled.checks.some((c) => c.metric === 'PgBouncer backends')).toBe(true)
  })

  it('fails pooled wait compliance when too few samples are clean', () => {
    const samples = [
      ...Array.from({ length: 10 }, () => sample({ pgBouncerClientsWaiting: 3, pgBouncerMaxWaitMs: 120 })),
      ...Array.from({ length: 10 }, () => sample()),
    ]
    const report = buildLoadReport(input({ poolMode: 'transaction', config: DEFAULT_LOAD_CONFIG, samples }))
    const check = report.checks.find((c) => c.metric === 'PgBouncer wait compliance')
    expect(check?.pass).toBe(false)
    expect(check?.observed).toBe('50.000%')
  })

  it('reports RSS growth only from minute 15, and null when the run is too short', () => {
    // The first fifteen minutes are the ramp and the JIT warming up. Measuring from sample zero reports a
    // growth every healthy run has and turns the leak threshold into noise.
    expect(buildLoadReport(input()).rssGrowthRatio).toBeNull()

    const long = Array.from({ length: 200 }, (_, i) => sample({ processRssBytes: (200 + i) * 1024 * 1024 }))
    const report = buildLoadReport(input({ samples: long }))
    expect(report.rssGrowthRatio).not.toBeNull()
  })
})

describe('assertNoSecrets', () => {
  it('refuses a report carrying a connection string', () => {
    // Redaction happens when the report is built, not when it is printed — a printer that redacts leaves
    // the secret in the object a later `JSON.stringify` elsewhere will write out.
    expect(() => assertNoSecrets({ target: 'postgresql://postgres:pw@127.0.0.1/db' })).toThrow(/postgresql:\/\//)
  })

  it('refuses a cookie or an authorization header', () => {
    expect(() => assertNoSecrets({ headers: { 'Set-Cookie': 'session=abc' } })).toThrow(/set-cookie/)
    expect(() => assertNoSecrets({ headers: { Authorization: 'Bearer x' } })).toThrow(/authorization/)
  })

  it('refuses a Stripe key by prefix', () => {
    expect(() => assertNoSecrets({ note: 'sk_test_deadbeef' })).toThrow(/sk_/)
    expect(() => assertNoSecrets({ note: 'whsec_deadbeef' })).toThrow(/whsec_/)
  })

  it('catches a marker in a key name, not only in a value', () => {
    // A field named `password` holding a redacted string is still a field somebody fills in later.
    expect(() => assertNoSecrets({ password: '[redacted]' })).toThrow(/password/)
  })

  it('runs as part of building the report, not as an optional step', () => {
    const poisoned = input({ runId: 'postgres://leak' })
    expect(() => buildLoadReport(poisoned)).toThrow(/refusing to emit/)
  })
})

describe('renderLoadReportMarkdown', () => {
  it('prints every failed check rather than summarising', () => {
    // "No silent caps": printing only the first failure lets a reader believe one thing was wrong when four
    // were.
    const slow = new LatencyHistogram()
    for (let i = 0; i < 100; i += 1) slow.record(5_000)
    const report = buildLoadReport(input({ routes: [route({ latency: slow.summary(), ok: 0, serverErrors: 100 })] }))
    const md = renderLoadReportMarkdown(report)
    const failed = report.checks.filter((c) => !c.pass)
    expect(failed.length).toBeGreaterThan(1)
    for (const c of failed) expect(md).toContain(c.metric)
  })

  it('states the histogram resolution so a percentile is not read as exact', () => {
    expect(renderLoadReportMarkdown(buildLoadReport(input()))).toMatch(/±1 ms/)
  })

  it('says an aborted run has no verdict', () => {
    const md = renderLoadReportMarkdown(buildLoadReport(input({ abortedReason: 'host unreachable' })))
    expect(md).toContain('no thresholds were evaluated')
    expect(md).toContain('not a')
  })

  it('names the pool mode, because the same numbers mean different things', () => {
    expect(renderLoadReportMarkdown(buildLoadReport(input({ poolMode: 'direct' })))).toContain('`direct`')
  })
})
