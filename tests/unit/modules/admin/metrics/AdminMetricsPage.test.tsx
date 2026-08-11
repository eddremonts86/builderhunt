/**
 * The Admin Metrics page, after the lazy-shell rebuild (plan 57, Admin track).
 *
 * ## Why these cases render a *section* rather than "the page"
 *
 * They used to render the page and assert that the conversion funnel, the removal pipeline and the runtime
 * counters were all on screen — because they all were, at once, on every load. That is the thing the rebuild
 * removed: exactly one section is fetched now, chosen by the URL. So a case about the funnel names
 * `section="conversion"`, which is also a better test than it was: it exercises the widget rather than the
 * page's default tab.
 *
 * Every honesty assertion from before is still here — no fabricated confidence interval, a small cohort folded
 * into "Other" rather than named, absent interview counters instead of zeros, a process counter that says it is
 * not a platform total. What changed is which tab they live on.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { AdminMetricsPage } from '~/modules/admin/metrics/AdminMetricsPage'
import type { AdminMetricsUrlState } from '~/shared/lib/admin-metrics/url-state'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as Response
}

const METRICS_RESPONSE = {
  generatedAt: '2027-01-01T10:30:00.000Z',
  // 3725s = 1h 2m 5s, so a test can tell a formatted uptime from a raw number of seconds.
  inProcess: { searches: 0, searchCacheHits: 0, apiRequests: 0, apiErrors: 0, signups: 0, signins: 0, uptimeSeconds: 3725 },
  db: { totalUsers: 1, newUsersLast24h: 0, newUsersLast7d: 1 },
  discovery: null,
  interviews: { capabilities: { calendar: false, scheduling: false, candidateUploads: false, transcription: false, sensitiveAi: false } },
  server: { nodeVersion: 'v1', platform: 'darwin', pid: 4821, memoryUsage: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 } },
}

const PROCESS_IDENTITY = { pid: 4821, startedAt: '2027-01-01T09:27:55.000Z', instance: 'test-instance' }
const WINDOW = {
  range: '24h' as const,
  from: '2026-12-31T10:30:00.000Z',
  to: '2027-01-01T10:30:00.000Z',
  timezone: 'UTC',
}

/** A ready section payload, wrapped in the response envelope the hook parses. */
function sectionResponse(section: string, values: unknown[], extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    section,
    variant: 'summary',
    payload: {
      status: 'ready',
      generatedAt: METRICS_RESPONSE.generatedAt,
      window: WINDOW,
      data: { values, ...extra },
    },
  }
}

function unavailableResponse(section: string, code: string) {
  return { schemaVersion: 1, section, variant: 'summary', payload: { status: 'unavailable', code } }
}

const OVERVIEW_VALUES = [
  { key: 'users_total', value: 1, unit: 'count', scope: 'database', platformTotal: true },
  { key: 'users_new_24h', value: 0, unit: 'count', scope: 'database', platformTotal: true },
]

const RUNTIME_VALUES = [
  { key: 'api_requests', value: 12, unit: 'count', scope: 'process', processIdentity: PROCESS_IDENTITY },
  { key: 'api_errors', value: 0, unit: 'count', scope: 'process', processIdentity: PROCESS_IDENTITY },
]

interface TestConversionRate {
  numerator: number
  denominator: number
  rate: number | null
  ci95: [number, number] | null
  insufficientSample: boolean
  numeratorEvent: string
  denominatorEvent: string
}

function emptyConversionMetrics(): Record<string, TestConversionRate> {
  const zero = { numerator: 0, denominator: 0, rate: null as number | null, ci95: null as [number, number] | null, insufficientSample: true }
  return {
    landing_to_signup: { ...zero, numeratorEvent: 'signup_complete', denominatorEvent: 'landing_view' },
    hero_signup_ctr: { ...zero, numeratorEvent: 'hero_signup_click', denominatorEvent: 'landing_view' },
    hero_explore_ctr: { ...zero, numeratorEvent: 'hero_explore_click', denominatorEvent: 'landing_view' },
    explore_search_completion: { ...zero, numeratorEvent: 'explore_search_complete', denominatorEvent: 'hero_explore_click' },
    explore_to_signup_ctr: { ...zero, numeratorEvent: 'explore_signup_click', denominatorEvent: 'explore_search_complete' },
    signup_completion: { ...zero, numeratorEvent: 'signup_complete', denominatorEvent: 'signup_submit' },
  }
}

function emptyConversionResponse(variant: 'baseline' | 'treatment') {
  return { start: '2027-01-01', end: '2027-01-15', variant, metrics: emptyConversionMetrics() }
}

function emptyRemovalMetrics() {
  return {
    totalRequests: 0,
    byStatus: { pending: 0, verified: 0, rejected: 0, expired: 0 },
    bySource: [],
    otherSourcesCount: 0,
    pendingAging: { underOneDay: 0, oneToSevenDays: 0, sevenToThirtyDays: 0, overThirtyDays: 0 },
    overduePendingCount: 0,
    activeSuppressions: 0,
    generatedAt: '2027-01-01T00:00:00.000Z',
  }
}

/**
 * Routes every endpoint the page can reach.
 *
 * `sections` is the one the shell itself calls; the others belong to individual widgets. Keeping them all here
 * means a case can assert that a widget's endpoint was *not* called, which is what "fetch only the visible
 * section" actually means.
 */
function mockFetchRouter(options: {
  section?: unknown
  conversion?: { baseline: unknown; treatment: unknown } | 'error'
  removal?: unknown | 'error'
} = {}): void {
  const { section = sectionResponse('overview', OVERVIEW_VALUES), conversion = { baseline: emptyConversionResponse('baseline'), treatment: emptyConversionResponse('treatment') }, removal = emptyRemovalMetrics() } = options

  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/admin/metrics/sections')) {
      if (section === 'error') return jsonResponse({ error: 'Forbidden' }, false, 403)
      return jsonResponse(section)
    }
    if (url.includes('/api/admin/metrics/conversion')) {
      if (conversion === 'error') return jsonResponse({ error: 'Forbidden' }, false, 403)
      const variant = url.includes('variant=treatment') ? 'treatment' : 'baseline'
      return jsonResponse(conversion[variant])
    }
    if (url.includes('/api/admin/metrics/trust')) {
      if (removal === 'error') return jsonResponse({ error: 'Forbidden' }, false, 403)
      return jsonResponse(removal)
    }
    return jsonResponse(METRICS_RESPONSE)
  })
}

async function render(search: Partial<AdminMetricsUrlState> = {}) {
  const rootRoute = createRootRoute({ component: () => <AdminMetricsPage {...search} /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
  /**
   * Six flushes, because a section is three *chained* asynchronous steps and each needs its own.
   *
   * The shell's fetch, then the `React.lazy` chunk resolving, then the widget's own fetch inside its effect —
   * and each of those settles a promise whose continuation schedules the next. Two flushes was enough for the
   * cases that only needed the first two steps and left the third unrendered, so a widget that worked failed
   * its assertion and read as a component bug. Six is comfortably past the longest chain here rather than
   * exactly it, so adding a step to a widget does not silently start failing unrelated cases.
   */
  for (let flush = 0; flush < 6; flush += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

function testId(id: string): Element | null {
  return container!.querySelector(`[data-testid="${id}"]`)
}

function urlsFetched(): string[] {
  return vi.mocked(fetch).mock.calls.map(([input]) => String(input))
}

describe('AdminMetricsPage — only the visible section is fetched', () => {
  it('requests the section in the URL and nothing for the other seven', async () => {
    /**
     * The whole point of the rebuild. Before it, opening this page ran a platform billing sweep, an interview
     * capability read and a removal aggregate on a fifteen-second timer regardless of what was being looked at
     * — so the expensive query nobody wanted was indistinguishable from the one they did.
     */
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: sectionResponse('traffic', [{ key: 'requests', value: 5, unit: 'count', scope: 'database', platformTotal: true }]) })

    await render({ section: 'traffic', range: '24h', variant: 'rate' })

    const urls = urlsFetched()
    expect(urls.filter((url) => url.includes('section=traffic'))).toHaveLength(1)
    // No funnel, no removal pipeline, no monolith.
    expect(urls.some((url) => url.includes('/conversion'))).toBe(false)
    expect(urls.some((url) => url.includes('/trust'))).toBe(false)
  })

  it('carries the range and variant into the request rather than defaulting them server-side', async () => {
    // A bookmarked `?range=7d&variant=latency` that silently fetched 24h/rate would render a plausible wrong
    // panel, and the operator would have no way to tell.
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: sectionResponse('traffic', []) })

    await render({ section: 'traffic', range: '7d', variant: 'latency' })

    const url = urlsFetched().find((candidate) => candidate.includes('/sections'))
    expect(url).toContain('range=7d')
    expect(url).toContain('variant=latency')
  })

  it('marks the active section and window so a restored URL is visibly restored', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: sectionResponse('search', []) })

    await render({ section: 'search', range: '30d', variant: 'quality' })

    expect(testId('admin-metrics-section-search')?.getAttribute('data-active')).toBe('true')
    expect(testId('admin-metrics-range-30d')?.getAttribute('data-active')).toBe('true')
    expect(testId('admin-metrics-variant-quality')?.getAttribute('data-active')).toBe('true')
  })

  it('renders no variant picker for a section with only one shape', async () => {
    // A single disabled control is a control that does nothing. Overview has one variant.
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()
    await render({ section: 'overview' })
    expect(testId('admin-metrics-variants')).toBeNull()
  })
})

describe('AdminMetricsPage — a missing source is never a zero', () => {
  it('explains an unavailable section instead of rendering numbers', async () => {
    /**
     * The lie of implication this plan is about. "Requests: 0, errors: 0" over a window with no data reads as a
     * healthy idle platform; it means nothing was measured.
     */
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: unavailableResponse('conversion', 'insufficient_history') })

    await render({ section: 'conversion', variant: 'funnel' })

    expect(testId('metric-section-unavailable-insufficient_history')).not.toBeNull()
    expect(testId('metric-values')).toBeNull()
  })

  it('says a section failed rather than showing the previous section stale', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: 'error' })

    await render({ section: 'traffic', variant: 'rate' })

    expect(testId('metric-section-load-error')?.textContent).toContain('403')
    expect(testId('metric-values')).toBeNull()
  })
})

describe('AdminMetricsPage — a process counter says it is not a platform total', () => {
  it('states the scope beside each number, not in a legend or a card at the bottom', async () => {
    /**
     * plans/ui-dashboard spec §7, "restart-scoped semantics". These counters start at zero when the process
     * starts, they are per-instance, and a deploy resets them. Next to Overview's database totals an
     * unlabelled per-instance counter is a wrong number — after a deploy "API requests: 0" means this process
     * has served none, not that the platform has.
     */
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: sectionResponse('runtime', RUNTIME_VALUES) })

    await render({ section: 'runtime', variant: 'process' })

    const scope = testId('metric-scope-api_requests')
    expect(scope?.textContent).toContain('not a platform total')
    expect(scope?.textContent).toContain('4821')
    expect(testId('metric-value-api_requests')?.getAttribute('data-scope')).toBe('process')
  })

  it('marks a database aggregate as the platform total it is', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()
    await render({ section: 'overview' })

    expect(testId('metric-scope-users_total')?.textContent).toContain('platform total')
    expect(testId('metric-value-users_total')?.textContent).toContain('1')
  })

  it('demotes the process diagnostics to a closed disclosure that has not fetched anything yet', async () => {
    /**
     * Node version and heap sizes answer "is this process unhealthy" — real, but not what an operator opens
     * this page to ask. Nothing was deleted; they are one click away.
     *
     * And the request is one click away too. They come from `/api/admin/metrics`, the legacy compatibility
     * endpoint, which also runs two account aggregates and a discovery read to answer — so fetching them on
     * mount would pay for all of that to render a Node version nobody expanded.
     */
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: sectionResponse('runtime', RUNTIME_VALUES) })

    await render({ section: 'runtime', variant: 'process' })

    const diagnostics = testId('metrics-server-diagnostics') as HTMLDetailsElement
    expect(diagnostics.tagName.toLowerCase()).toBe('details')
    expect(diagnostics.open).toBe(false)
    expect(testId('metrics-server-diagnostics-pending')?.textContent).toContain('Expand to read')
    expect(urlsFetched().some((url) => url.endsWith('/api/admin/metrics'))).toBe(false)
  })

  it('reads the diagnostics once the disclosure is opened', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: sectionResponse('runtime', RUNTIME_VALUES) })
    await render({ section: 'runtime', variant: 'process' })

    const diagnostics = testId('metrics-server-diagnostics') as HTMLDetailsElement
    await act(async () => {
      diagnostics.open = true
      diagnostics.dispatchEvent(new Event('toggle'))
    })
    for (let flush = 0; flush < 4; flush += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    }

    expect(urlsFetched().some((url) => url.endsWith('/api/admin/metrics'))).toBe(true)
    expect(diagnostics.textContent).toContain('Node')
  })

  it('reports when the server read the numbers, not when the page asked', async () => {
    // The aggregates are computed per request. Without this the page could only say when it asked, which
    // diverges from when the server answered under exactly the load where it matters.
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()
    await render({ section: 'overview' })

    expect(testId('metric-section-generated-at')?.textContent).toContain(
      new Date(METRICS_RESPONSE.generatedAt).toLocaleTimeString(),
    )
  })

  it('prints the window and its timezone, because an aggregate without a period is not a measurement', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()
    await render({ section: 'overview' })
    expect(testId('metric-section-window')?.textContent).toContain('UTC')
  })
})

describe('AdminMetricsPage — thresholds are read in their stated direction', () => {
  it('flags a high error rate and a cold cache as breaches, in opposite directions', async () => {
    /**
     * `higher_is_worse` and `lower_is_worse` are both real. Colouring one by the other's rule would raise a
     * warning on healthy numbers and stay silent on the bad ones — which is worse than having no thresholds,
     * because an operator learns to ignore it.
     */
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      section: sectionResponse('traffic', [
        { key: 'error_rate', value: 0.2, unit: 'ratio', scope: 'database', platformTotal: true, threshold: { direction: 'higher_is_worse', warn: 0.01, critical: 0.05 } },
        { key: 'search_cache_hit_rate', value: 0.05, unit: 'ratio', scope: 'database', platformTotal: true, threshold: { direction: 'lower_is_worse', warn: 0.4, critical: 0.1 } },
      ]),
    })

    await render({ section: 'traffic', variant: 'errors' })

    expect(testId('metric-value-error_rate')?.getAttribute('data-breach')).toBe('critical')
    expect(testId('metric-value-search_cache_hit_rate')?.getAttribute('data-breach')).toBe('critical')
  })

  it('leaves a healthy value unflagged in both directions', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      section: sectionResponse('traffic', [
        { key: 'error_rate', value: 0.001, unit: 'ratio', scope: 'database', platformTotal: true, threshold: { direction: 'higher_is_worse', warn: 0.01, critical: 0.05 } },
        { key: 'search_cache_hit_rate', value: 0.9, unit: 'ratio', scope: 'database', platformTotal: true, threshold: { direction: 'lower_is_worse', warn: 0.4, critical: 0.1 } },
      ]),
    })

    await render({ section: 'traffic', variant: 'errors' })

    expect(testId('metric-value-error_rate')?.getAttribute('data-breach')).toBeNull()
    expect(testId('metric-value-search_cache_hit_rate')?.getAttribute('data-breach')).toBeNull()
  })

  it('prints a unit with every value, because the number alone does not say which one', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      section: sectionResponse('traffic', [
        { key: 'latency_p95_ms', value: 250, unit: 'milliseconds', scope: 'database', platformTotal: true },
        { key: 'requests_per_second', value: 3.5, unit: 'per_second', scope: 'database', platformTotal: true },
        { key: 'error_rate', value: 0.02, unit: 'ratio', scope: 'database', platformTotal: true },
      ]),
    })

    await render({ section: 'traffic', variant: 'latency' })

    expect(testId('metric-value-latency_p95_ms')?.textContent).toContain('250 ms')
    expect(testId('metric-value-requests_per_second')?.textContent).toContain('3.50/s')
    expect(testId('metric-value-error_rate')?.textContent).toContain('2.0%')
  })
})

describe('AdminMetricsPage — comparison', () => {
  it('offers the toggle only for the sections whose builder reads a second window', async () => {
    /**
     * A control that changes nothing is worse than its absence: an operator would read the unchanged numbers
     * as "no change". A process counter has no previous window, and the two sections with no history have
     * nothing to compare.
     */
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: sectionResponse('traffic', []) })
    await render({ section: 'traffic', variant: 'rate' })
    expect(testId('admin-metrics-compare-toggle')).not.toBeNull()

    if (root) act(() => root!.unmount())
    container?.remove()
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: sectionResponse('runtime', RUNTIME_VALUES) })
    await render({ section: 'runtime', variant: 'process' })
    expect(testId('admin-metrics-compare-toggle')).toBeNull()
  })

  it('asks the server for the comparison rather than computing one client-side', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: sectionResponse('traffic', []) })
    await render({ section: 'traffic', variant: 'rate', compare: true })

    expect(urlsFetched().find((url) => url.includes('/sections'))).toContain('compare=true')
  })

  it('prints the earlier figure and the delta, not a percentage change', async () => {
    /**
     * "+100%" is what 1 error becoming 2 looks like, and on a small base that reads as a catastrophe. Both
     * absolute numbers are shown so the base is never implicit, and there is no arrow or colour — whether up
     * is good depends on the metric, and only the threshold knows that.
     */
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      section: sectionResponse('traffic', [
        { key: 'requests', value: 1200, unit: 'count', scope: 'database', platformTotal: true, previous: 1000 },
        { key: 'errors', value: 3, unit: 'count', scope: 'database', platformTotal: true, previous: 9 },
      ]),
    })
    await render({ section: 'traffic', variant: 'rate', compare: true })

    expect(testId('metric-previous-requests')?.textContent).toContain('1,000 previously')
    expect(testId('metric-previous-requests')?.textContent).toContain('+200')
    expect(testId('metric-previous-errors')?.textContent).toContain('−6')
    // No comparison where the payload carried none.
    expect(testId('metric-previous-instances_reporting')).toBeNull()
  })
})

describe('AdminMetricsPage — a breach points somewhere', () => {
  it('links to Operations and Incidents only when a threshold is actually crossed', async () => {
    // A page that always offers "check Operations" is offering navigation, not information.
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      section: sectionResponse('traffic', [
        { key: 'error_rate', value: 0.2, unit: 'ratio', scope: 'database', platformTotal: true, threshold: { direction: 'higher_is_worse', warn: 0.01, critical: 0.05 } },
      ]),
    })
    await render({ section: 'traffic', variant: 'errors' })

    expect(testId('metric-section-breach')?.textContent).toContain('Error rate has crossed')
    expect(testId('metric-section-operations-link')).not.toBeNull()
    expect(testId('metric-section-incidents-link')).not.toBeNull()
  })

  it('says nothing at all when every value is inside its threshold', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      section: sectionResponse('traffic', [
        { key: 'error_rate', value: 0.001, unit: 'ratio', scope: 'database', platformTotal: true, threshold: { direction: 'higher_is_worse', warn: 0.01, critical: 0.05 } },
      ]),
    })
    await render({ section: 'traffic', variant: 'errors' })

    expect(testId('metric-section-breach')).toBeNull()
  })
})

describe('AdminMetricsPage — the route-family ranking is bounded and carries no identifiers', () => {
  it('renders the families the payload named and nothing derived from a path', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      section: sectionResponse(
        'traffic',
        [{ key: 'requests', value: 30, unit: 'count', scope: 'database', platformTotal: true }],
        { ranked: [{ family: 'api.search', value: 20, unit: 'count' }, { family: 'api.sprints', value: 10, unit: 'count' }] },
      ),
    })

    await render({ section: 'traffic', variant: 'rate' })

    expect(testId('metric-ranked-api.search')).not.toBeNull()
    expect(testId('metric-ranked-api.sprints')?.textContent).toContain('10')
    // A family label, never `/api/sprints/<id>` — the allowlist is what keeps a real sprint id off this page.
    expect(testId('metric-ranked')?.textContent).not.toContain('/api/')
  })

  it('renders no ranking block at all when the section has none', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()
    await render({ section: 'overview' })
    expect(testId('metric-ranked')).toBeNull()
  })
})

describe('AdminMetricsPage — refresh only while visible', () => {
  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  function sectionFetchCount(): number {
    return urlsFetched().filter((url) => url.includes('/api/admin/metrics/sections')).length
  }

  afterEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  it('schedules no refresh timer at all while the tab starts hidden', async () => {
    /**
     * The refresh used to be an unconditional `setInterval`, so a tab left open in the background kept
     * querying the platform every fifteen seconds at nobody.
     */
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()

    await render({ section: 'overview' })

    // The first read still happens — an operator opening the page in a background tab and switching to it
    // should find numbers, not a spinner.
    expect(sectionFetchCount()).toBe(1)
    expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(0)
    setIntervalSpy.mockRestore()
  })

  it('clears the timer when the tab is hidden and re-reads immediately when it comes back', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()

    await render({ section: 'overview' })
    expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(1)
    expect(sectionFetchCount()).toBe(1)

    await act(async () => { setHidden(true) })
    expect(clearIntervalSpy).toHaveBeenCalled()

    await act(async () => { setHidden(false) })
    // Re-read on return, not on the next tick of a timer that has not fired yet: a returning tab is showing
    // numbers as old as the time it spent hidden.
    expect(sectionFetchCount()).toBe(2)
    expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(2)

    setIntervalSpy.mockRestore()
    clearIntervalSpy.mockRestore()
  })

  it('announces the outcome of a manual refresh, not the act of asking', async () => {
    // Nothing moves on a page of numbers when a refresh returns the same values, so a screen-reader user has
    // no way to tell a successful refresh from a button that did nothing.
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()
    await render({ section: 'overview' })

    expect(testId('admin-metrics-announcement')?.textContent).toBe('')

    await act(async () => {
      ;(testId('admin-metrics-refresh') as HTMLButtonElement).click()
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(testId('admin-metrics-announcement')?.textContent).toContain('Overview updated')
  })
})

describe('AdminMetricsPage — conversion funnel', () => {
  const healthy = (variant: 'baseline' | 'treatment') => ({
    start: '2027-01-01',
    end: '2027-01-15',
    variant,
    metrics: {
      ...emptyConversionMetrics(),
      landing_to_signup: { numerator: 120, denominator: 1000, rate: 0.12, ci95: [0.1, 0.14] as [number, number], insufficientSample: false, numeratorEvent: 'signup_complete', denominatorEvent: 'landing_view' },
    },
  })

  it('shows an honest empty state when no conversion events exist in the window', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: unavailableResponse('conversion', 'insufficient_history') })
    await render({ section: 'conversion', variant: 'funnel' })

    expect(testId('metrics-conversion-empty')?.textContent).toContain('No conversion events recorded')
  })

  it('shows a real rate with a "low n" flag for an insufficient sample, never a fabricated interval', async () => {
    const lowN = (variant: 'baseline' | 'treatment') => ({
      start: '2027-01-01',
      end: '2027-01-15',
      variant,
      metrics: {
        ...emptyConversionMetrics(),
        landing_to_signup: { numerator: 1, denominator: 3, rate: 1 / 3, ci95: null, insufficientSample: true, numeratorEvent: 'signup_complete', denominatorEvent: 'landing_view' },
      },
    })
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      section: unavailableResponse('conversion', 'insufficient_history'),
      conversion: { baseline: lowN('baseline'), treatment: lowN('treatment') },
    })
    await render({ section: 'conversion', variant: 'funnel' })

    const row = testId('metrics-conversion-row-landing_to_signup')
    expect(row?.textContent).toContain('33.3%')
    expect(row?.textContent).toContain('low n')
    // No interval invented for a sample that cannot support one.
    expect(row?.textContent).not.toContain('–')
  })

  it('renders a healthy funnel with confidence intervals and no anomaly banner', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      section: unavailableResponse('conversion', 'insufficient_history'),
      conversion: { baseline: healthy('baseline'), treatment: healthy('treatment') },
    })
    await render({ section: 'conversion', variant: 'funnel' })

    const row = testId('metrics-conversion-row-landing_to_signup')
    expect(row?.textContent).toContain('12.0%')
    expect(row?.textContent).toContain('10.0–14.0%')
    expect(testId('metrics-conversion-anomaly')).toBeNull()
  })

  it('flags a real zero-rate anomaly and links to Content', async () => {
    const zeroOnRealSample = (variant: 'baseline' | 'treatment') => ({
      start: '2027-01-01',
      end: '2027-01-15',
      variant,
      metrics: {
        ...emptyConversionMetrics(),
        landing_to_signup: { numerator: 0, denominator: 900, rate: 0, ci95: [0, 0.004] as [number, number], insufficientSample: false, numeratorEvent: 'signup_complete', denominatorEvent: 'landing_view' },
      },
    })
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      section: unavailableResponse('conversion', 'insufficient_history'),
      conversion: { baseline: zeroOnRealSample('baseline'), treatment: zeroOnRealSample('treatment') },
    })
    await render({ section: 'conversion', variant: 'funnel' })

    expect(testId('metrics-conversion-anomaly')).not.toBeNull()
    expect(testId('metrics-conversion-content-link')).not.toBeNull()
  })

  it('shows a degraded state and links to Operations when the conversion API errors', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: unavailableResponse('conversion', 'insufficient_history'), conversion: 'error' })
    await render({ section: 'conversion', variant: 'funnel' })

    expect(testId('metrics-conversion-error')?.textContent).toContain('403')
    expect(testId('metrics-conversion-operations-link')).not.toBeNull()
  })
})

describe('AdminMetricsPage — removal operations', () => {
  it('shows an honest empty state when no removal requests exist', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()
    await render({ section: 'overview' })

    expect(testId('metrics-removal-empty')?.textContent).toContain('No removal requests recorded yet')
  })

  it('folds a small-cohort source into "Other" instead of naming it', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      removal: {
        ...emptyRemovalMetrics(),
        totalRequests: 12,
        byStatus: { pending: 2, verified: 8, rejected: 1, expired: 1 },
        bySource: [{ source: 'github', count: 9 }],
        otherSourcesCount: 3,
      },
    })
    await render({ section: 'overview' })

    expect(testId('metrics-removal-by-source')?.textContent).toContain('github')
    expect(testId('metrics-removal-other-sources')?.textContent).toContain('3')
  })

  it('flags an overdue pending backlog and links to Operations', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      removal: { ...emptyRemovalMetrics(), totalRequests: 5, byStatus: { pending: 5, verified: 0, rejected: 0, expired: 0 }, overduePendingCount: 2 },
    })
    await render({ section: 'overview' })

    expect(testId('metrics-removal-overdue')?.textContent).toContain('2 pending requests')
    expect(testId('metrics-removal-overdue-link')).not.toBeNull()
  })

  it('shows a degraded state and links to Operations when the trust API errors', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ removal: 'error' })
    await render({ section: 'overview' })

    expect(testId('metrics-removal-error')?.textContent).toContain('403')
    expect(testId('metrics-removal-operations-link')).not.toBeNull()
  })
})

describe('AdminMetricsPage — interview counters are absent, not zero, while the door is shut', () => {
  it('renders the capability grid and no counters when every capability is off', async () => {
    /**
     * A zero here would read as "no problems" when it means "no traffic is possible". The API enforces the same
     * thing by omitting `counters`, so this is not the only guard — but it is the one a reader sees.
     */
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ section: unavailableResponse('reliability', 'insufficient_history') })
    await render({ section: 'reliability', variant: 'features' })

    expect(testId('metrics-interviews-capabilities')).not.toBeNull()
    expect(testId('interview-capability-calendar')?.textContent).toContain('off')
    expect(testId('metrics-interviews-disabled')).not.toBeNull()
    expect(testId('metric-card-booking-conflicts')).toBeNull()
  })
})
