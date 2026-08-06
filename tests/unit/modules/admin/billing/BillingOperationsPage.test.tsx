import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { BillingOperationsPage } from '~/modules/admin/billing/BillingOperationsPage'

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

/** The page also fetches the dead-letter discovery list on mount (`/api/admin/billing/events?...`)
 * — this routes each call by URL so a test can focus on the metrics response without every other
 * call rejecting/erroring. Defaults the events list to empty. */
function mockFetchRouter(metrics: unknown, eventsRows: unknown[] = []): void {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/admin/billing/events?')) return jsonResponse({ rows: eventsRows, nextCursor: null })
    return jsonResponse(metrics)
  })
}

const FULL_METRICS = {
  liveMode: false,
  configuration: { version: 3, effectiveAt: '2026-01-01T00:00:00.000Z', statementDescriptor: 'BUILDERHUNT', supportEmail: 'support@test.com' },
  webhooks: { pending: 2, processing: 1, failed: 1, ignored: 0, processed: 40 },
  grace: { organizationsInGrace: 1 },
  refunds: { pendingRequests: 2 },
  disputes: { open: 1 },
  riskExceptions: { active: 3 },
  creditInvariants: { staleReservations: 0 },
  reconciliation: { lastRun: { windowEnd: '2026-01-02T00:00:00.000Z', result: 'clean' } },
  costMargin: { available: false },
  organizationsScanned: 12,
}

async function render() {
  const rootRoute = createRootRoute({
    component: () => <BillingOperationsPage />,
  })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function testId(id: string): Element | null {
  return container!.querySelector(`[data-testid="${id}"]`)
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

describe('BillingOperationsPage', () => {
  it('renders every metric section once loaded', async () => {
    mockFetchRouter(FULL_METRICS)

    await render()

    expect(testId('admin-billing-operations')).not.toBeNull()
    expect(testId('billing-operations-mode')?.textContent).toContain('Test')
    expect(testId('billing-operations-configuration')?.textContent).toContain('v3')
    expect(testId('billing-operations-webhooks')?.textContent).toContain('3') // pending + processing
    expect(testId('billing-operations-grace')?.textContent).toContain('1')
    expect(testId('billing-operations-refunds')?.textContent).toContain('2')
    expect(testId('billing-operations-disputes')?.textContent).toContain('1')
    expect(testId('billing-operations-risk-exceptions')?.textContent).toContain('3')
    expect(testId('billing-operations-reconciliation')?.textContent).toContain('clean')
    expect(testId('billing-operations-cost-margin')?.textContent).toContain('Accounting export')
    expect(testId('billing-operations-runbooks')).not.toBeNull()
  })

  it('shows a loading state before the first response resolves', async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {})) // never resolves

    await render()

    expect(testId('billing-operations-loading')).not.toBeNull()
  })

  it('shows an error state, not a crash, when the metrics request fails', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Forbidden' }, false, 403))

    await render()

    expect(testId('billing-operations-error')?.textContent).toContain('403')
  })

  it('shows a "no configuration recorded" state distinctly, never a fabricated version number', async () => {
    mockFetchRouter({ ...FULL_METRICS, configuration: null })

    await render()

    expect(testId('billing-operations-configuration')?.textContent).toContain('Not set')
    expect(testId('billing-operations-configuration')?.textContent).not.toContain('v3')
  })

  it('shows reconciliation as explicitly unrun (not a fabricated result) when nothing has run yet', async () => {
    mockFetchRouter({ ...FULL_METRICS, reconciliation: { lastRun: null } })

    await render()

    expect(testId('billing-operations-reconciliation')?.textContent).toContain('No reconciliation run recorded yet')
  })

  it('never renders anything resembling a raw webhook payload, a secret, or a stripe id', async () => {
    mockFetchRouter(FULL_METRICS)

    await render()

    const html = container!.innerHTML
    expect(html).not.toMatch(/sk_(live|test)_/)
    expect(html).not.toMatch(/whsec_/)
    expect(html).not.toContain('payloadEncrypted')
    expect(html).not.toContain('stripeEventId')
  })

  it('the refresh button re-fetches metrics (but not the events discovery list)', async () => {
    mockFetchRouter(FULL_METRICS)
    await render()
    expect(fetch).toHaveBeenCalledTimes(2) // initial metrics load + dead-letter discovery list

    await act(async () => (testId('billing-operations-refresh') as HTMLButtonElement).click())

    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('reconciliation requires an explicit confirm click before POSTing', async () => {
    mockFetchRouter(FULL_METRICS)
    await render()
    expect(fetch).toHaveBeenCalledTimes(2) // metrics + dead-letter discovery list, no reconcile yet

    await act(async () => (testId('billing-reconcile-trigger') as HTMLButtonElement).click())
    expect(testId('billing-reconcile-confirm')).not.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ id: 'run-1', result: 'clean' }))
    await act(async () => {
      (testId('billing-reconcile-confirm') as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const [url, init] = vi.mocked(fetch).mock.calls[2]
    expect(String(url)).toBe('/api/admin/billing/reconcile')
    expect(init).toMatchObject({ method: 'POST' })
    expect(testId('billing-reconcile-message')?.textContent).toContain('completed')
  })

  it('surfaces the step-up (recent-auth) rejection distinctly, without a fake success', async () => {
    mockFetchRouter(FULL_METRICS)
    await render()

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: 'Recent re-authentication required' }, false, 401))
    await act(async () => (testId('billing-worker-trigger') as HTMLButtonElement).click())
    await act(async () => {
      (testId('billing-worker-confirm') as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(testId('billing-worker-message')?.textContent).toMatch(/re-authentication required/i)
  })

  it('dead-letter replay is disabled until an event id is entered, then requires confirm', async () => {
    mockFetchRouter(FULL_METRICS)
    await render()

    expect((testId('billing-replay-trigger') as HTMLButtonElement).disabled).toBe(true)

    const input = testId('billing-replay-event-id') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'evt-row-1')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect((testId('billing-replay-trigger') as HTMLButtonElement).disabled).toBe(false)

    await act(async () => (testId('billing-replay-trigger') as HTMLButtonElement).click())
    expect(testId('billing-replay-confirm')).not.toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ eventRowId: 'evt-row-1', result: 'processed' }))
    await act(async () => {
      (testId('billing-replay-confirm') as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // The reconcile route's own replay endpoint is called after: [0] metrics, [1] discovery list, [2] replay.
    const [url] = vi.mocked(fetch).mock.calls[2]
    expect(String(url)).toBe('/api/admin/billing/events/evt-row-1/replay')
    expect(testId('billing-replay-message')?.textContent).toMatch(/replayed/i)
  })

  it('discovers failed events and lets an operator replay one directly from the list', async () => {
    mockFetchRouter(FULL_METRICS, [
      { id: 'wh-1', stripeEventId: 'evt_1', eventType: 'invoice.paid', objectType: 'invoice', status: 'failed', attempts: 3, receivedAt: '2027-01-01T00:00:00.000Z', processedAt: null, nextAttemptAt: null, hasError: true },
    ])
    await render()

    expect(testId('billing-event-row-wh-1')?.textContent).toContain('invoice.paid')
    expect(testId('billing-event-row-wh-1')?.textContent).toContain('3 attempts')

    await act(async () => (testId('billing-event-replay-wh-1') as HTMLButtonElement).click())
    expect(testId('billing-event-replay-confirm-wh-1')).not.toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ eventRowId: 'wh-1', result: 'processed' }))
    await act(async () => {
      (testId('billing-event-replay-confirm-wh-1') as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const [url] = vi.mocked(fetch).mock.calls[2]
    expect(String(url)).toBe('/api/admin/billing/events/wh-1/replay')
  })

  it('switching the status filter re-fetches the discovery list for that status', async () => {
    mockFetchRouter(FULL_METRICS)
    await render()
    expect(fetch).toHaveBeenCalledTimes(2) // metrics + the default "failed" discovery fetch

    await act(async () => (testId('billing-events-filter-pending') as HTMLButtonElement).click())

    expect(fetch).toHaveBeenCalledTimes(3)
    const [url] = vi.mocked(fetch).mock.calls[2]
    expect(String(url)).toContain('status=pending')
  })

  it('shows an honest empty state when no events match the filter', async () => {
    mockFetchRouter(FULL_METRICS, [])
    await render()

    expect(testId('billing-events-list')?.textContent).toContain('No failed events')
  })

  it('issuing a risk exception validates locally before ever calling the API', async () => {
    mockFetchRouter(FULL_METRICS)
    await render()

    await act(async () => (testId('billing-risk-issue') as HTMLButtonElement).click())

    expect(testId('billing-risk-issue-message')?.textContent).toMatch(/required/i)
    expect(fetch).toHaveBeenCalledTimes(2) // metrics + dead-letter discovery list — no POST for an incomplete form
  })

  it('links to the CSV and JSON accounting export endpoints', async () => {
    mockFetchRouter(FULL_METRICS)
    await render()

    expect((testId('billing-export-csv') as HTMLAnchorElement).getAttribute('href')).toBe('/api/admin/billing/accounting-export?format=csv')
    expect((testId('billing-export-json') as HTMLAnchorElement).getAttribute('href')).toBe('/api/admin/billing/accounting-export')
  })
})

/**
 * The SLO alerts (`evaluateBillingAlerts`) used to be computed into `/api/admin/metrics`'s `billing`
 * block, which no page has ever rendered — so this product could detect a stuck webhook backlog or a
 * ledger invariant violation and show it to nobody. They arrive with the metrics now.
 */
describe('BillingOperationsPage — SLO alerts', () => {
  it('renders each alert the server reported, as an alert region', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({
      ...FULL_METRICS,
      alerts: ['1 webhook event(s) permanently failed', 'Last reconciliation run was not clean (mismatches_found)'],
    })
    await render()

    const banner = testId('billing-operations-alerts')
    expect(banner).not.toBeNull()
    expect(banner?.getAttribute('role')).toBe('alert')
    expect(banner?.textContent).toContain('2 billing alerts')
    expect(container!.querySelectorAll('[data-testid="billing-operations-alert"]')).toHaveLength(2)
    expect(banner?.textContent).toContain('permanently failed')
  })

  it('renders nothing when the list is empty — a standing "0 alerts" panel teaches operators to skip it', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter({ ...FULL_METRICS, alerts: [] })
    await render()

    expect(testId('billing-operations-alerts')).toBeNull()
  })

  /**
   * A client on a stale bundle during a deploy gets a response without the field. Absent is not the
   * same claim as empty, so the page says nothing rather than "all clear".
   */
  it('claims nothing when the response carries no alert field at all', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mockFetchRouter(FULL_METRICS)
    await render()

    expect(testId('billing-operations-alerts')).toBeNull()
    // Still rendered the page it could render.
    expect(testId('billing-operations-mode')).not.toBeNull()
  })
})
