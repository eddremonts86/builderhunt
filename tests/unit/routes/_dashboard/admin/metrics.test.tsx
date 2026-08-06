/**
 * plans/UI/tasks.md Wave 5 "Render conversion metrics in Admin Metrics".
 *
 * Empty, insufficient-sample, healthy, and degraded (API-error) fixtures for the conversion funnel
 * section — proves each renders honestly (never a fabricated rate) and that the degraded state
 * links to Operations, while a real zero-rate anomaly links to Content.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { AdminMetricsPage } from '~/routes/_dashboard/admin/metrics'

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
  inProcess: { searches: 0, searchCacheHits: 0, apiRequests: 0, apiErrors: 0, signups: 0, signins: 0, uptimeSeconds: 10 },
  db: { totalUsers: 1, newUsersLast24h: 0, newUsersLast7d: 1 },
  discovery: null,
  server: { nodeVersion: 'v1', platform: 'darwin', pid: 1, memoryUsage: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 } },
}

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

function mockFetchRouter(
  conversionByVariant: { baseline: unknown; treatment: unknown } | 'error' = { baseline: emptyConversionResponse('baseline'), treatment: emptyConversionResponse('treatment') },
  removal: unknown | 'error' = emptyRemovalMetrics(),
): void {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/admin/metrics/conversion')) {
      if (conversionByVariant === 'error') return jsonResponse({ error: 'Forbidden' }, false, 403)
      const variant = url.includes('variant=treatment') ? 'treatment' : 'baseline'
      return jsonResponse(conversionByVariant[variant])
    }
    if (url.includes('/api/admin/metrics/trust')) {
      if (removal === 'error') return jsonResponse({ error: 'Forbidden' }, false, 403)
      return jsonResponse(removal)
    }
    return jsonResponse(METRICS_RESPONSE)
  })
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

async function render() {
  const rootRoute = createRootRoute({ component: () => <AdminMetricsPage /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function testId(id: string): Element | null {
  return container!.querySelector(`[data-testid="${id}"]`)
}

describe('AdminMetricsPage — conversion funnel', () => {
  it('shows an honest empty state when no conversion events exist in the window', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()
    await render()

    expect(testId('metrics-conversion-empty')?.textContent).toContain('No conversion events recorded')
  })

  it('shows a real rate with a "low n" flag for an insufficient sample, never a fabricated confidence interval', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const baseline = emptyConversionResponse('baseline')
    baseline.metrics.landing_to_signup = { numerator: 2, denominator: 10, rate: 0.2, ci95: null, insufficientSample: true, numeratorEvent: 'signup_complete', denominatorEvent: 'landing_view' }
    mockFetchRouter({ baseline, treatment: emptyConversionResponse('treatment') })
    await render()

    const row = testId('metrics-conversion-row-landing_to_signup')
    expect(row?.textContent).toContain('20.0%')
    expect(row?.textContent).toContain('low n')
  })

  it('renders a healthy funnel with confidence intervals and no anomaly banner', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const baseline = emptyConversionResponse('baseline')
    baseline.metrics.landing_to_signup = { numerator: 40, denominator: 200, rate: 0.2, ci95: [0.15, 0.26], insufficientSample: false, numeratorEvent: 'signup_complete', denominatorEvent: 'landing_view' }
    mockFetchRouter({ baseline, treatment: emptyConversionResponse('treatment') })
    await render()

    expect(testId('metrics-conversion-row-landing_to_signup')?.textContent).toContain('20.0%')
    expect(testId('metrics-conversion-anomaly')).toBeNull()
  })

  it('flags a real zero-rate anomaly and links to Content', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const baseline = emptyConversionResponse('baseline')
    baseline.metrics.hero_signup_ctr = { numerator: 0, denominator: 200, rate: 0, ci95: [0, 0.02], insufficientSample: false, numeratorEvent: 'hero_signup_click', denominatorEvent: 'landing_view' }
    mockFetchRouter({ baseline, treatment: emptyConversionResponse('treatment') })
    await render()

    expect(testId('metrics-conversion-anomaly')).not.toBeNull()
    expect((testId('metrics-conversion-content-link') as HTMLAnchorElement).textContent).toContain('review Content')
  })

  it('shows a degraded state and links to Operations when the conversion API errors', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter('error')
    await render()

    expect(testId('metrics-conversion-error')).not.toBeNull()
    expect((testId('metrics-conversion-operations-link') as HTMLAnchorElement).textContent).toContain('Check Operations')
  })
})

describe('AdminMetricsPage — removal operations', () => {
  it('shows an honest empty state when no removal requests exist', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter(undefined, emptyRemovalMetrics())
    await render()

    expect(testId('metrics-removal-empty')?.textContent).toContain('No removal requests recorded yet')
  })

  it('folds a small-cohort source into "Other" instead of naming it', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter(undefined, {
      ...emptyRemovalMetrics(),
      totalRequests: 3,
      byStatus: { pending: 3, verified: 0, rejected: 0, expired: 0 },
      bySource: [],
      otherSourcesCount: 3,
      pendingAging: { underOneDay: 3, oneToSevenDays: 0, sevenToThirtyDays: 0, overThirtyDays: 0 },
    })
    await render()

    const bySource = testId('metrics-removal-by-source')
    expect(bySource?.textContent).not.toMatch(/gitlab|github/i)
    expect(testId('metrics-removal-other-sources')?.textContent).toContain('3')
  })

  it('renders a healthy pipeline with named sources and no overdue banner', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter(undefined, {
      ...emptyRemovalMetrics(),
      totalRequests: 6,
      byStatus: { pending: 1, verified: 4, rejected: 0, expired: 1 },
      bySource: [{ source: 'github', count: 6 }],
      pendingAging: { underOneDay: 1, oneToSevenDays: 0, sevenToThirtyDays: 0, overThirtyDays: 0 },
      activeSuppressions: 4,
    })
    await render()

    expect(testId('metrics-removal-by-source')?.textContent).toContain('github')
    expect(testId('metrics-removal-overdue')).toBeNull()
    expect(testId('metrics-removal')?.textContent).toContain('4 active suppressions')
  })

  it('flags an overdue pending backlog and links to Operations', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter(undefined, {
      ...emptyRemovalMetrics(),
      totalRequests: 2,
      byStatus: { pending: 2, verified: 0, rejected: 0, expired: 0 },
      pendingAging: { underOneDay: 0, oneToSevenDays: 0, sevenToThirtyDays: 1, overThirtyDays: 1 },
      overduePendingCount: 2,
    })
    await render()

    expect(testId('metrics-removal-overdue')?.textContent).toContain('2 pending requests')
    expect((testId('metrics-removal-overdue-link') as HTMLAnchorElement).textContent).toContain('check Operations')
  })

  it('shows a degraded state and links to Operations when the trust API errors', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter(undefined, 'error')
    await render()

    expect(testId('metrics-removal-error')).not.toBeNull()
    expect((testId('metrics-removal-operations-link') as HTMLAnchorElement).textContent).toContain('Check Operations')
  })
})

/**
 * plans/ui-dashboard, Admin track "`/admin/metrics` optimization".
 *
 * The refresh used to be an unconditional `setInterval`, so a tab left open in the background kept
 * querying the platform every fifteen seconds at nobody. These pin both halves of the fix: no timer
 * while hidden, and an immediate re-read on return rather than up to fifteen seconds of stale
 * numbers.
 */
describe('AdminMetricsPage — refresh only while visible', () => {
  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  function metricsFetchCount(): number {
    return vi.mocked(fetch).mock.calls.filter(([input]) => {
      const url = String(input)
      return url.includes('/api/admin/metrics') && !url.includes('/conversion') && !url.includes('/trust')
    }).length
  }

  afterEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  it('schedules no refresh timer at all while the tab starts hidden', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()

    await render()

    // The first read still happens — an operator opening the page in a background tab and switching
    // to it should find numbers, not a spinner.
    expect(metricsFetchCount()).toBe(1)
    expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 15_000)).toHaveLength(0)
    setIntervalSpy.mockRestore()
  })

  it('clears the timer when the tab is hidden and re-reads immediately when it comes back', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()

    await render()
    const scheduled = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 15_000)
    expect(scheduled).toHaveLength(1)
    expect(metricsFetchCount()).toBe(1)

    await act(async () => { setHidden(true) })
    expect(clearIntervalSpy).toHaveBeenCalled()

    await act(async () => { setHidden(false) })
    // Re-read on return, not on the next tick of a timer that has not fired yet.
    expect(metricsFetchCount()).toBe(2)
    expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 15_000)).toHaveLength(2)

    setIntervalSpy.mockRestore()
    clearIntervalSpy.mockRestore()
  })
})

/**
 * Saved queries, Builders and Notes were tiles whose values the API hardcoded to `null`, so they
 * rendered a permanent em-dash. See `src/routes/api/admin/metrics/index.ts` for why they were removed
 * rather than made real.
 */
describe('AdminMetricsPage — no permanently empty tiles', () => {
  it('renders no tile for a count the platform cannot compute', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter()
    await render()

    expect(testId('metric-card-saved-queries')).toBeNull()
    expect(testId('metric-card-builders')).toBeNull()
    expect(testId('metric-card-notes')).toBeNull()
    // The counts that are real are still there.
    expect(testId('metric-card-total-users')?.textContent).toContain('1')
  })
})
