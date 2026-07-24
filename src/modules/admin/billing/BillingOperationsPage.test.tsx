import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { BillingOperationsPage } from './BillingOperationsPage'

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
    vi.mocked(fetch).mockResolvedValue(jsonResponse(FULL_METRICS))

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
    expect(testId('billing-operations-cost-margin')?.textContent).toContain('Not yet available')
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
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ...FULL_METRICS, configuration: null }))

    await render()

    expect(testId('billing-operations-configuration')?.textContent).toContain('Not set')
    expect(testId('billing-operations-configuration')?.textContent).not.toContain('v3')
  })

  it('shows reconciliation and cost/margin as explicitly unavailable when nothing has run yet', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ...FULL_METRICS, reconciliation: { lastRun: null } }))

    await render()

    expect(testId('billing-operations-reconciliation')?.textContent).toContain('Not yet available')
    expect(testId('billing-operations-cost-margin')?.textContent).toContain('Not yet available')
  })

  it('never renders anything resembling a raw webhook payload, a secret, or a stripe id', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(FULL_METRICS))

    await render()

    const html = container!.innerHTML
    expect(html).not.toMatch(/sk_(live|test)_/)
    expect(html).not.toMatch(/whsec_/)
    expect(html).not.toContain('payloadEncrypted')
    expect(html).not.toContain('stripeEventId')
  })

  it('the refresh button re-fetches metrics', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(FULL_METRICS))
    await render()
    expect(fetch).toHaveBeenCalledTimes(1)

    await act(async () => (testId('billing-operations-refresh') as HTMLButtonElement).click())

    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
