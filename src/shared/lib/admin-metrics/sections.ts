import type { AdminMetricRange, AdminMetricSection, AdminMetricSectionPayload } from './contracts'
import { ACTION_QUEUE_SEVERITIES, ADMIN_METRIC_LIMITS } from './contracts'
import type { ActionQueueSeverity } from './contracts'
import { LATENCY_BOUNDARIES_MS, LATENCY_SLOTS, percentileFrom } from './history'
import { interviewOperatorCounters, metrics } from '../metrics'
import { env } from '../env'
import { getOnboardingActivationMetrics, getPlatformAccountMetrics } from '../repositories/platform-billing'
import { getDiscoveryState } from '../repositories/discovery-state'
import { readServiceMetricFreshness, readServiceMetricWindow } from '../repositories/service-metrics'
import { listLatestJobRuns, listScheduleRegistry } from '../repositories/platform-operations'
import { listSearchSources } from '../repositories/search-sources'
import { listSolutionSources } from '../repositories/solution-catalog'
import { getRemovalOperationsMetrics } from '../repositories/profile-removal'
import { countAbuseSignalsBySeverity } from '../repositories/abuse-signals'
import { countBillingWebhookEventsByStatus } from '../repositories/billing-events'
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
    case 'operations':
      return buildOperations(range, input.variant, now)
    case 'trust':
      return buildTrust(range, input.variant, now)
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

  const [accounts, onboarding, queue] = await Promise.all([
    getPlatformAccountMetrics(since, weekAgo),
    getOnboardingActivationMetrics(weekAgo),
    buildActionQueue(now),
  ])

  /**
   * A source that could not be read leaves the section `partial` rather than silently shortening the queue.
   *
   * This is the distinction the whole envelope exists for: an empty queue means nothing needs attention, and a
   * *shortened* queue means something might and we could not tell. Collapsing the two would make an unreadable
   * billing table look like a quiet afternoon — on the panel an operator reads first.
   */
  const dbCount = { unit: 'count' as const, scope: 'database' as const, platformTotal: true }
  const body = {
    values: [
      { key: 'users_total', value: accounts.totalUsers, ...dbCount },
      { key: 'users_new_24h', value: accounts.newUsersLast24h, ...dbCount },
      { key: 'users_new_7d', value: accounts.newUsersLast7d, ...dbCount },
      { key: 'onboarding_completed', value: onboarding.onboardingCompleted, ...dbCount },
      { key: 'onboarding_skipped', value: onboarding.onboardingSkipped, ...dbCount },
    ],
    queue: queue.rows,
  }

  if (queue.unreadableSources.length > 0) {
    return { status: 'partial', generatedAt: now.toISOString(), window, code: 'error', data: body }
  }
  return { status: 'ready', generatedAt: now.toISOString(), window, data: body }
}

/**
 * The Platform Action Queue (plan 57, Admin track — "Build the Platform Action Queue and service-health
 * widgets").
 *
 * ## Why it lives on Overview
 *
 * Because `/admin` resolves to `/admin/metrics` and Overview is what that loads first, so this is the panel an
 * operator sees on arrival. The maintainer's "índice = metrics" note is the reason there is no separate landing
 * page to put it on — and it is the better placement anyway: a queue on a page nobody opens first is a queue.
 *
 * ## The ordering, and why counts rather than rows
 *
 * Severity first, from the schema's own ordered list, then count. Each row is a *kind* of attention with a count
 * and an age, never the individual items: a queue of incidents would carry an organization id or a failing
 * event's payload onto the page with the most authority behind it, and this plan's rule keeps that on the
 * authorized detail pages. "Four dead-lettered events, oldest six hours" is the whole decision — whether to open
 * the page.
 *
 * ## Every row has to earn its place
 *
 * A row is emitted only when its count is above zero, so the queue is never a list of reassurances. An empty
 * queue is a real answer and a short one is not: a source that failed to read is reported through
 * `unreadableSources`, which makes the section `partial` instead of quietly dropping a row.
 */
interface ActionQueueRow {
  key: string
  severity: ActionQueueSeverity
  count: number
  oldestAgeSeconds?: number
  href: string
}

async function buildActionQueue(now: Date): Promise<{ rows: ActionQueueRow[]; unreadableSources: string[] }> {
  const unreadableSources: string[] = []
  const rows: ActionQueueRow[] = []

  const [billing, abuse, schedules, searchSources, removals] = await Promise.all([
    countBillingWebhookEventsByStatus().catch(() => {
      unreadableSources.push('billing')
      return null
    }),
    countAbuseSignalsBySeverity(new Date(now.getTime() - RANGE_MS['24h'])).catch(() => {
      unreadableSources.push('abuse')
      return null
    }),
    listScheduleRegistry().catch(() => {
      unreadableSources.push('schedules')
      return null
    }),
    listSearchSources().catch(() => {
      unreadableSources.push('sources')
      return null
    }),
    /**
     * Skipped entirely, not attempted and discarded, while the capability is off.
     *
     * A disabled feature is not an unreadable source: reporting it in `unreadableSources` would make the section
     * `partial` forever on any deployment with removals switched off, and `partial` means "we could not tell".
     */
    env.PROFILE_REMOVAL_ENABLED === 'true'
      ? getRemovalOperationsMetrics(now).catch(() => {
          unreadableSources.push('removals')
          return null
        })
      : Promise.resolve(null),
  ])

  // Money first: a dead-lettered webhook is an entitlement or a payment that did not apply, and it does not
  // resolve on its own.
  if (billing && billing.failed > 0) {
    rows.push({ key: 'billing_events_dead_lettered', severity: 'critical', count: billing.failed, href: '/admin/billing' })
  }
  if (billing && billing.processing > 0) {
    // Nothing has reported an outcome, which is what a crashed worker looks like.
    rows.push({ key: 'billing_events_stuck', severity: 'high', count: billing.processing, href: '/admin/billing' })
  }

  // A missed legal deadline outranks a backlog, which is why this is critical and the pending count is not here
  // at all — a queue getting long is not an action.
  if (removals && removals.overduePendingCount > 0) {
    rows.push({
      key: 'removal_requests_overdue',
      severity: 'critical',
      count: removals.overduePendingCount,
      // There is no dedicated removals page; Operations is where the sweep that should have cleared them runs.
      href: '/admin/operations',
    })
  }

  if (abuse) {
    const urgent = (abuse.get('critical') ?? 0) + (abuse.get('high') ?? 0)
    if (urgent > 0) {
      rows.push({ key: 'abuse_signals_urgent', severity: 'high', count: urgent, href: '/admin/abuse' })
    }
  }

  if (schedules) {
    const enabled = schedules.filter((schedule) => schedule.enabled)
    const overdue = enabled.filter(
      (schedule) => schedule.nextRunAt !== null && schedule.nextRunAt.getTime() < now.getTime(),
    )
    if (overdue.length > 0) {
      /**
       * The age of the *oldest* missed run, which is the number that separates a blip from an outage.
       *
       * A job three minutes late is a slow tick; the same job three days late means the worker has not run since
       * a deploy. The count alone cannot tell those apart.
       */
      const oldest = Math.max(...overdue.map((schedule) => now.getTime() - schedule.nextRunAt!.getTime()))
      rows.push({
        key: 'workers_overdue',
        severity: 'high',
        count: overdue.length,
        oldestAgeSeconds: Math.floor(oldest / 1000),
        href: '/admin/operations',
      })
    }
  }

  if (searchSources) {
    const enabled = searchSources.filter((source) => source.enabled)
    const dead = enabled.filter((source) => !source.connectorImplemented).length
    if (dead > 0) {
      // A source switched on with no code to contact it: believed live, will never reach anything.
      rows.push({ key: 'sources_enabled_without_connector', severity: 'medium', count: dead, href: '/admin/sources' })
    }
    const unreviewed = enabled.filter((source) => source.termsReviewedAt === null).length
    if (unreviewed > 0) {
      rows.push({ key: 'sources_terms_unreviewed', severity: 'medium', count: unreviewed, href: '/admin/sources' })
    }
  }

  /**
   * Sorted by severity then count, and truncated at the contract's cap.
   *
   * The sort key comes from `ACTION_QUEUE_SEVERITIES.indexOf` rather than a local map, so the order a client
   * renders in and the order the server sorts in are the same list. Slicing is a formality at today's source
   * count — there are eight possible rows and the cap is twelve — but it is applied rather than assumed, because
   * "we will never exceed it" is how a bound stops being one.
   */
  rows.sort((a, b) => {
    const bySeverity = ACTION_QUEUE_SEVERITIES.indexOf(a.severity) - ACTION_QUEUE_SEVERITIES.indexOf(b.severity)
    return bySeverity !== 0 ? bySeverity : b.count - a.count
  })

  return { rows: rows.slice(0, ADMIN_METRIC_LIMITS.queueRows), unreadableSources }
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

/**
 * Worker and integration health (plan 57, Admin track — "Build Worker and Integration Health admin widgets").
 *
 * ## Why this reads the registries rather than a rollup table
 *
 * The projection the Command Center task named reads eight `platform_*` tables that appear in no migration, so
 * it has never executed. These two registries are real and are the source `/admin/operations` and
 * `/admin/integrations` already read — which also means this section cannot disagree with those pages, and a
 * summary that disagrees with the page it summarises is the failure this plan has a receipt for:
 * `/admin/integrations` once showed two retired sources as ACTIVE because it was assembled from a compile-time
 * registry nobody updated.
 *
 * ## Why it links to Operations and Integrations and never to a worker route
 *
 * The task says so, and the reason is that a metrics page is read under time pressure. A drill-down that POSTs
 * to `run-worker` is a button that *does* something next to a number that says something is wrong, and the two
 * get confused. The breach drill-down in `MetricSectionView` goes to the screens that show state.
 */
async function buildOperations(
  range: AdminMetricRange,
  variant: string,
  now: Date,
): Promise<AdminMetricSectionPayload> {
  const window = windowFor(range, now)
  const generatedAt = now.toISOString()
  const dbCount = { unit: 'count' as const, scope: 'database' as const, platformTotal: true }

  if (variant === 'integrations') {
    const registers = await Promise.all([
      listSearchSources().catch(() => null),
      listSolutionSources().catch(() => null),
    ])
    if (registers.some((register) => register === null)) return unavailable('error')
    const [searchSources, solutionSources] = registers as [
      Awaited<ReturnType<typeof listSearchSources>>,
      Awaited<ReturnType<typeof listSolutionSources>>,
    ]

    const enabledSearch = searchSources.filter((source) => source.enabled)
    const enabledSolutions = solutionSources.filter((source) => source.enabled)

    /**
     * The one number on this page that catches a source which is switched on and cannot work.
     *
     * `enabled` means "the next search will contact it"; `connectorImplemented` means there is code to contact
     * it *with*. A row with the first and not the second is a source an operator believes is live and which
     * will never reach anything — and it looks identical to a healthy one on the register page. Any non-zero
     * value here is worth reading, which is why the threshold starts at 1 rather than at a rate.
     */
    const enabledWithoutConnector = enabledSearch.filter((source) => !source.connectorImplemented).length

    /**
     * An enabled source whose terms nobody has reviewed.
     *
     * Two of the job feeds say outright that they will suspend API access if a link-back is missing, so this is
     * not paperwork: it is an obligation taken on at the moment the source was switched on. Also warned at 1.
     */
    const enabledUnreviewed = [...enabledSearch, ...enabledSolutions].filter(
      (source) => source.termsReviewedAt === null,
    ).length

    const values: AdminMetricValues = [
      { key: 'sources_registered', value: searchSources.length + solutionSources.length, ...dbCount },
      { key: 'sources_enabled', value: enabledSearch.length + enabledSolutions.length, ...dbCount },
      {
        key: 'sources_enabled_without_connector',
        value: enabledWithoutConnector,
        ...dbCount,
        threshold: { direction: 'higher_is_worse', warn: 1, critical: 3 },
      },
      {
        key: 'sources_enabled_terms_unreviewed',
        value: enabledUnreviewed,
        ...dbCount,
        threshold: { direction: 'higher_is_worse', warn: 1, critical: 5 },
      },
    ]
    return { status: 'ready', generatedAt, window, data: { values } }
  }

  // `workers`, the default.
  const schedules = await listScheduleRegistry().catch(() => null)
  if (!schedules) return unavailable('error')
  /**
   * An empty registry is `dependency_unavailable`, not a row of zeros.
   *
   * The registry is migration-managed and synced from a code-owned list, so "no schedules" means the sync has
   * never run — not that this platform has no jobs. "0 overdue" over an empty registry reads as healthy and is
   * the strongest possible version of the lie this plan is about.
   */
  if (schedules.length === 0) return unavailable('dependency_unavailable')

  const runs = await listLatestJobRuns(schedules.map((schedule) => schedule.jobKey)).catch(() => null)
  if (!runs) return unavailable('error')

  const enabled = schedules.filter((schedule) => schedule.enabled)
  // Overdue is only meaningful for an enabled schedule: a paused one has no next run by design, and counting it
  // would make pausing a job look like a failure.
  const overdue = enabled.filter(
    (schedule) => schedule.nextRunAt !== null && schedule.nextRunAt.getTime() < now.getTime(),
  ).length
  const failed = enabled.filter((schedule) => runs.get(schedule.jobKey)?.state === 'failed').length
  const neverRan = enabled.filter((schedule) => !runs.get(schedule.jobKey)).length
  const failedItems = [...runs.values()].reduce((sum, run) => sum + (run.failedCount ?? 0), 0)

  const values: AdminMetricValues = [
    { key: 'jobs_registered', value: schedules.length, ...dbCount },
    { key: 'jobs_paused', value: schedules.length - enabled.length, ...dbCount },
    {
      key: 'jobs_overdue',
      value: overdue,
      ...dbCount,
      threshold: { direction: 'higher_is_worse', warn: 1, critical: 3 },
    },
    {
      key: 'jobs_failed_last_run',
      value: failed,
      ...dbCount,
      threshold: { direction: 'higher_is_worse', warn: 1, critical: 3 },
    },
    // Dormant, not failed: an enabled schedule with no run yet is waiting for its first occurrence, which is
    // normal right after a deploy and a problem only if it persists. Reported without a line drawn.
    { key: 'jobs_never_ran', value: neverRan, ...dbCount },
    // Items the last run could not process, summed. Distinct from a failed *run*: a run can finish while
    // leaving rows behind, and that is the shape nobody notices.
    {
      key: 'job_items_failed_last_run',
      value: failedItems,
      ...dbCount,
      threshold: { direction: 'higher_is_worse', warn: 1, critical: 25 },
    },
  ]

  return { status: 'ready', generatedAt, window, data: { values } }
}

/**
 * Trust, abuse and billing operations (plan 57, Admin track — "Build Billing, Abuse, Trust, and User Anomaly
 * admin widgets").
 *
 * ## What is here and what is deliberately not
 *
 * Three variants over three bounded aggregates. **User anomalies are absent**, and that is the honest answer
 * rather than an omission: the projection that task named reads `platform_user_anomalies`, a table that appears
 * in no migration, and nothing else in this codebase detects a suspicious sign-in or impossible travel. A
 * section reporting "0 anomalies" would say the detector found nothing when there is no detector.
 *
 * ## Every value is a count, and mutations stay on the detail pages
 *
 * No provider payload, no payment data, no abuse evidence, no subject or candidate content, no token, no stack
 * trace. The Verify line asks for exactly that, and the way it is guaranteed is that the aggregates *cannot*
 * return those columns — `countAbuseSignalsBySeverity` groups by severity and selects nothing else, so there is
 * no identity to leak rather than a filter that has to remember to drop it.
 *
 * ## Why billing does not come from `getBillingOperationsMetrics`
 *
 * That function walks every organization serially and was removed from every frequent path. A metrics section on
 * a refresh timer is the most frequent path there is. `countBillingWebhookEventsByStatus` is one grouped query
 * over a five-value enum for the part an operator acts on: how much is stuck.
 */
async function buildTrust(
  range: AdminMetricRange,
  variant: string,
  now: Date,
): Promise<AdminMetricSectionPayload> {
  const window = windowFor(range, now)
  const generatedAt = now.toISOString()
  const dbCount = { unit: 'count' as const, scope: 'database' as const, platformTotal: true }

  if (variant === 'abuse') {
    const counts = await countAbuseSignalsBySeverity(new Date(window.from)).catch(() => null)
    if (!counts) return unavailable('error')

    /**
     * A distribution, and the total beside it.
     *
     * `critical` and `high` carry thresholds because any of either is worth reading; the lower severities are
     * volume. The keys come from the severities actually present, and each was validated against a strict
     * pattern in the repository — so an arbitrary value written into the column cannot become a metric key and
     * put unbounded label cardinality on the page.
     */
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
    const values: AdminMetricValues = [{ key: 'abuse_signals', value: total, ...dbCount }]
    for (const [severity, value] of [...counts.entries()].sort()) {
      values.push({
        key: `abuse_signals_${severity}`,
        value,
        ...dbCount,
        ...(severity === 'critical' || severity === 'high'
          ? { threshold: { direction: 'higher_is_worse' as const, warn: 1, critical: 10 } }
          : {}),
      })
    }
    // Nothing recorded in the window is genuinely nothing — the signals are written on every detection, so an
    // empty window means no detections rather than no detector.
    return { status: 'ready', generatedAt, window, data: { values: values.slice(0, 24) } }
  }

  if (variant === 'billing') {
    const counts = await countBillingWebhookEventsByStatus().catch(() => null)
    if (!counts) return unavailable('error')

    const values: AdminMetricValues = [
      { key: 'billing_events_pending', value: counts.pending, ...dbCount },
      {
        /**
         * The dead-letter figure, and the one an operator acts on.
         *
         * A failed webhook event is money or an entitlement that did not apply, so any non-zero value is worth
         * reading — a rate would hide one failure in a busy hour, which is the one that matters to whoever paid.
         */
        key: 'billing_events_failed',
        value: counts.failed,
        ...dbCount,
        threshold: { direction: 'higher_is_worse', warn: 1, critical: 10 },
      },
      // Stuck in `processing` is distinct from failed: nothing has reported an outcome, which is what a crashed
      // worker looks like, and it never resolves on its own.
      {
        key: 'billing_events_processing',
        value: counts.processing,
        ...dbCount,
        threshold: { direction: 'higher_is_worse', warn: 1, critical: 5 },
      },
      { key: 'billing_events_processed', value: counts.processed, ...dbCount },
      { key: 'billing_events_ignored', value: counts.ignored, ...dbCount },
    ]
    return { status: 'ready', generatedAt, window, data: { values } }
  }

  // `removals`, the default.
  /**
   * The door comes before the numbers, and I got this wrong first.
   *
   * With `PROFILE_REMOVAL_ENABLED` off nobody can file a removal request, so every count is zero *by
   * construction* — and "0 pending" renders as an empty queue rather than as a shut door. That is the exact lie
   * `/api/admin/metrics` has carried a comment about since it was written, which omits its whole `removals` block
   * for this reason. The first version of this section skipped the check and returned five zeros against the real
   * database; running it is what caught it, because five zeros look identical to a clean queue.
   */
  if (env.PROFILE_REMOVAL_ENABLED !== 'true') return unavailable('not_enabled')

  const removals = await getRemovalOperationsMetrics(now).catch(() => null)
  if (!removals) return unavailable('error')

  const values: AdminMetricValues = [
    { key: 'removal_requests', value: removals.totalRequests, ...dbCount },
    { key: 'removal_pending', value: removals.byStatus.pending, ...dbCount },
    {
      /**
       * Pending requests already past their own deadline — work the scheduled sweep should have cleared.
       *
       * This is a legal-deadline breach rather than a backlog, which is why one is warned on: the aging is not a
       * queue getting long, it is a commitment already missed.
       */
      key: 'removal_overdue',
      value: removals.overduePendingCount,
      ...dbCount,
      threshold: { direction: 'higher_is_worse', warn: 1, critical: 5 },
    },
    { key: 'removal_expired', value: removals.byStatus.expired, ...dbCount },
    { key: 'removal_active_suppressions', value: removals.activeSuppressions, ...dbCount },
  ]
  return { status: 'ready', generatedAt, window, data: { values } }
}
