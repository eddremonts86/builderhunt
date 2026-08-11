import type { AdminMetricRange, AdminMetricSection, AdminMetricSectionPayload } from './contracts'
import { ADMIN_METRIC_LIMITS } from './contracts'
import { LATENCY_BOUNDARIES_MS, LATENCY_SLOTS, percentileFrom } from './history'
import { interviewOperatorCounters, metrics } from '../metrics'
import { env } from '../env'
import { getOnboardingActivationMetrics, getPlatformAccountMetrics } from '../repositories/platform-billing'
import { getDiscoveryState } from '../repositories/discovery-state'
import { readServiceMetricFreshness, readServiceMetricWindow } from '../repositories/service-metrics'
import type { FamilyWindow } from '../repositories/service-metrics'

/** The `values` array of a ready payload, named so the builders below can push into it. */
type AdminMetricValues = Extract<AdminMetricSectionPayload, { status: 'ready' }>['data']['values']

/**
 * One section, built from a source that exists — or `unavailable`, never zeroes (plan 57, Admin track).
 *
 * ## The rule this module is built around
 *
 * A section with no backing store returns `unavailable` with a code. It does **not** return zeroes.
 * `/api/admin/metrics` already carries this reasoning twice, for removals and for interview counters:
 * "a `removals` block reading all-zeros would be a lie of implication — a dashboard would render
 * '0 pending' and an operator would conclude the queue is empty rather than that the door is shut."
 *
 * That is the same trap the whole Admin Metrics rebuild is about, and it is worth stating once here
 * because two of the eight sections still have no source. `service_metric_buckets` gave traffic and
 * search theirs; conversion cohorts need billing events bucketed by signup cohort and feature
 * reliability needs per-feature availability samples, and neither is a request counter. Until something
 * writes those, both say `insufficient_history` and render nothing, which is the only answer that cannot
 * be misread as good news.
 *
 * ## Why the range is accepted but not always honoured
 *
 * `process`-scoped counters have no history: `metrics.get()` returns totals since this instance booted,
 * so a `1h` request and a `30d` request against the runtime section return the same numbers. Rather than
 * pretend to window them, the runtime section reports the process start time as its window `from` and
 * carries `scope: 'process'` on every value — which is what the contract's scope rule exists to make
 * unmissable.
 */

/** Range to milliseconds. Only for sections whose source can actually be windowed. */
const RANGE_MS: Record<AdminMetricRange, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

/**
 * The instance a process counter came from.
 *
 * `startedAt` is derived from `process.uptime()` rather than recorded at import, because a module-level
 * timestamp is the time the module was *loaded* — close enough in practice and wrong in exactly the case
 * that matters, a lazily imported route in a long-running process.
 */
function processIdentity() {
  return {
    pid: process.pid,
    startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    instance: process.env.HOSTNAME ?? `pid-${process.pid}`,
  }
}

function windowFor(range: AdminMetricRange, now: Date, from?: Date) {
  /**
   * A supplied `from` that is not before `now` falls back to the range.
   *
   * The two callers that supply one read it from a *different clock* than `now`: runtime derives it from
   * `process.uptime()`, and discovery from the worker's persisted `lastRunAt`. Neither is guaranteed to be
   * in the past relative to the `now` the caller passed — a worker whose clock runs ahead, or any caller
   * passing an explicit `now`, produces `from > to`. The contract refuses that window, so the payload would
   * fail its own parse and the section would answer 500 instead of rendering, which is the one outcome the
   * per-section split exists to prevent.
   */
  const supplied = from && from.getTime() < now.getTime() ? from : undefined
  return {
    range,
    from: (supplied ?? new Date(now.getTime() - RANGE_MS[range])).toISOString(),
    to: now.toISOString(),
    /**
     * The server's zone, reported rather than assumed.
     *
     * Bucket boundaries for anything daily are a local-time question, and a payload that omits the zone
     * leaves two operators in different places reading "yesterday" as two different days.
     */
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

const unavailable = (code: 'dependency_unavailable' | 'not_enabled' | 'insufficient_history' | 'timeout' | 'error'): AdminMetricSectionPayload => ({
  status: 'unavailable',
  code,
})

export interface SectionInput {
  section: AdminMetricSection
  range: AdminMetricRange
  variant: string
  /**
   * Read the window immediately before this one too, and attach each value's earlier figure as `previous`.
   *
   * Off unless asked for, because it is a second windowed read of the same length — doubling the cost of a
   * section that sits on a refresh timer. Only the sections with a real time series can honour it: a process
   * counter has no previous window, and a section with no history has nothing to compare.
   */
  compare?: boolean
  now?: Date
}

/**
 * Builds one section. Never throws for a missing source — that is what `unavailable` is for.
 *
 * A thrown error would take the whole response with it, and the point of the split is that one section
 * failing leaves the ready ones readable. The route catches anything unexpected and turns it into
 * `unavailable: 'error'` for that section alone.
 */
export async function buildSection(input: SectionInput): Promise<AdminMetricSectionPayload> {
  const now = input.now ?? new Date()
  const { section, range } = input

  switch (section) {
    case 'overview':
      return buildOverview(range, now)
    case 'activation':
      return buildActivation(range, now)
    case 'discovery':
      return buildDiscovery(range, now)
    case 'runtime':
      return input.variant === 'freshness' ? buildFreshness(range, now) : buildRuntime(range, now)
    case 'traffic':
      return buildTraffic(range, input.variant, now, input.compare === true)
    case 'search':
      return buildSearch(range, input.variant, now, input.compare === true)
    case 'reliability':
      return buildReliability(range, input.variant, now)
    /**
     * Still with no source, and why it is not lumped in with traffic and search.
     *
     * `insufficient_history` rather than `dependency_unavailable`: the dependency is not missing, the
     * *history* is. `service_metric_buckets` persists request and search counts per minute, which is what
     * turned `traffic` and `search` into real sections — but conversion cohorts need billing events bucketed
     * by signup cohort, and that is not a request counter. It stays honest until something writes it.
     *
     * The landing funnel on `/api/admin/metrics/conversion` is a different and narrower question, answered
     * honestly: each step's denominator is the previous step's event on the same session.
     */
    case 'conversion':
      return unavailable('insufficient_history')
  }
}

/**
 * Traffic, from the persisted minute buckets.
 *
 * The variant is not cosmetic here: `rate`, `latency` and `errors` return different metric keys and rank by
 * different columns, which is exactly what the contract means by "a variant changes which shape the section
 * returns". Rendering the default while the URL said `latency` would show an operator the wrong panel and
 * they would have no way to tell.
 *
 * Everything is `scope: 'database'` and `platformTotal: true`, and that is the claim the storage was built
 * to earn: the rows are per-instance, the query sums them, so unlike `metrics.get()` this genuinely is the
 * platform's number over the stated window.
 */
async function buildTraffic(
  range: AdminMetricRange,
  variant: string,
  now: Date,
  compare: boolean,
): Promise<AdminMetricSectionPayload> {
  const window = windowFor(range, now)
  const from = new Date(window.from)
  const read = await readServiceMetricWindow(from, now).catch(() => null)
  if (!read) return unavailable('error')
  const earlier = compare ? await previousWindow(from, now) : null
  // No rows in the window is not "zero requests" — it is a window before the store began, or a store that
  // is not being written. Either way there is nothing to report, and zeroes would read as an outage.
  if (read.families.length === 0) return unavailable('insufficient_history')

  const total = read.totals
  const generatedAt = now.toISOString()
  const dbCount = { unit: 'count' as const, scope: 'database' as const, platformTotal: true }
  const values: AdminMetricValues = [
    { key: 'requests', value: total.requests, ...dbCount, ...was(earlier?.totals.requests) },
    { key: 'errors', value: total.errors, ...dbCount, ...was(earlier?.totals.errors) },
    // The count of instances that contributed, so an operator can tell a platform sum from one process.
    { key: 'instances_reporting', value: read.instances, ...dbCount },
  ]

  if (variant === 'latency') {
    /**
     * A percentile is included only when the histogram can name one.
     *
     * `null` from `percentileFrom` means the answer is past the last boundary, and there is no number to
     * report — so instead of inventing one, `requests_over_10s` says how many requests were slower than
     * the coarsest bucket. That count is the honest form of the same information, and it is why an absent
     * `p99_ms` is not a hole in the section: its sibling explains it.
     */
    const overflowCount = read.families.reduce(
      (sum, family) => sum + (family.latencyBuckets[LATENCY_SLOTS - 1] ?? 0),
      0,
    )
    const dbMs = { unit: 'milliseconds' as const, scope: 'database' as const, platformTotal: true }
    if (total.p50Ms !== null) values.push({ key: 'latency_p50_ms', value: total.p50Ms, ...dbMs, ...was(earlier?.totals.p50Ms ?? undefined) })
    if (total.p95Ms !== null) values.push({ key: 'latency_p95_ms', value: total.p95Ms, ...dbMs, ...was(earlier?.totals.p95Ms ?? undefined) })
    if (total.p99Ms !== null) values.push({ key: 'latency_p99_ms', value: total.p99Ms, ...dbMs, ...was(earlier?.totals.p99Ms ?? undefined) })
    values.push({ key: 'requests_over_10s', value: overflowCount, ...dbCount })

    return {
      status: 'ready',
      generatedAt,
      window,
      data: { values, ranked: rankFamilies(read.families, (family) => familyP95(family), 'milliseconds') },
    }
  }

  if (variant === 'errors') {
    // The rate is omitted, not zeroed, when nothing was served: 0 errors out of 0 requests is undefined,
    // and `0 %` next to an empty window reads as a clean bill of health.
    if (total.requests > 0) {
      values.push({
        key: 'error_rate',
        value: total.errors / total.requests,
        unit: 'ratio',
        scope: 'database',
        platformTotal: true,
        // Higher is worse, and the pair is checked for direction by the contract.
        threshold: { direction: 'higher_is_worse', warn: 0.01, critical: 0.05 },
        // Only when the earlier window served anything: a rate over an empty denominator is undefined, and
        // "was 0 %" beside a window that served nothing is the same lie in the comparison column.
        ...was(earlier && earlier.totals.requests > 0 ? earlier.totals.errors / earlier.totals.requests : undefined),
      })
    }
    return {
      status: 'ready',
      generatedAt,
      window,
      data: { values, ranked: rankFamilies(read.families, (family) => family.errors, 'count') },
    }
  }

  // `rate`, the default.
  const seconds = Math.max(1, Math.round((now.getTime() - from.getTime()) / 1000))
  values.push({
    key: 'requests_per_second',
    value: total.requests / seconds,
    unit: 'per_second',
    scope: 'database',
    platformTotal: true,
    // The same divisor, because the previous window is the same length by construction — comparing two rates
    // computed over different spans would move the number for a reason that is not traffic.
    ...was(earlier ? earlier.totals.requests / seconds : undefined),
  })
  return {
    status: 'ready',
    generatedAt,
    window,
    data: { values, ranked: rankFamilies(read.families, (family) => family.requests, 'count') },
  }
}

/**
 * Search volume and cache quality, from the same buckets.
 *
 * Separate from the runtime section's `searches` counter, which is this process since boot. These are
 * windowed and summed across instances, so the two will disagree — and that is correct rather than a bug:
 * they answer different questions and each says which one on the wire, via `scope`.
 */
async function buildSearch(
  range: AdminMetricRange,
  variant: string,
  now: Date,
  compare: boolean,
): Promise<AdminMetricSectionPayload> {
  const window = windowFor(range, now)
  const from = new Date(window.from)
  const read = await readServiceMetricWindow(from, now).catch(() => null)
  if (!read) return unavailable('error')
  if (read.totals.searches === 0) return unavailable('insufficient_history')
  const earlier = compare ? await previousWindow(from, now) : null

  const generatedAt = now.toISOString()
  const dbCount = { unit: 'count' as const, scope: 'database' as const, platformTotal: true }
  const values: AdminMetricValues = [
    { key: 'searches', value: read.totals.searches, ...dbCount, ...was(earlier?.totals.searches) },
    { key: 'search_cache_hits', value: read.totals.searchCacheHits, ...dbCount, ...was(earlier?.totals.searchCacheHits) },
  ]

  if (variant === 'quality') {
    values.push({
      key: 'search_cache_hit_rate',
      value: read.totals.searchCacheHits / read.totals.searches,
      unit: 'ratio',
      scope: 'database',
      platformTotal: true,
      // A cold cache is slow and expensive, not broken, so lower is worse and neither bound is an alarm.
      threshold: { direction: 'lower_is_worse', warn: 0.4, critical: 0.1 },
      ...was(earlier && earlier.totals.searches > 0 ? earlier.totals.searchCacheHits / earlier.totals.searches : undefined),
    })
  }

  return { status: 'ready', generatedAt, window, data: { values } }
}

/**
 * The window of equal length immediately before this one.
 *
 * Equal length matters: comparing a 24-hour figure against a 30-day one is a comparison of two different
 * questions, and the difference would read as a change in traffic. Returns `null` on failure rather than
 * throwing, so a comparison that cannot be read costs the operator the comparison and not the section.
 */
async function previousWindow(from: Date, to: Date) {
  const span = to.getTime() - from.getTime()
  return readServiceMetricWindow(new Date(from.getTime() - span), from).catch(() => null)
}

/**
 * Attaches `previous` only when there is a number to attach.
 *
 * Spreading an absent value rather than writing `previous: undefined` keeps the key off the payload entirely,
 * which is what the contract means by optional — and it is the difference between "no comparison was
 * requested" and "the comparison is zero". A client cannot tell those apart from a `0`.
 */
function was(previous: number | null | undefined): { previous?: number } {
  return typeof previous === 'number' && Number.isFinite(previous) ? { previous } : {}
}

/** The p95 for one family, or the last boundary when it overflows — used only for ranking, never reported. */
function familyP95(family: FamilyWindow): number {
  const result = percentileFrom(family.latencyBuckets, 0.95)
  return result.atMostMs ?? LATENCY_BOUNDARIES_MS[LATENCY_BOUNDARIES_MS.length - 1]
}

/**
 * Top families by one column, capped at the contract's limit.
 *
 * The cap is `ADMIN_METRIC_LIMITS.rankedRows`, and slicing to it is the design rather than a truncation to
 * apologise for — but there are fourteen families and ten rows, so on a busy platform four are genuinely
 * not shown. Families with a zero value are dropped first, which is what usually makes the difference
 * moot; when it does not, the section's totals still account for every family, so the arithmetic on the
 * page stays right even when the ranking is partial.
 */
function rankFamilies(
  families: readonly FamilyWindow[],
  valueOf: (family: FamilyWindow) => number,
  unit: 'count' | 'milliseconds',
) {
  return families
    .map((family) => ({ family: family.routeFamily, value: valueOf(family), unit }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, ADMIN_METRIC_LIMITS.rankedRows)
}

/**
 * The lightweight one, and the reason the split exists.
 *
 * Two indexed aggregate reads, run concurrently, and no billing sweep or conversion query — those were
 * what made the monolithic endpoint expensive on a sixty-second refresh. Overview is what the page loads
 * first and re-reads on a timer, so it is the one that has to stay cheap.
 */
async function buildOverview(range: AdminMetricRange, now: Date): Promise<AdminMetricSectionPayload> {
  const window = windowFor(range, now)
  const since = new Date(window.from)
  const weekAgo = new Date(now.getTime() - RANGE_MS['7d'])

  const [accounts, onboarding] = await Promise.all([
    getPlatformAccountMetrics(since, weekAgo),
    getOnboardingActivationMetrics(weekAgo),
  ])

  return {
    status: 'ready',
    generatedAt: now.toISOString(),
    window,
    data: {
      values: [
        { key: 'users_total', value: accounts.totalUsers, unit: 'count', scope: 'database', platformTotal: true },
        { key: 'users_new_24h', value: accounts.newUsersLast24h, unit: 'count', scope: 'database', platformTotal: true },
        { key: 'users_new_7d', value: accounts.newUsersLast7d, unit: 'count', scope: 'database', platformTotal: true },
        { key: 'onboarding_completed', value: onboarding.onboardingCompleted, unit: 'count', scope: 'database', platformTotal: true },
        { key: 'onboarding_skipped', value: onboarding.onboardingSkipped, unit: 'count', scope: 'database', platformTotal: true },
      ],
    },
  }
}

/**
 * Activation, with the ratio omitted rather than divided by zero.
 *
 * A seven-day activation rate needs a seven-day denominator. When no accounts were created in the window
 * the rate is not `0` — it is undefined, and rendering `0%` would read as "nobody activated" when the
 * truth is "nobody signed up". The monolithic endpoint already did this with `activationRate7d: null`;
 * here the value is simply absent, because the contract has no way to say "null but present".
 */
async function buildActivation(range: AdminMetricRange, now: Date): Promise<AdminMetricSectionPayload> {
  const window = windowFor(range, now)
  const weekAgo = new Date(now.getTime() - RANGE_MS['7d'])
  const [accounts, onboarding] = await Promise.all([
    getPlatformAccountMetrics(new Date(window.from), weekAgo),
    getOnboardingActivationMetrics(weekAgo),
  ])

  const rate = accounts.newUsersLast7d > 0
    ? onboarding.onboardingCompletedLast7d / accounts.newUsersLast7d
    : undefined

  /**
   * Two explicit branches rather than one object with a computed status.
   *
   * The discriminated union refuses an object that is neither shape, which is the whole reason it is a
   * union: `status` decides which other keys are legal, so a spread-in `code` and a computed `status` make
   * a value that is `ready`-with-a-`code` as far as the type is concerned. Writing the branches out is
   * what makes the parser and the compiler agree.
   */
  const counts = [
    { key: 'onboarding_completed_7d', value: onboarding.onboardingCompletedLast7d, unit: 'count' as const, scope: 'database' as const, platformTotal: true },
    { key: 'users_new_7d', value: accounts.newUsersLast7d, unit: 'count' as const, scope: 'database' as const, platformTotal: true },
  ]

  if (rate === undefined) {
    return {
      status: 'partial',
      generatedAt: now.toISOString(),
      window,
      code: 'insufficient_history',
      data: { values: counts },
    }
  }

  return {
    status: 'ready',
    generatedAt: now.toISOString(),
    window,
    data: {
      values: [
        ...counts,
        { key: 'activation_rate_7d', value: rate, unit: 'ratio' as const, scope: 'database' as const, platformTotal: true },
      ],
    },
  }
}

/** Discovery, from the worker's own persisted state. Absent rather than zeroed when it has never run. */
async function buildDiscovery(range: AdminMetricRange, now: Date): Promise<AdminMetricSectionPayload> {
  const state = await getDiscoveryState().catch(() => null)
  if (!state) return unavailable('dependency_unavailable')
  const stats = state.stats as Record<string, unknown> | null
  const numeric = (key: string): number | undefined => {
    const raw = stats?.[key]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
  }
  const candidates: [string, number | undefined][] = [
    ['discovery_cells_scanned', numeric('cellsScanned')],
    ['discovery_profiles_seen', numeric('profilesSeen')],
    ['discovery_profiles_stored', numeric('profilesStored')],
  ]
  const values = candidates
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([key, value]) => ({ key, value, unit: 'count' as const, scope: 'database' as const, platformTotal: true }))

  // The worker's last run, not the requested range: this is state, not a windowed aggregate, and
  // reporting the asked-for window would claim the numbers describe it.
  const window = windowFor(range, now, state.lastRunAt ? new Date(state.lastRunAt) : undefined)
  const generatedAt = now.toISOString()

  // Same two-branch shape as activation, for the same reason the union exists.
  if (values.length === 0) {
    return { status: 'partial', generatedAt, window, code: 'insufficient_history', data: { values } }
  }
  return { status: 'ready', generatedAt, window, data: { values } }
}

/**
 * Runtime, and the section the contract's scope rule was written for.
 *
 * Every value is `scope: 'process'` and carries the process identity, so there is no shape in which
 * these can be read as platform totals — which is what they would look like next to the `database`
 * numbers in Overview if the scope were not on the wire.
 */
function buildRuntime(range: AdminMetricRange, now: Date): AdminMetricSectionPayload {
  const snapshot = metrics.get()
  const identity = processIdentity()
  const counter = (key: string, value: number) => ({
    key,
    value,
    unit: 'count' as const,
    scope: 'process' as const,
    processIdentity: identity,
  })

  return {
    status: 'ready',
    generatedAt: now.toISOString(),
    // From this process's start, because that is when these counters were last zero. The requested range
    // is accepted and deliberately not applied — see the module comment.
    window: windowFor(range, now, new Date(identity.startedAt)),
    data: {
      values: [
        counter('api_requests', snapshot.apiRequests),
        counter('api_errors', snapshot.apiErrors),
        counter('searches', snapshot.searches),
        counter('search_cache_hits', snapshot.searchCacheHits),
        counter('signups', snapshot.signups),
        counter('signins', snapshot.signins),
        counter('dashboard_overview_cache_hits', snapshot.dashboardOverviewCacheHits),
        counter('dashboard_overview_cache_misses', snapshot.dashboardOverviewCacheMisses),
        counter('dashboard_overview_section_failures', snapshot.dashboardOverviewSectionFailures),
        {
          key: 'process_rss_bytes',
          value: process.memoryUsage.rss(),
          unit: 'bytes' as const,
          scope: 'process' as const,
          processIdentity: identity,
        },
      ],
      /**
       * No `ranked` block, deliberately.
       *
       * `metrics.get()` counts API requests and errors in *total*, not per route family, so there is no
       * honest ranking to build — and splitting a total across the contract's fourteen families would be
       * exactly the fabrication its allowlist exists to prevent. The ranking arrives with the historical
       * store, which is its own open task.
       */
    },
  }
}

/**
 * Data Freshness — the runtime section's second variant, and the answer to a question the rest of the page
 * cannot ask about itself.
 *
 * Every other number here is undated in the reader's mind: an operator sees "requests: 1,204" and takes it to
 * mean now. If the flush stopped an hour ago that figure is real, correctly windowed, and describes an hour
 * ago — and nothing else on the page would say so, because `generatedAt` reports when the *query* ran, not
 * how current its input was.
 *
 * `scope: 'database'` on the lag values and `process` on the process age, because they are genuinely
 * different claims: the lag is a platform fact read from the table, the age is this instance's.
 */
async function buildFreshness(range: AdminMetricRange, now: Date): Promise<AdminMetricSectionPayload> {
  const window = windowFor(range, now)
  const identity = processIdentity()
  const freshness = await readServiceMetricFreshness(now).catch(() => null)
  if (!freshness) return unavailable('error')

  const values: AdminMetricValues = [
    {
      key: 'process_age_seconds',
      value: Math.round((now.getTime() - new Date(identity.startedAt).getTime()) / 1000),
      unit: 'count',
      scope: 'process',
      processIdentity: identity,
    },
  ]

  if (freshness.newestBucketStart) {
    /**
     * Lag, not a timestamp. A timestamp needs the reader to subtract, and a page read at 02:00 is exactly
     * where that subtraction goes wrong — especially across a timezone, which is why the window carries one.
     *
     * The threshold is 180 s warn / 600 s critical: the flush runs every 30 s and holds the minute in
     * progress back, so ~90 s of lag is normal operation and three minutes is not.
     */
    values.push({
      key: 'metric_lag_seconds',
      value: Math.max(0, Math.round((now.getTime() - freshness.newestBucketStart.getTime()) / 1000)),
      unit: 'count',
      scope: 'database',
      platformTotal: true,
      threshold: { direction: 'higher_is_worse', warn: 180, critical: 600 },
    })
  }

  if (freshness.oldestBucketStart) {
    // How much history exists at all. A "30d" range over four days of history is not thirty days, and this
    // is the only value on the page that says so.
    values.push({
      key: 'history_span_seconds',
      value: Math.max(0, Math.round((now.getTime() - freshness.oldestBucketStart.getTime()) / 1000)),
      unit: 'count',
      scope: 'database',
      platformTotal: true,
    })
  }

  /**
   * Instances that wrote in the last ten minutes. Zero is the state that otherwise looks exactly like no
   * traffic, so it is reported as its own number rather than inferred from an empty chart — and it is why
   * this variant is `ready` even when the store is empty. "Nothing is reporting" is an answer.
   */
  values.push({
    key: 'reporting_instances',
    value: freshness.reportingInstances,
    unit: 'count',
    scope: 'database',
    platformTotal: true,
    threshold: { direction: 'lower_is_worse', warn: 1, critical: 0 },
  })

  return { status: 'ready', generatedAt: now.toISOString(), window, data: { values } }
}

/**
 * Interview reliability counters, thresholded only where a threshold can mean something (plan 57, Admin
 * track — "Build Feature Reliability metrics with interview signals first").
 *
 * ## Why interview signals and not a general availability figure
 *
 * They are the only per-feature reliability numbers that exist. A general "feature availability" percentage
 * would need per-feature availability samples over a window, and nothing writes those — so the `availability`
 * variant answers `insufficient_history` rather than showing a 100 % derived from the absence of evidence.
 *
 * ## Why `not_enabled` rather than a grid of zeros
 *
 * With every interview capability off nobody can book, upload or transcribe, so every counter is zero *by
 * construction*. Rendering them would read as "no problems" when it means "no traffic is possible" — the same
 * reasoning `/api/admin/metrics` already applies by omitting `counters` entirely.
 *
 * ## Why most of these carry no threshold, and that is the honest answer
 *
 * These are cumulative since this process started. A threshold on an accumulator breaches eventually on any
 * healthy instance that stays up long enough, so "provider errors > 5" is a statement about uptime rather than
 * about health — and an alert that fires on every long-lived process is one an operator learns to ignore.
 *
 * So a threshold is attached in exactly two cases: a **gauge** that drains (the document backlog is work
 * waiting, not work done), and a counter where *any* non-zero value is worth reading regardless of how long
 * the process has been up. The rest are reported with their scope stated and no line drawn, because the honest
 * line needs a rate, and a rate needs the persisted per-feature buckets this section does not have.
 */
const THRESHOLDED_INTERVIEW_COUNTERS: Record<string, { direction: 'higher_is_worse'; warn: number; critical: number }> = {
  // A gauge: documents waiting to be scanned or extracted. A backlog that does not drain means the worker is
  // not being called, and unlike the accumulators this figure comes back down on its own when it is healthy.
  documentBacklog: { direction: 'higher_is_worse', warn: 25, critical: 100 },
  // Documents that ended `failed` or `rejected` — distinct from the backlog, because these will never drain.
  documentFailures: { direction: 'higher_is_worse', warn: 1, critical: 10 },
  // A row is kept for each object the retention sweep could not delete, so this must return to zero.
  retentionObjectFailures: { direction: 'higher_is_worse', warn: 1, critical: 5 },
  // Output refused for prohibited content. Any non-zero value is worth reading — see the post-market
  // monitoring doc. Not an error rate: one refusal is a thing that happened and somebody should know.
  prohibitedOutputRefusals: { direction: 'higher_is_worse', warn: 1, critical: 5 },
  // A provider's figure differing beyond policy is a billing correctness problem, not a load signal.
  usageVariances: { direction: 'higher_is_worse', warn: 1, critical: 10 },
}

/**
 * Counters deliberately left without a threshold *and* worth saying so about.
 *
 * `captureUnsupported` is the one that matters: it counts sessions where the browser could not capture audio,
 * which is a **support signal** — someone on an old browser — and not a failure of this product. A threshold
 * on it would turn "three people used Safari 14" into an incident.
 */
const SUPPORT_SIGNAL_COUNTERS = new Set(['captureUnsupported', 'captureRemote', 'captureInPerson'])

function buildReliability(
  range: AdminMetricRange,
  variant: string,
  now: Date,
): AdminMetricSectionPayload {
  if (variant === 'availability') return unavailable('insufficient_history')

  const anyCapability = [
    env.CALENDAR_ENABLED,
    env.SCHEDULING_ENABLED,
    env.CANDIDATE_UPLOADS_ENABLED,
    env.INTERVIEW_TRANSCRIPTION_ENABLED,
    env.SENSITIVE_AI_ENABLED,
  ].some((flag) => flag === 'true')
  if (!anyCapability) return unavailable('not_enabled')

  const snapshot = metrics.get()
  const identity = processIdentity()
  /**
   * Derived from `interviewOperatorCounters`, not listed by hand.
   *
   * `metrics.ts` already carries the note about why: a counter added later would increment correctly, reset
   * correctly, and silently never reach the page an operator looks at. The same trap applies one layer up, so
   * the keys come from the same derivation the legacy endpoint uses.
   *
   * Every value is `scope: 'process'` with its identity, which is the per-process reset scope the task asks
   * for — these are cumulative since boot, they are one instance's, and a deploy zeroes them.
   */
  const values: AdminMetricValues = Object.entries(interviewOperatorCounters(snapshot)).map(([key, value]) => ({
    key: toMetricKey(key),
    value,
    unit: 'count' as const,
    scope: 'process' as const,
    processIdentity: identity,
    ...(SUPPORT_SIGNAL_COUNTERS.has(key) ? {} : threshold(key)),
  }))

  return {
    status: 'ready',
    generatedAt: now.toISOString(),
    // From this process's start, because that is when these counters were last zero.
    window: windowFor(range, now, new Date(identity.startedAt)),
    data: { values: values.slice(0, 24) },
  }
}

function threshold(key: string) {
  const found = THRESHOLDED_INTERVIEW_COUNTERS[key]
  return found ? { threshold: found } : {}
}

/** `documentBacklog` to `document_backlog`: the contract's keys are lower_snake_case and the parser enforces it. */
function toMetricKey(camel: string): string {
  return camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}
