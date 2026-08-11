import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adminMetricSectionSchema,
  ADMIN_METRIC_LIMITS,
  ROUTE_FAMILIES,
} from '../../../../../src/shared/lib/admin-metrics/contracts'
import { emptyHistogram, observe } from '../../../../../src/shared/lib/admin-metrics/history'
import type { FamilyWindow, ServiceMetricWindow } from '../../../../../src/shared/lib/repositories/service-metrics'

/**
 * Plan 57, Admin track — the two sections the historical store turned from `insufficient_history` into real
 * answers.
 *
 * Every assertion here is about a *lie a metrics page could tell*, not about plumbing: a zero that reads as
 * an outage, a rate divided by nothing, a percentile invented inside a bucket, a ranking longer than the
 * contract's cap, and a process counter presented as a platform total.
 */

/**
 * A mutable stub for `env`, because the real module freezes its parse at import.
 *
 * Setting `process.env.SCHEDULING_ENABLED` in a case changes nothing the section can see — `env.ts` parsed the
 * environment once, before the test ran. The stub is an object the cases mutate, and it is reset per case so one
 * capability left on cannot make the next case pass for the wrong reason.
 */
const envStub: Record<string, string> = {}

const mocks = vi.hoisted(() => ({
  countUnresolvedIncidents: vi.fn(),
  getRemovalOperationsMetrics: vi.fn(),
  countAbuseSignalsBySeverity: vi.fn(),
  countBillingWebhookEventsByStatus: vi.fn(),
  listScheduleRegistry: vi.fn(),
  listLatestJobRuns: vi.fn(),
  listSearchSources: vi.fn(),
  listSolutionSources: vi.fn(),
  readServiceMetricWindow: vi.fn(),
  readServiceMetricFreshness: vi.fn(),
  getPlatformAccountMetrics: vi.fn(),
  getOnboardingActivationMetrics: vi.fn(),
  getDiscoveryState: vi.fn(),
}))

vi.mock('../../../../../src/shared/lib/repositories/service-metrics', () => ({
  readServiceMetricWindow: mocks.readServiceMetricWindow,
  readServiceMetricFreshness: mocks.readServiceMetricFreshness,
}))
vi.mock('../../../../../src/shared/lib/repositories/platform-billing', () => ({
  getPlatformAccountMetrics: mocks.getPlatformAccountMetrics,
  getOnboardingActivationMetrics: mocks.getOnboardingActivationMetrics,
}))
vi.mock('../../../../../src/shared/lib/repositories/discovery-state', () => ({
  getDiscoveryState: mocks.getDiscoveryState,
}))
vi.mock('../../../../../src/shared/lib/repositories/platform-operations', () => ({
  listScheduleRegistry: mocks.listScheduleRegistry,
  listLatestJobRuns: mocks.listLatestJobRuns,
}))
vi.mock('../../../../../src/shared/lib/repositories/search-sources', () => ({
  listSearchSources: mocks.listSearchSources,
}))
vi.mock('../../../../../src/shared/lib/repositories/solution-catalog', () => ({
  listSolutionSources: mocks.listSolutionSources,
}))
vi.mock('../../../../../src/shared/lib/repositories/profile-removal', () => ({
  getRemovalOperationsMetrics: mocks.getRemovalOperationsMetrics,
}))
vi.mock('../../../../../src/shared/lib/repositories/abuse-signals', () => ({
  countAbuseSignalsBySeverity: mocks.countAbuseSignalsBySeverity,
}))
vi.mock('../../../../../src/shared/lib/repositories/billing-events', () => ({
  countBillingWebhookEventsByStatus: mocks.countBillingWebhookEventsByStatus,
}))
vi.mock('../../../../../src/shared/lib/repositories/platform-content', () => ({
  countUnresolvedIncidents: mocks.countUnresolvedIncidents,
}))
/**
 * Partial, not wholesale.
 *
 * Replacing the whole module broke the moment this file's import graph grew: the operations section reads the
 * source registers, those reach `site-url.ts`, and that imports `ensureProtocol` from here — which a
 * `{ env }`-only mock does not provide, so the suite failed to load rather than failing an assertion. Spreading
 * the original keeps every other export real and overrides exactly the one thing a case needs to control.
 */
vi.mock('../../../../../src/shared/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../src/shared/lib/env')>()),
  env: envStub,
}))

const { buildSection } = await import('../../../../../src/shared/lib/admin-metrics/sections')

const NOW = new Date('2026-08-11T12:00:00.000Z')

function family(overrides: Partial<FamilyWindow> & { routeFamily: FamilyWindow['routeFamily'] }): FamilyWindow {
  return {
    requests: 0,
    errors: 0,
    searches: 0,
    searchCacheHits: 0,
    latencyBuckets: emptyHistogram(),
    ...overrides,
  }
}

/**
 * A window whose totals are derived from its families, so a case cannot state a total that contradicts the
 * rows it also states. The percentiles default to `null` — the latency case overrides them explicitly,
 * because that is the one place the relationship between a histogram and a percentile is under test.
 */
function windowOf(families: FamilyWindow[]): ServiceMetricWindow {
  const sum = (pick: (f: FamilyWindow) => number) => families.reduce((total, f) => total + pick(f), 0)
  return {
    from: new Date(NOW.getTime() - 86_400_000),
    to: NOW,
    instances: 2,
    families,
    totals: {
      requests: sum((f) => f.requests),
      errors: sum((f) => f.errors),
      searches: sum((f) => f.searches),
      searchCacheHits: sum((f) => f.searchCacheHits),
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      overflow: false,
    },
  }
}

/** Reads a value out of a ready/partial payload, or fails the assertion by returning undefined. */
function valueOf(payload: unknown, key: string): number | undefined {
  const data = (payload as { data?: { values: { key: string; value: number }[] } }).data
  return data?.values.find((entry) => entry.key === key)?.value
}

function parsed(payload: unknown) {
  // Every case parses the payload: a section that does not satisfy its own contract is not a passing case,
  // however plausible the numbers look.
  return adminMetricSectionSchema.parse(payload)
}

beforeEach(() => {
  mocks.readServiceMetricWindow.mockReset()
  mocks.readServiceMetricFreshness.mockReset()
  mocks.getPlatformAccountMetrics.mockReset()
  mocks.getOnboardingActivationMetrics.mockReset()
  for (const key of Object.keys(envStub)) delete envStub[key]
  mocks.listScheduleRegistry.mockReset()
  mocks.listLatestJobRuns.mockReset()
  mocks.listSearchSources.mockReset()
  mocks.listSolutionSources.mockReset()
  mocks.getRemovalOperationsMetrics.mockReset()
  mocks.countAbuseSignalsBySeverity.mockReset()
  mocks.countBillingWebhookEventsByStatus.mockReset()
  mocks.countUnresolvedIncidents.mockReset()
})

describe('traffic', () => {
  it('says insufficient_history rather than zero when the window has no rows', async () => {
    /**
     * The lie this whole plan is about. An empty window is a window before the store began, or a store
     * nobody is writing — and "requests: 0, errors: 0" renders as a healthy idle platform either way.
     */
    mocks.readServiceMetricWindow.mockResolvedValue(windowOf([]))
    const payload = parsed(await buildSection({ section: 'traffic', range: '24h', variant: 'rate', now: NOW }))
    expect(payload.status).toBe('unavailable')
    expect(payload).toMatchObject({ code: 'insufficient_history' })
  })

  it('reports a database-scoped platform total, with the instance count beside it', async () => {
    // The scope claim the storage earns: rows are per-instance and the query sums them, so unlike
    // `metrics.get()` this really is the platform's number.
    mocks.readServiceMetricWindow.mockResolvedValue(
      windowOf([family({ routeFamily: 'api.search', requests: 900 }), family({ routeFamily: 'api.admin', requests: 100, errors: 5 })]),
    )
    const payload = parsed(await buildSection({ section: 'traffic', range: '24h', variant: 'rate', now: NOW }))
    expect(payload.status).toBe('ready')
    expect(valueOf(payload, 'requests')).toBe(1000)
    expect(valueOf(payload, 'errors')).toBe(5)
    expect(valueOf(payload, 'instances_reporting')).toBe(2)

    const requests = (payload as { data: { values: { key: string; scope: string; platformTotal?: boolean }[] } }).data.values
      .find((v) => v.key === 'requests')
    expect(requests?.scope).toBe('database')
    expect(requests?.platformTotal).toBe(true)
  })

  it('omits the error rate rather than reporting 0 % over an empty denominator', async () => {
    // 0 errors out of 0 requests is undefined, and `0 %` next to an empty window reads as a clean bill of
    // health. The families exist (so the section is not `unavailable`) but carry no requests.
    mocks.readServiceMetricWindow.mockResolvedValue(windowOf([family({ routeFamily: 'api.search' })]))
    const payload = parsed(await buildSection({ section: 'traffic', range: '24h', variant: 'errors', now: NOW }))
    expect(valueOf(payload, 'error_rate')).toBeUndefined()
  })

  it('carries a direction-checked threshold on the error rate', async () => {
    mocks.readServiceMetricWindow.mockResolvedValue(
      windowOf([family({ routeFamily: 'api.search', requests: 200, errors: 4 })]),
    )
    const payload = parsed(await buildSection({ section: 'traffic', range: '24h', variant: 'errors', now: NOW }))
    expect(valueOf(payload, 'error_rate')).toBeCloseTo(0.02)
    const rate = (payload as { data: { values: { key: string; threshold?: { direction: string } }[] } }).data.values
      .find((v) => v.key === 'error_rate')
    expect(rate?.threshold?.direction).toBe('higher_is_worse')
  })

  it('ranks by errors under the errors variant and by requests under rate', async () => {
    /**
     * The variant is not cosmetic: a URL that says `errors` must not render the request ranking. An operator
     * sharing that URL would send somebody to a different view than the one they were reading.
     */
    const families = [
      family({ routeFamily: 'api.search', requests: 1000, errors: 1 }),
      family({ routeFamily: 'api.billing', requests: 10, errors: 9 }),
    ]
    mocks.readServiceMetricWindow.mockResolvedValue(windowOf(families))
    const byRate = parsed(await buildSection({ section: 'traffic', range: '24h', variant: 'rate', now: NOW }))
    mocks.readServiceMetricWindow.mockResolvedValue(windowOf(families))
    const byErrors = parsed(await buildSection({ section: 'traffic', range: '24h', variant: 'errors', now: NOW }))

    const top = (p: unknown) => (p as { data: { ranked?: { family: string }[] } }).data.ranked?.[0]?.family
    expect(top(byRate)).toBe('api.search')
    expect(top(byErrors)).toBe('api.billing')
  })

  it('never returns more ranked rows than the contract allows, even with every family present', async () => {
    // Fourteen families, ten rows. The cap is the design; the parse is what proves it is applied before the
    // payload leaves rather than trusted downstream.
    mocks.readServiceMetricWindow.mockResolvedValue(
      windowOf(ROUTE_FAMILIES.map((routeFamily, index) => family({ routeFamily, requests: index + 1 }))),
    )
    const payload = parsed(await buildSection({ section: 'traffic', range: '24h', variant: 'rate', now: NOW }))
    const ranked = (payload as { data: { ranked?: unknown[] } }).data.ranked
    expect(ranked).toHaveLength(ADMIN_METRIC_LIMITS.rankedRows)
  })

  it('drops families with nothing in them instead of padding the ranking with zeroes', async () => {
    mocks.readServiceMetricWindow.mockResolvedValue(
      windowOf([family({ routeFamily: 'api.search', requests: 5 }), family({ routeFamily: 'api.billing' })]),
    )
    const payload = parsed(await buildSection({ section: 'traffic', range: '24h', variant: 'rate', now: NOW }))
    expect((payload as { data: { ranked?: unknown[] } }).data.ranked).toHaveLength(1)
  })

  it('reports the boundary for a percentile and a count for what overflowed it', async () => {
    /**
     * Two honesty rules in one case.
     *
     * A percentile is reported as the bucket boundary, never interpolated inside it — there is no
     * information about where in the bucket the value sat. And when the answer is past the last boundary
     * there is no number at all, so `requests_over_10s` says how many were slower instead. An absent
     * `p99_ms` is explained by its sibling rather than being a hole.
     */
    const slow = emptyHistogram()
    for (let i = 0; i < 99; i += 1) observe(slow, 80)
    observe(slow, 45_000)
    const read = windowOf([family({ routeFamily: 'api.search', requests: 100, latencyBuckets: slow })])
    read.totals = { ...read.totals, p50Ms: 100, p95Ms: 100, p99Ms: null, overflow: true }
    mocks.readServiceMetricWindow.mockResolvedValue(read)

    const payload = parsed(await buildSection({ section: 'traffic', range: '24h', variant: 'latency', now: NOW }))
    expect(valueOf(payload, 'latency_p95_ms')).toBe(100)
    expect(valueOf(payload, 'latency_p99_ms')).toBeUndefined()
    expect(valueOf(payload, 'requests_over_10s')).toBe(1)
  })

  it('answers `error` rather than throwing when the read fails', async () => {
    // One section failing must leave the others readable — that is the entire point of the split.
    mocks.readServiceMetricWindow.mockRejectedValue(new Error('57014: canceling statement due to statement timeout'))
    const payload = parsed(await buildSection({ section: 'traffic', range: '24h', variant: 'rate', now: NOW }))
    expect(payload).toMatchObject({ status: 'unavailable', code: 'error' })
  })
})

describe('search', () => {
  it('says insufficient_history rather than a 0 % hit rate when nothing was searched', async () => {
    mocks.readServiceMetricWindow.mockResolvedValue(windowOf([family({ routeFamily: 'api.search', requests: 40 })]))
    const payload = parsed(await buildSection({ section: 'search', range: '24h', variant: 'quality', now: NOW }))
    expect(payload).toMatchObject({ status: 'unavailable', code: 'insufficient_history' })
  })

  it('reports the hit rate only under the quality variant', async () => {
    const read = () => windowOf([family({ routeFamily: 'api.search', searches: 200, searchCacheHits: 150 })])
    mocks.readServiceMetricWindow.mockResolvedValue(read())
    const volume = parsed(await buildSection({ section: 'search', range: '24h', variant: 'volume', now: NOW }))
    expect(valueOf(volume, 'searches')).toBe(200)
    expect(valueOf(volume, 'search_cache_hit_rate')).toBeUndefined()

    mocks.readServiceMetricWindow.mockResolvedValue(read())
    const quality = parsed(await buildSection({ section: 'search', range: '24h', variant: 'quality', now: NOW }))
    expect(valueOf(quality, 'search_cache_hit_rate')).toBe(0.75)
  })

  it('marks a cold cache as lower_is_worse, not as an error', async () => {
    // A cold cache is slow and expensive, not broken. Getting the direction wrong here would make a warning
    // fire on a *healthy* cache and never fire on a cold one.
    mocks.readServiceMetricWindow.mockResolvedValue(
      windowOf([family({ routeFamily: 'api.search', searches: 100, searchCacheHits: 2 })]),
    )
    const payload = parsed(await buildSection({ section: 'search', range: '24h', variant: 'quality', now: NOW }))
    const rate = (payload as { data: { values: { key: string; threshold?: { direction: string } }[] } }).data.values
      .find((v) => v.key === 'search_cache_hit_rate')
    expect(rate?.threshold?.direction).toBe('lower_is_worse')
  })
})

describe('the section that still has no source', () => {
  it('keeps conversion at insufficient_history', async () => {
    /**
     * Not an oversight, and not something to fill with zeroes now that a store exists. Conversion cohorts need
     * billing events bucketed by signup cohort, which is not a request counter, so it is not answerable from
     * `service_metric_buckets`.
     *
     * Reliability was beside it here until the interview counters gave it a real source — see the reliability
     * block below, where `not_enabled` and `insufficient_history` now mean two different things on the two
     * variants.
     */
    const payload = parsed(await buildSection({ section: 'conversion', range: '24h', variant: 'funnel', now: NOW }))
    expect(payload).toMatchObject({ status: 'unavailable', code: 'insufficient_history' })
    // And it did not reach the store at all, which is what makes it free.
    expect(mocks.readServiceMetricWindow).not.toHaveBeenCalled()
  })
})

describe('runtime, next to the sections that are platform-wide', () => {
  it('marks every counter as process-scoped with an identity, and never as a platform total', async () => {
    /**
     * The bug the contract's scope rule exists for. These counters start at zero when the process starts,
     * they are per-instance, and a deploy resets them — so rendering them beside Overview's database totals
     * without a scope is the sentence "this instance's counter is the platform's number".
     */
    const payload = parsed(await buildSection({ section: 'runtime', range: '24h', variant: 'process', now: NOW }))
    const values = (payload as { data: { values: { scope: string; platformTotal?: boolean; processIdentity?: unknown }[] } }).data.values
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      expect(value.scope).toBe('process')
      expect(value.platformTotal).toBeUndefined()
      expect(value.processIdentity).toBeDefined()
    }
  })
})

describe('the window, when its start comes from another clock', () => {
  it('falls back to the range instead of emitting a window the contract refuses', async () => {
    /**
     * Found by the case above, and a real hazard rather than a test artifact.
     *
     * Runtime derives `from` from `process.uptime()` and discovery from the worker's persisted `lastRunAt` —
     * neither is the clock `now` came from. `from > to` fails the contract's own refinement, so the payload
     * would not parse and the section would answer 500 rather than render. A section that cannot fail alone
     * defeats the split.
     */
    const payload = parsed(
      await buildSection({ section: 'runtime', range: '1h', variant: 'process', now: new Date('2020-01-01T00:00:00.000Z') }),
    )
    const window = (payload as { window: { from: string; to: string } }).window
    expect(new Date(window.from).getTime()).toBeLessThan(new Date(window.to).getTime())
    // The range, not the process start, because the process start was not usable.
    expect(window.from).toBe('2019-12-31T23:00:00.000Z')
  })

  it('still prefers a usable supplied start, so discovery keeps reporting the worker run', async () => {
    // The fallback must not swallow the legitimate case: discovery's window is deliberately the worker's
    // last run rather than the asked-for range, because these are state and not a windowed aggregate.
    mocks.getDiscoveryState.mockResolvedValue({
      lastRunAt: new Date('2026-08-11T09:30:00.000Z'),
      stats: { cellsScanned: 12, profilesSeen: 40, profilesStored: 7 },
    })
    const payload = parsed(await buildSection({ section: 'discovery', range: '24h', variant: 'coverage', now: NOW }))
    expect((payload as { window: { from: string } }).window.from).toBe('2026-08-11T09:30:00.000Z')
    expect(valueOf(payload, 'discovery_profiles_stored')).toBe(7)
  })
})

describe('the comparison window', () => {
  it('reads a window of equal length immediately before, and never a longer one', async () => {
    /**
     * Comparing a 24-hour figure against a 30-day one is a comparison of two different questions, and the
     * difference reads as a change in traffic. Asserted on the *arguments*, because getting this wrong
     * produces numbers that are individually correct and jointly meaningless — nothing about the payload
     * would look wrong.
     */
    mocks.readServiceMetricWindow.mockResolvedValue(
      windowOf([family({ routeFamily: 'api.search', requests: 100 })]),
    )
    // `7d`, deliberately not the default `24h`: with a 24-hour range a hard-coded one-day span would satisfy
    // every assertion here and the bug would ship. The case has to ask for a window the wrong answer cannot
    // accidentally match.
    await buildSection({ section: 'traffic', range: '7d', variant: 'rate', now: NOW, compare: true })

    expect(mocks.readServiceMetricWindow).toHaveBeenCalledTimes(2)
    const [currentFrom, currentTo] = mocks.readServiceMetricWindow.mock.calls[0]
    const [earlierFrom, earlierTo] = mocks.readServiceMetricWindow.mock.calls[1]
    // Adjacent: the earlier window ends exactly where the current one begins, with no gap and no overlap.
    expect(earlierTo.getTime()).toBe(currentFrom.getTime())
    // And the same length.
    expect(earlierTo.getTime() - earlierFrom.getTime()).toBe(currentTo.getTime() - currentFrom.getTime())
  })

  it('does not read a second window when nobody asked', async () => {
    // It doubles the cost of a section that sits on a refresh timer.
    mocks.readServiceMetricWindow.mockResolvedValue(windowOf([family({ routeFamily: 'api.search', requests: 1 })]))
    await buildSection({ section: 'traffic', range: '24h', variant: 'rate', now: NOW })
    expect(mocks.readServiceMetricWindow).toHaveBeenCalledTimes(1)
  })

  it('omits `previous` for a rate whose earlier denominator was empty', async () => {
    /**
     * "was 0 %" beside a window that served nothing is the same lie the current-window rate already refuses:
     * 0 errors out of 0 requests is undefined, not clean.
     */
    mocks.readServiceMetricWindow
      .mockResolvedValueOnce(windowOf([family({ routeFamily: 'api.search', requests: 200, errors: 4 })]))
      .mockResolvedValueOnce(windowOf([family({ routeFamily: 'api.search' })]))
    const payload = parsed(
      await buildSection({ section: 'traffic', range: '24h', variant: 'errors', now: NOW, compare: true }),
    )
    const rate = (payload as { data: { values: { key: string; value: number; previous?: number }[] } }).data.values
      .find((v) => v.key === 'error_rate')
    expect(rate?.value).toBeCloseTo(0.02)
    expect(rate?.previous).toBeUndefined()
  })

  it('keeps the section readable when only the comparison read fails', async () => {
    // The comparison is an extra; losing it must cost the operator the comparison, not the numbers.
    mocks.readServiceMetricWindow
      .mockResolvedValueOnce(windowOf([family({ routeFamily: 'api.search', requests: 50 })]))
      .mockRejectedValueOnce(new Error('57014: canceling statement due to statement timeout'))
    const payload = parsed(
      await buildSection({ section: 'traffic', range: '24h', variant: 'rate', now: NOW, compare: true }),
    )
    expect(payload.status).toBe('ready')
    expect(valueOf(payload, 'requests')).toBe(50)
  })
})

describe('data freshness', () => {
  it('reports instances reporting even with an empty store, because zero is the answer', async () => {
    /**
     * "Nothing is writing" is the state that otherwise looks exactly like no traffic. It is the one value in
     * this variant that is unconditional — the lag figures are genuinely absent before the first minute is
     * written, and inventing a lag of zero would say the data is current when there is none.
     */
    mocks.readServiceMetricFreshness.mockResolvedValue({
      newestBucketStart: null,
      oldestBucketStart: null,
      reportingInstances: 0,
    })
    const payload = parsed(await buildSection({ section: 'runtime', range: '24h', variant: 'freshness', now: NOW }))
    expect(payload.status).toBe('ready')
    expect(valueOf(payload, 'reporting_instances')).toBe(0)
    expect(valueOf(payload, 'metric_lag_seconds')).toBeUndefined()
    expect(valueOf(payload, 'history_span_seconds')).toBeUndefined()
  })

  it('states the lag in seconds rather than a timestamp the reader has to subtract', async () => {
    mocks.readServiceMetricFreshness.mockResolvedValue({
      newestBucketStart: new Date(NOW.getTime() - 95_000),
      oldestBucketStart: new Date(NOW.getTime() - 3 * 86_400_000),
      reportingInstances: 2,
    })
    const payload = parsed(await buildSection({ section: 'runtime', range: '24h', variant: 'freshness', now: NOW }))
    expect(valueOf(payload, 'metric_lag_seconds')).toBe(95)
    expect(valueOf(payload, 'history_span_seconds')).toBe(3 * 86_400)

    // ~90 s of lag is normal operation: the flush runs every 30 s and holds the minute in progress back.
    const lag = (payload as { data: { values: { key: string; threshold?: { warn: number } }[] } }).data.values
      .find((v) => v.key === 'metric_lag_seconds')
    expect(lag?.threshold?.warn).toBe(180)
  })

  it('answers `error` rather than a plausible zero when the freshness read fails', async () => {
    mocks.readServiceMetricFreshness.mockRejectedValue(new Error('boom'))
    const payload = parsed(await buildSection({ section: 'runtime', range: '24h', variant: 'freshness', now: NOW }))
    expect(payload).toMatchObject({ status: 'unavailable', code: 'error' })
  })
})

describe('activation, and the division that must never happen', () => {
  /**
   * Plan 57, Admin track — "Build cohort-correct Acquisition and Activation widgets".
   *
   * The Verify line names five fixtures and one prohibition, and the prohibition is the one worth stating
   * plainly: **a lifetime total is never divided by recent signups.** `onboardingCompleted` counts everyone who
   * has ever finished onboarding, including accounts from before the window; `newUsersLast7d` counts a week. A
   * rate built from those two is a number that can exceed 1 and reads as a percentage.
   */
  const accounts = (overrides: Partial<{ totalUsers: number; newUsersLast24h: number; newUsersLast7d: number }> = {}) => ({
    totalUsers: 5_000,
    newUsersLast24h: 4,
    newUsersLast7d: 40,
    ...overrides,
  })
  const onboarding = (overrides: Partial<{ onboardingCompleted: number; onboardingSkipped: number; onboardingCompletedLast7d: number }> = {}) => ({
    onboardingCompleted: 4_800,
    onboardingSkipped: 120,
    onboardingCompletedLast7d: 10,
    ...overrides,
  })

  it('divides the window cohort by the window cohort, not by the lifetime total', async () => {
    mocks.getPlatformAccountMetrics.mockResolvedValue(accounts())
    mocks.getOnboardingActivationMetrics.mockResolvedValue(onboarding())

    const payload = parsed(await buildSection({ section: 'activation', range: '7d', variant: 'funnel', now: NOW }))
    // 10 of the 40 accounts created in the window finished onboarding.
    expect(valueOf(payload, 'activation_rate_7d')).toBeCloseTo(0.25)
    // And emphatically not 4800/40, which is 120.
    expect(valueOf(payload, 'activation_rate_7d')).toBeLessThanOrEqual(1)
  })

  it('omits the rate rather than dividing by an empty cohort', async () => {
    /**
     * With no signups in the window the rate is undefined, not `0`. `0%` reads as "nobody activated" when the
     * truth is "nobody signed up" — and the contract has no way to say "null but present", so the value is
     * absent and the section is `partial` with a reason.
     */
    mocks.getPlatformAccountMetrics.mockResolvedValue(accounts({ newUsersLast7d: 0 }))
    mocks.getOnboardingActivationMetrics.mockResolvedValue(onboarding({ onboardingCompletedLast7d: 0 }))

    const payload = parsed(await buildSection({ section: 'activation', range: '7d', variant: 'funnel', now: NOW }))
    expect(payload).toMatchObject({ status: 'partial', code: 'insufficient_history' })
    expect(valueOf(payload, 'activation_rate_7d')).toBeUndefined()
    // The counts it does have are still reported: a missing ratio is not a missing section.
    expect(valueOf(payload, 'users_new_7d')).toBe(0)
  })

  it('reads the seven-day cohort whatever range was asked for, and says so in the window', async () => {
    /**
     * The cohort is documented as seven days, so a `1h` request must not silently produce a one-hour
     * activation rate labelled the same way — an hour-old cohort has barely had time to onboard, and the
     * number would collapse for a reason that is not the product getting worse.
     */
    mocks.getPlatformAccountMetrics.mockResolvedValue(accounts())
    mocks.getOnboardingActivationMetrics.mockResolvedValue(onboarding())

    await buildSection({ section: 'activation', range: '1h', variant: 'funnel', now: NOW })
    const [, weekAgo] = mocks.getPlatformAccountMetrics.mock.calls[0]
    expect(NOW.getTime() - weekAgo.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
    // The key names the cohort it describes, so the label cannot drift from the arithmetic.
    const payload = parsed(await buildSection({ section: 'activation', range: '1h', variant: 'funnel', now: NOW }))
    expect(valueOf(payload, 'activation_rate_7d')).toBeDefined()
  })

  it('never reports a count the platform is not allowed to compute', async () => {
    /**
     * Saved queries, Builders and Notes were three tiles the API hardcoded to `null`, rendering permanent
     * em-dashes. Making them real means giving `builderhunt_platform` unscoped SELECT on tenant tables — saved
     * queries and notes being private workflow content — which is the surveillance the Admin track forbids.
     */
    mocks.getPlatformAccountMetrics.mockResolvedValue(accounts())
    mocks.getOnboardingActivationMetrics.mockResolvedValue(onboarding())
    const payload = parsed(await buildSection({ section: 'activation', range: '7d', variant: 'funnel', now: NOW }))
    for (const forbidden of ['total_saved_queries', 'total_builders', 'total_notes']) {
      expect(valueOf(payload, forbidden), forbidden).toBeUndefined()
    }
  })
})

describe('feature reliability', () => {
  /**
   * Plan 57, Admin track — "Build Feature Reliability metrics with interview signals first".
   *
   * The env module is stubbed rather than the process environment, because `env.ts` freezes its parse at module
   * load: setting `process.env.SCHEDULING_ENABLED` in a test changes nothing the section can see.
   */
  it('says not_enabled rather than a grid of zeros while every capability is off', async () => {
    /**
     * With every door shut nobody can book, upload or transcribe, so every counter is zero *by construction*.
     * Rendering them reads as "no problems" when it means "no traffic is possible" — and `not_enabled` is the
     * contract code that exists for exactly this distinction.
     */
    envStub.CALENDAR_ENABLED = 'false'
    envStub.SCHEDULING_ENABLED = 'false'
    envStub.CANDIDATE_UPLOADS_ENABLED = 'false'
    envStub.INTERVIEW_TRANSCRIPTION_ENABLED = 'false'
    envStub.SENSITIVE_AI_ENABLED = 'false'

    const payload = parsed(await buildSection({ section: 'reliability', range: '24h', variant: 'features', now: NOW }))
    expect(payload).toMatchObject({ status: 'unavailable', code: 'not_enabled' })
  })

  it('reports the counters as process-scoped once any capability is open', async () => {
    // One open door is enough for the numbers to mean something: they can move.
    envStub.SCHEDULING_ENABLED = 'true'
    const payload = parsed(await buildSection({ section: 'reliability', range: '24h', variant: 'features', now: NOW }))
    expect(payload.status).toBe('ready')

    const values = (payload as { data: { values: { key: string; scope: string; platformTotal?: boolean; processIdentity?: unknown }[] } }).data.values
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      // The per-process reset scope the task asks to be labelled: cumulative since boot, one instance's, and a
      // deploy zeroes them.
      expect(value.scope, value.key).toBe('process')
      expect(value.processIdentity, value.key).toBeDefined()
      expect(value.platformTotal, value.key).toBeUndefined()
    }
  })

  it('thresholds the gauge and the must-be-zero counters, and nothing that only accumulates', async () => {
    /**
     * A threshold on an accumulator breaches eventually on any healthy instance that stays up long enough, so
     * "provider errors > 5" is a statement about uptime rather than about health — and an alert that fires on
     * every long-lived process is one an operator learns to ignore.
     *
     * So: the document backlog (a gauge that drains) and the counters where any non-zero value is worth
     * reading. The rest are reported with their scope and no line drawn, because an honest line needs a rate.
     */
    envStub.SCHEDULING_ENABLED = 'true'
    const payload = parsed(await buildSection({ section: 'reliability', range: '24h', variant: 'features', now: NOW }))
    const byKey = new Map(
      (payload as { data: { values: { key: string; threshold?: unknown }[] } }).data.values.map((v) => [v.key, v]),
    )

    for (const key of ['document_backlog', 'document_failures', 'retention_object_failures', 'prohibited_output_refusals', 'usage_variances']) {
      expect(byKey.get(key)?.threshold, key).toBeDefined()
    }
    for (const key of ['provider_errors', 'ai_parse_failures', 'template_fallbacks', 'segments_persisted']) {
      expect(byKey.get(key)?.threshold, key).toBeUndefined()
    }
  })

  it('treats unsupported capture as a support signal rather than an error', async () => {
    /**
     * It counts sessions where the browser could not capture audio — someone on an old browser. A threshold
     * would turn "three people used an old Safari" into an incident, and the capture-mode counters beside it
     * are volume, not health.
     */
    envStub.SCHEDULING_ENABLED = 'true'
    const payload = parsed(await buildSection({ section: 'reliability', range: '24h', variant: 'features', now: NOW }))
    const byKey = new Map(
      (payload as { data: { values: { key: string; threshold?: unknown }[] } }).data.values.map((v) => [v.key, v]),
    )
    for (const key of ['capture_unsupported', 'capture_remote', 'capture_in_person']) {
      expect(byKey.get(key), key).toBeDefined()
      expect(byKey.get(key)?.threshold, key).toBeUndefined()
    }
  })

  it('carries no candidate or interview identifier, whatever the counters hold', async () => {
    // Every value is a counter and every key is static text. That is what makes an interview dashboard safe to
    // look at: a name, filename or transcript line has no path into this payload because it never receives one.
    envStub.SENSITIVE_AI_ENABLED = 'true'
    const payload = parsed(await buildSection({ section: 'reliability', range: '24h', variant: 'features', now: NOW }))
    const values = (payload as { data: { values: { key: string; value: number }[] } }).data.values
    for (const value of values) {
      expect(typeof value.value, value.key).toBe('number')
      expect(value.key).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('keeps the availability variant honest, because nothing samples per-feature availability', async () => {
    envStub.SCHEDULING_ENABLED = 'true'
    const payload = parsed(await buildSection({ section: 'reliability', range: '24h', variant: 'availability', now: NOW }))
    expect(payload).toMatchObject({ status: 'unavailable', code: 'insufficient_history' })
  })
})

describe('operations — workers', () => {
  /**
   * Plan 57, Admin track — "Build Worker and Integration Health admin widgets".
   *
   * Read from the registries `/admin/operations` and `/admin/integrations` already use, so this section cannot
   * disagree with the pages it summarises. That is not a convenience: the projection the Command Center task
   * named reads eight `platform_*` tables that appear in no migration, and `/admin/integrations` once showed two
   * retired sources as ACTIVE because it was assembled from a compile-time registry nobody updated.
   */
  const schedule = (overrides: Partial<{ jobKey: string; enabled: boolean; nextRunAt: Date | null }> = {}) => ({
    id: 'sched',
    jobKey: 'discovery',
    cronExpression: '0 * * * *',
    timezone: 'UTC',
    scope: 'platform',
    enabled: true,
    nextRunAt: new Date(NOW.getTime() + 3_600_000),
    version: 1,
    ...overrides,
  })
  const run = (overrides: Partial<{ jobKey: string; state: string; failedCount: number }> = {}) => ({
    id: 'run',
    jobKey: 'discovery',
    scheduledFor: NOW,
    startedAt: NOW,
    finishedAt: NOW,
    state: 'succeeded',
    processedCount: 10,
    failedCount: 0,
    durationMs: 100,
    errorCode: null,
    ...overrides,
  })

  it('says dependency_unavailable for an empty registry rather than "0 overdue"', async () => {
    /**
     * The registry is migration-managed and synced from a code-owned list, so no rows means the sync has never
     * run — not that this platform has no jobs. "0 overdue" over an empty registry reads as healthy, which is
     * the strongest possible form of the lie this plan is about.
     */
    mocks.listScheduleRegistry.mockResolvedValue([])
    const payload = parsed(await buildSection({ section: 'operations', range: '24h', variant: 'workers', now: NOW }))
    expect(payload).toMatchObject({ status: 'unavailable', code: 'dependency_unavailable' })
    // And it did not go on to read the runs, which is what makes the empty case free.
    expect(mocks.listLatestJobRuns).not.toHaveBeenCalled()
  })

  it('counts a paused schedule as paused and never as overdue', async () => {
    /**
     * A paused schedule has no next run *by design*. Counting it as overdue would make pausing a job — a
     * deliberate operator action — look like a failure, and the operator who paused it would be the one paged.
     */
    /**
     * The paused schedule keeps a `nextRunAt` in the *past*, and that detail is the whole test.
     *
     * `advanceScheduleAfterRun` clears the next run when a schedule is disabled, so a paused job usually has
     * `null` — and with `null` this case passes whether or not the filter respects `enabled`, because the null
     * check excludes it either way. A schedule disabled *between* runs keeps its stale timestamp until the next
     * advance, which is the only shape that can tell the two implementations apart. Written with `null` first,
     * and a deliberate break proved it asserted nothing.
     */
    mocks.listScheduleRegistry.mockResolvedValue([
      schedule({ jobKey: 'paused-job', enabled: false, nextRunAt: new Date(NOW.getTime() - 86_400_000) }),
      schedule({ jobKey: 'healthy' }),
    ])
    mocks.listLatestJobRuns.mockResolvedValue(new Map([['healthy', run({ jobKey: 'healthy' })]]))

    const payload = parsed(await buildSection({ section: 'operations', range: '24h', variant: 'workers', now: NOW }))
    expect(valueOf(payload, 'jobs_registered')).toBe(2)
    expect(valueOf(payload, 'jobs_paused')).toBe(1)
    expect(valueOf(payload, 'jobs_overdue')).toBe(0)
  })

  it('counts an enabled schedule whose next run is in the past as overdue', async () => {
    mocks.listScheduleRegistry.mockResolvedValue([
      schedule({ jobKey: 'late', nextRunAt: new Date(NOW.getTime() - 60_000) }),
      schedule({ jobKey: 'healthy' }),
    ])
    mocks.listLatestJobRuns.mockResolvedValue(new Map())

    const payload = parsed(await buildSection({ section: 'operations', range: '24h', variant: 'workers', now: NOW }))
    expect(valueOf(payload, 'jobs_overdue')).toBe(1)
    // Both are enabled with no run on record, which is dormant rather than failed.
    expect(valueOf(payload, 'jobs_never_ran')).toBe(2)
    expect(valueOf(payload, 'jobs_failed_last_run')).toBe(0)
  })

  it('separates a failed run from a run that finished leaving items behind', async () => {
    /**
     * Two different failures, and the second is the one nobody notices: a run can report `succeeded` while
     * leaving rows unprocessed, so a dashboard that only counts failed *runs* shows green while a backlog
     * accumulates.
     */
    mocks.listScheduleRegistry.mockResolvedValue([schedule({ jobKey: 'a' }), schedule({ jobKey: 'b' })])
    mocks.listLatestJobRuns.mockResolvedValue(
      new Map([
        ['a', run({ jobKey: 'a', state: 'failed' })],
        ['b', run({ jobKey: 'b', state: 'succeeded', failedCount: 7 })],
      ]),
    )

    const payload = parsed(await buildSection({ section: 'operations', range: '24h', variant: 'workers', now: NOW }))
    expect(valueOf(payload, 'jobs_failed_last_run')).toBe(1)
    expect(valueOf(payload, 'job_items_failed_last_run')).toBe(7)
  })

  it('leaves the dormant count unthresholded, because a first occurrence has not arrived yet', async () => {
    // Normal right after a deploy, and a problem only if it persists — which needs a rate this section does not
    // have. Reported without a line drawn rather than alarming on a healthy release.
    mocks.listScheduleRegistry.mockResolvedValue([schedule()])
    mocks.listLatestJobRuns.mockResolvedValue(new Map())
    const payload = parsed(await buildSection({ section: 'operations', range: '24h', variant: 'workers', now: NOW }))
    const byKey = new Map(
      (payload as { data: { values: { key: string; threshold?: unknown }[] } }).data.values.map((v) => [v.key, v]),
    )
    expect(byKey.get('jobs_never_ran')?.threshold).toBeUndefined()
    expect(byKey.get('jobs_overdue')?.threshold).toBeDefined()
  })

  it('answers `error` rather than a plausible zero when the registry read fails', async () => {
    mocks.listScheduleRegistry.mockRejectedValue(new Error('53300: too many connections'))
    const payload = parsed(await buildSection({ section: 'operations', range: '24h', variant: 'workers', now: NOW }))
    expect(payload).toMatchObject({ status: 'unavailable', code: 'error' })
  })
})

describe('operations — integrations', () => {
  const searchSource = (overrides: Partial<{ key: string; enabled: boolean; connectorImplemented: boolean; termsReviewedAt: Date | null }> = {}) => ({
    key: 'github',
    kind: 'official_api',
    label: 'GitHub',
    homepageUrl: 'https://github.com',
    enabled: true,
    connectorImplemented: true,
    allowedHosts: ['github.com'],
    storesPersonalData: false,
    geography: null,
    rateLimitPerHour: null,
    retentionDays: null,
    termsReviewedAt: NOW,
    termsReviewedBy: null,
    registerNotes: null,
    updatedAt: NOW,
    ...overrides,
  })
  const solutionSource = (overrides: Partial<{ key: string; enabled: boolean; termsReviewedAt: Date | null }> = {}) => ({
    key: 'huggingface',
    enabled: true,
    termsReviewedAt: NOW,
    ...overrides,
  })

  it('counts an enabled source with no connector, which looks identical to a healthy one on the register page', async () => {
    /**
     * The number this variant exists for. `enabled` means "the next search will contact it";
     * `connectorImplemented` means there is code to contact it *with*. A row with the first and not the second
     * is a source an operator believes is live and which will never reach anything — and any non-zero value is
     * worth reading, which is why the threshold starts at 1 rather than at a rate.
     */
    mocks.listSearchSources.mockResolvedValue([
      searchSource({ key: 'live' }),
      searchSource({ key: 'switched-on-but-dead', connectorImplemented: false }),
      // Disabled with no connector is fine: nothing will contact it either way.
      searchSource({ key: 'off', enabled: false, connectorImplemented: false }),
    ])
    mocks.listSolutionSources.mockResolvedValue([])

    const payload = parsed(await buildSection({ section: 'operations', range: '24h', variant: 'integrations', now: NOW }))
    expect(valueOf(payload, 'sources_registered')).toBe(3)
    expect(valueOf(payload, 'sources_enabled')).toBe(2)
    expect(valueOf(payload, 'sources_enabled_without_connector')).toBe(1)

    const breach = (payload as { data: { values: { key: string; threshold?: { warn: number } }[] } }).data.values
      .find((v) => v.key === 'sources_enabled_without_connector')
    expect(breach?.threshold?.warn).toBe(1)
  })

  it('counts unreviewed terms across both registers, and only for enabled sources', async () => {
    /**
     * Not paperwork: two of the job feeds say outright that they will suspend API access if a link-back is
     * missing, so an unreviewed enabled source is an obligation taken on without being read. A *disabled* one
     * carries no obligation, which is why it is excluded.
     */
    mocks.listSearchSources.mockResolvedValue([
      searchSource({ key: 'reviewed' }),
      searchSource({ key: 'unreviewed', termsReviewedAt: null }),
      searchSource({ key: 'unreviewed-but-off', enabled: false, termsReviewedAt: null }),
    ])
    mocks.listSolutionSources.mockResolvedValue([solutionSource({ key: 'sol-unreviewed', termsReviewedAt: null })])

    const payload = parsed(await buildSection({ section: 'operations', range: '24h', variant: 'integrations', now: NOW }))
    expect(valueOf(payload, 'sources_enabled_terms_unreviewed')).toBe(2)
  })

  it('answers `error` when either register cannot be read, rather than counting only the half that answered', async () => {
    // Half a register is a wrong total, not a partial one: "13 sources enabled" computed from one of two
    // registers is a number an operator would act on.
    mocks.listSearchSources.mockResolvedValue([searchSource()])
    mocks.listSolutionSources.mockRejectedValue(new Error('57014: canceling statement'))
    const payload = parsed(await buildSection({ section: 'operations', range: '24h', variant: 'integrations', now: NOW }))
    expect(payload).toMatchObject({ status: 'unavailable', code: 'error' })
  })
})

describe('trust, abuse and billing operations', () => {
  /**
   * Plan 57, Admin track — "Build Billing, Abuse, Trust, and User Anomaly admin widgets".
   *
   * The Verify line's list of things that must never reach the API or the DOM — provider payloads, payment data,
   * abuse evidence, subject content, tokens, stack traces — is guaranteed structurally rather than by filtering:
   * the aggregates group and count and select nothing else, so there is no identity to drop.
   */
  it('says not_enabled for removals rather than five zeros while the door is shut', async () => {
    /**
     * The defect the first version of this section shipped with, caught by running it against the real database:
     * five zeros, which render as a clean queue. With `PROFILE_REMOVAL_ENABLED` off nobody can file a request, so
     * every count is zero *by construction* — the same reasoning `/api/admin/metrics` has carried since it was
     * written, where the whole `removals` block is omitted for this exact reason.
     */
    envStub.PROFILE_REMOVAL_ENABLED = 'false'
    const payload = parsed(await buildSection({ section: 'trust', range: '30d', variant: 'removals', now: NOW }))
    expect(payload).toMatchObject({ status: 'unavailable', code: 'not_enabled' })
    // And it did not query, which is what makes a disabled capability free.
    expect(mocks.getRemovalOperationsMetrics).not.toHaveBeenCalled()
  })

  it('warns on a single overdue removal, because a missed deadline is not a long queue', async () => {
    envStub.PROFILE_REMOVAL_ENABLED = 'true'
    mocks.getRemovalOperationsMetrics.mockResolvedValue({
      totalRequests: 12,
      byStatus: { pending: 4, verified: 6, rejected: 1, expired: 1 },
      bySource: [],
      otherSourcesCount: 0,
      pendingAging: { underOneDay: 2, oneToSevenDays: 2, sevenToThirtyDays: 0, overThirtyDays: 0 },
      overduePendingCount: 1,
      activeSuppressions: 3,
      generatedAt: NOW.toISOString(),
    })

    const payload = parsed(await buildSection({ section: 'trust', range: '30d', variant: 'removals', now: NOW }))
    expect(valueOf(payload, 'removal_overdue')).toBe(1)
    const overdue = (payload as { data: { values: { key: string; threshold?: { warn: number } }[] } }).data.values
      .find((v) => v.key === 'removal_overdue')
    // Warned at one: the aging here is a commitment already missed, not a backlog getting long.
    expect(overdue?.threshold?.warn).toBe(1)
  })

  it('reports the abuse distribution and thresholds only the two severities worth waking up for', async () => {
    mocks.countAbuseSignalsBySeverity.mockResolvedValue(
      new Map([['low', 40], ['medium', 12], ['high', 2], ['critical', 1]]),
    )
    const payload = parsed(await buildSection({ section: 'trust', range: '24h', variant: 'abuse', now: NOW }))
    expect(valueOf(payload, 'abuse_signals')).toBe(55)
    const byKey = new Map(
      (payload as { data: { values: { key: string; threshold?: unknown }[] } }).data.values.map((v) => [v.key, v]),
    )
    expect(byKey.get('abuse_signals_critical')?.threshold).toBeDefined()
    expect(byKey.get('abuse_signals_high')?.threshold).toBeDefined()
    // Volume, not health: a busy Tuesday at low severity must not colour the page.
    expect(byKey.get('abuse_signals_low')?.threshold).toBeUndefined()
    expect(byKey.get('abuse_signals_medium')?.threshold).toBeUndefined()
  })

  it('carries no identity, evidence or content from an abuse signal', async () => {
    // Structural: the aggregate groups by severity and selects nothing else, so there is nothing to redact.
    mocks.countAbuseSignalsBySeverity.mockResolvedValue(new Map([['high', 3]]))
    const payload = parsed(await buildSection({ section: 'trust', range: '24h', variant: 'abuse', now: NOW }))
    const serialized = JSON.stringify(payload)
    for (const forbidden of ['userId', 'organizationId', 'requestId', 'details', 'evidence']) {
      expect(serialized, forbidden).not.toContain(forbidden)
    }
  })

  it('separates a dead-lettered billing event from one stuck in processing', async () => {
    /**
     * Two different failures. `failed` is money or an entitlement that did not apply; `processing` means nothing
     * has reported an outcome, which is what a crashed worker looks like and never resolves on its own. Both are
     * warned at one, because a rate would hide the single failure in a busy hour — and that is the one that
     * matters to whoever paid.
     */
    mocks.countBillingWebhookEventsByStatus.mockResolvedValue({
      pending: 3, processing: 2, processed: 900, failed: 1, ignored: 4,
    })
    const payload = parsed(await buildSection({ section: 'trust', range: '24h', variant: 'billing', now: NOW }))
    expect(valueOf(payload, 'billing_events_failed')).toBe(1)
    expect(valueOf(payload, 'billing_events_processing')).toBe(2)
    const byKey = new Map(
      (payload as { data: { values: { key: string; threshold?: { warn: number } }[] } }).data.values.map((v) => [v.key, v]),
    )
    expect(byKey.get('billing_events_failed')?.threshold?.warn).toBe(1)
    expect(byKey.get('billing_events_processing')?.threshold?.warn).toBe(1)
    // Volume: a large processed count is the system working.
    expect(byKey.get('billing_events_processed')?.threshold).toBeUndefined()
  })

  it('answers `error` rather than a plausible zero when any of the three reads fails', async () => {
    envStub.PROFILE_REMOVAL_ENABLED = 'true'
    mocks.getRemovalOperationsMetrics.mockRejectedValue(new Error('57014: canceling statement'))
    mocks.countAbuseSignalsBySeverity.mockRejectedValue(new Error('53300: too many connections'))
    mocks.countBillingWebhookEventsByStatus.mockRejectedValue(new Error('boom'))

    for (const variant of ['removals', 'abuse', 'billing']) {
      const payload = parsed(await buildSection({ section: 'trust', range: '24h', variant, now: NOW }))
      expect(payload, variant).toMatchObject({ status: 'unavailable', code: 'error' })
    }
  })
})

describe('the Platform Action Queue', () => {
  /**
   * Plan 57, Admin track — "Build the Platform Action Queue and service-health widgets".
   *
   * It lives on Overview because `/admin` resolves to `/admin/metrics` and Overview is what that loads first, so
   * it is the panel an operator sees on arrival. The Verify line asks for severity/age ordering, expiry and
   * deduplication, degraded status, partial failure and unknown destinations — each has a case here.
   */
  const noAttention = () => {
    mocks.getPlatformAccountMetrics.mockResolvedValue({ totalUsers: 10, newUsersLast24h: 1, newUsersLast7d: 3 })
    mocks.getOnboardingActivationMetrics.mockResolvedValue({
      onboardingCompleted: 8, onboardingSkipped: 1, onboardingCompletedLast7d: 2,
    })
    mocks.countBillingWebhookEventsByStatus.mockResolvedValue({ pending: 2, processing: 0, processed: 90, failed: 0, ignored: 0 })
    mocks.countAbuseSignalsBySeverity.mockResolvedValue(new Map([['low', 5]]))
    mocks.listScheduleRegistry.mockResolvedValue([])
    mocks.listSearchSources.mockResolvedValue([])
    envStub.PROFILE_REMOVAL_ENABLED = 'false'
  }

  const queueOf = (payload: unknown) =>
    (payload as { data: { queue?: Array<{ key: string; severity: string; count: number; oldestAgeSeconds?: number; href: string }> } })
      .data.queue ?? []

  it('emits no rows at all when nothing needs attention', async () => {
    /**
     * An empty queue rather than a list of reassurances. A panel that is always present teaches the reader to
     * skim past it, and then it is furniture on the day it has a row.
     */
    noAttention()
    const payload = parsed(await buildSection({ section: 'overview', range: '24h', variant: 'summary', now: NOW }))
    expect(payload.status).toBe('ready')
    expect(queueOf(payload)).toEqual([])
  })

  it('orders by severity first and by count within a severity', async () => {
    noAttention()
    mocks.countBillingWebhookEventsByStatus.mockResolvedValue({ pending: 0, processing: 4, processed: 0, failed: 2, ignored: 0 })
    mocks.countAbuseSignalsBySeverity.mockResolvedValue(new Map([['critical', 1], ['high', 6]]))
    mocks.listSearchSources.mockResolvedValue([
      { key: 'a', enabled: true, connectorImplemented: false, termsReviewedAt: null },
      { key: 'b', enabled: true, connectorImplemented: true, termsReviewedAt: null },
    ])

    const payload = parsed(await buildSection({ section: 'overview', range: '24h', variant: 'summary', now: NOW }))
    const keys = queueOf(payload).map((row) => row.key)
    // critical: dead-lettered billing. high: 7 abuse signals then 4 stuck events. medium: 2 unreviewed, 1 dead.
    expect(keys[0]).toBe('billing_events_dead_lettered')
    expect(keys.slice(1, 3)).toEqual(['abuse_signals_urgent', 'billing_events_stuck'])
    expect(queueOf(payload).map((row) => row.severity)).toEqual(['critical', 'high', 'high', 'medium', 'medium'])
  })

  it('reports the age of the oldest missed run, which is what separates a blip from an outage', async () => {
    /**
     * A job three minutes late is a slow tick; the same job three days late means the worker has not run since a
     * deploy. The count alone cannot tell those apart, and this is the only row whose source can say.
     */
    noAttention()
    mocks.listScheduleRegistry.mockResolvedValue([
      { jobKey: 'a', enabled: true, nextRunAt: new Date(NOW.getTime() - 3 * 86_400_000) },
      { jobKey: 'b', enabled: true, nextRunAt: new Date(NOW.getTime() - 60_000) },
    ])

    const payload = parsed(await buildSection({ section: 'overview', range: '24h', variant: 'summary', now: NOW }))
    const row = queueOf(payload).find((entry) => entry.key === 'workers_overdue')
    expect(row?.count).toBe(2)
    expect(row?.oldestAgeSeconds).toBe(3 * 86_400)
  })

  it('never emits an age of zero for a source that cannot state one', async () => {
    // `0s` looks fresh. "We do not know how old this is" is a different fact, and absence is how the contract
    // says it.
    noAttention()
    mocks.countBillingWebhookEventsByStatus.mockResolvedValue({ pending: 0, processing: 0, processed: 0, failed: 3, ignored: 0 })
    const payload = parsed(await buildSection({ section: 'overview', range: '24h', variant: 'summary', now: NOW }))
    expect(queueOf(payload)[0]?.oldestAgeSeconds).toBeUndefined()
  })

  it('marks the section partial when a source could not be read, instead of a shorter queue', async () => {
    /**
     * The distinction the envelope exists for. An empty queue means nothing needs attention; a *shortened* queue
     * means something might and we could not tell. Collapsing them makes an unreadable billing table look like a
     * quiet afternoon — on the panel an operator reads first.
     */
    noAttention()
    mocks.countBillingWebhookEventsByStatus.mockRejectedValue(new Error('53300: too many connections'))
    const payload = parsed(await buildSection({ section: 'overview', range: '24h', variant: 'summary', now: NOW }))
    expect(payload).toMatchObject({ status: 'partial', code: 'error' })
    // The rest of the page still renders: one failed source does not blank the numbers.
    expect(valueOf(payload, 'users_total')).toBe(10)
  })

  it('does not call the removal source at all while the capability is off, and stays ready', async () => {
    // A disabled feature is not an unreadable source. Reporting it as one would make Overview `partial` forever
    // on any deployment with removals switched off, and `partial` means "we could not tell".
    noAttention()
    const payload = parsed(await buildSection({ section: 'overview', range: '24h', variant: 'summary', now: NOW }))
    expect(payload.status).toBe('ready')
    expect(mocks.getRemovalOperationsMetrics).not.toHaveBeenCalled()
  })

  it('puts a missed removal deadline above a backlog, and never queues the backlog itself', async () => {
    // A queue getting long is not an action; a commitment already missed is.
    noAttention()
    envStub.PROFILE_REMOVAL_ENABLED = 'true'
    mocks.getRemovalOperationsMetrics.mockResolvedValue({
      totalRequests: 40,
      byStatus: { pending: 30, verified: 8, rejected: 1, expired: 1 },
      bySource: [], otherSourcesCount: 0,
      pendingAging: { underOneDay: 30, oneToSevenDays: 0, sevenToThirtyDays: 0, overThirtyDays: 0 },
      overduePendingCount: 2,
      activeSuppressions: 0,
      generatedAt: NOW.toISOString(),
    })

    const payload = parsed(await buildSection({ section: 'overview', range: '24h', variant: 'summary', now: NOW }))
    const keys = queueOf(payload).map((row) => row.key)
    expect(keys).toContain('removal_requests_overdue')
    expect(keys.some((key) => key.includes('pending'))).toBe(false)
    expect(queueOf(payload).find((row) => row.key === 'removal_requests_overdue')?.severity).toBe('critical')
  })

  it('only ever points at in-app paths, which the contract enforces', async () => {
    /**
     * A server-supplied destination that could be absolute is an open redirect on the page whose reader has the
     * most authority. The parse in `parsed()` is the real assertion — this makes the property explicit.
     */
    noAttention()
    mocks.countBillingWebhookEventsByStatus.mockResolvedValue({ pending: 0, processing: 1, processed: 0, failed: 1, ignored: 0 })
    const payload = parsed(await buildSection({ section: 'overview', range: '24h', variant: 'summary', now: NOW }))
    for (const row of queueOf(payload)) {
      expect(row.href, row.key).toMatch(/^\/[a-z0-9/_-]+$/)
    }
  })

  it('carries no identity or evidence, only a kind and a count', async () => {
    // A queue of individual incidents would put an organization id or a failing event's payload on this page.
    // "Four dead-lettered events" is the whole decision an operator makes from a summary.
    noAttention()
    mocks.countBillingWebhookEventsByStatus.mockResolvedValue({ pending: 0, processing: 0, processed: 0, failed: 4, ignored: 0 })
    const payload = parsed(await buildSection({ section: 'overview', range: '24h', variant: 'summary', now: NOW }))
    const serialized = JSON.stringify(queueOf(payload))
    for (const forbidden of ['organizationId', 'userId', 'stripe', 'payload', 'stack']) {
      expect(serialized.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase())
    }
  })
})

describe('incident communication aging', () => {
  /**
   * Plan 57, Admin track — the operational half of "Build Growth, Conversion, and Public Content admin widgets".
   *
   * "Omit vanity page-view panels" is explicit in the Do line, so there is no traffic number here and only one
   * variant, which is what keeps a second one from being the invitation to add them. Growth and conversion
   * already have honest homes: `activation` for the cohort-correct rate, `conversion` for the landing funnel.
   */
  it('reports zero open incidents as a real zero, unlike a disabled capability', async () => {
    /**
     * The one place in this module where zero is the honest answer, and the reason is specific: the incidents
     * table is written on every incident, so an empty result means none are open rather than that nothing is
     * recording them. Compare `removals`, where zero can mean the door is shut — that one answers `not_enabled`.
     */
    mocks.countUnresolvedIncidents.mockResolvedValue(new Map())
    const payload = parsed(await buildSection({ section: 'content', range: '24h', variant: 'incidents', now: NOW }))
    expect(payload.status).toBe('ready')
    expect(valueOf(payload, 'incidents_open')).toBe(0)
  })

  it('reports the age of the oldest unresolved incident, which the count cannot tell you', async () => {
    /**
     * One open incident is normal operation. One that started six days ago means nobody has closed the loop with
     * the people reading the status page — a communication failure rather than an outage, and indistinguishable
     * from the healthy case by count alone.
     */
    mocks.countUnresolvedIncidents.mockResolvedValue(
      new Map([['major', { open: 1, oldestStartedAt: new Date(NOW.getTime() - 6 * 86_400_000) }]]),
    )
    const payload = parsed(await buildSection({ section: 'content', range: '24h', variant: 'incidents', now: NOW }))
    expect(valueOf(payload, 'incidents_open_major')).toBe(1)
    expect(valueOf(payload, 'incidents_oldest_major_seconds')).toBe(6 * 86_400)
  })

  it('draws a line on critical and major ages, and not on minor', async () => {
    // Four hours to warn and a day to escalate: a status page that has said "investigating" for a day has stopped
    // being a status page. A minor incident sitting open is housekeeping, and a line there trains an operator to
    // ignore lines.
    mocks.countUnresolvedIncidents.mockResolvedValue(
      new Map([
        ['critical', { open: 1, oldestStartedAt: new Date(NOW.getTime() - 3_600_000) }],
        ['major', { open: 1, oldestStartedAt: new Date(NOW.getTime() - 3_600_000) }],
        ['minor', { open: 4, oldestStartedAt: new Date(NOW.getTime() - 30 * 86_400_000) }],
      ]),
    )
    const payload = parsed(await buildSection({ section: 'content', range: '24h', variant: 'incidents', now: NOW }))
    const byKey = new Map(
      (payload as { data: { values: { key: string; threshold?: { warn: number } }[] } }).data.values.map((v) => [v.key, v]),
    )
    expect(byKey.get('incidents_oldest_critical_seconds')?.threshold?.warn).toBe(4 * 3600)
    expect(byKey.get('incidents_oldest_major_seconds')?.threshold?.warn).toBe(4 * 3600)
    expect(byKey.get('incidents_oldest_minor_seconds')?.threshold).toBeUndefined()
    // The counts themselves carry no threshold: one open incident is not a breach, an old one is.
    expect(byKey.get('incidents_open_critical')?.threshold).toBeUndefined()
  })

  it('omits the age rather than reporting zero when a severity has no start on record', async () => {
    mocks.countUnresolvedIncidents.mockResolvedValue(new Map([['major', { open: 2, oldestStartedAt: null }]]))
    const payload = parsed(await buildSection({ section: 'content', range: '24h', variant: 'incidents', now: NOW }))
    expect(valueOf(payload, 'incidents_open_major')).toBe(2)
    expect(valueOf(payload, 'incidents_oldest_major_seconds')).toBeUndefined()
  })

  it('answers `error` rather than "no incidents" when the read fails', async () => {
    // The one that matters most here: "0 open" on a failed read is the most reassuring wrong answer this page
    // could give.
    mocks.countUnresolvedIncidents.mockRejectedValue(new Error('53300: too many connections'))
    const payload = parsed(await buildSection({ section: 'content', range: '24h', variant: 'incidents', now: NOW }))
    expect(payload).toMatchObject({ status: 'unavailable', code: 'error' })
  })
})
