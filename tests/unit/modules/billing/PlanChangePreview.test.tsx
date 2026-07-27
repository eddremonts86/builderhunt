import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, createRootRoute, RouterProvider } from '@tanstack/react-router'

const { PlanChangePreview } = await import('~/modules/billing/PlanChangePreview')

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null
let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  queryClient.clear()
  vi.restoreAllMocks()
})

async function render(props: { newCatalogKey: string; onChanged?: (r: unknown) => void; onCancel?: () => void } = { newCatalogKey: 'pro_max_monthly' }) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <PlanChangePreview {...props} />
      </QueryClientProvider>
    ),
  })
  const router = createRouter({ routeTree: rootRoute })

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

const BASE_PREVIEW = {
  currentCatalogKey: 'pro_monthly',
  newCatalogKey: 'pro_max_monthly',
  direction: 'upgrade' as const,
  timing: 'immediate' as const,
  stripeAmountDue: 4500,
  stripeCurrency: 'usd',
  nextPaymentDate: '2026-04-01T00:00:00.000Z',
  creditDelta: 290,
  effectiveAt: '2026-03-16T00:00:00.000Z',
  fingerprint: 'sub_1:2026-03-01T00:00:00.000Z',
}

function mockFetchSequence(responses: Array<{ ok: boolean; body: unknown }>) {
  const fn = vi.fn()
  for (const { ok, body } of responses) {
    fn.mockResolvedValueOnce({ ok, status: ok ? 200 : 409, json: async () => body })
  }
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('PlanChangePreview', () => {
  it('shows the loading state before the preview resolves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})))
    await render()

    expect(testId('plan-change-preview-loading')).not.toBeNull()
  })

  it('renders the resolved preview: amount due, credit delta, effective date', async () => {
    mockFetchSequence([{ ok: true, body: BASE_PREVIEW }])
    await render()

    expect(testId('plan-change-amount-due')?.textContent).toContain('45')
    expect(testId('plan-change-credit-delta')?.textContent).toContain('290')
    expect(testId('plan-change-confirm')).not.toBeNull()
  })

  it('shows an error view when the preview request fails', async () => {
    mockFetchSequence([{ ok: false, body: { error: 'No active subscription', code: 'no_active_subscription' } }])
    await render()

    expect(testId('plan-change-preview-error')).not.toBeNull()
    expect(testId('plan-change-confirm')).toBeNull()
  })

  it('renders a blocking seat banner and disables confirm when a seatBlocker is present', async () => {
    mockFetchSequence([{
      ok: true,
      body: { ...BASE_PREVIEW, direction: 'downgrade', timing: 'scheduled', creditDelta: 0, seatBlocker: { currentSeatsUsed: 3, targetSeatLimit: 1, manageTeamUrl: '/settings/team' } },
    }])
    await render()

    const banner = testId('plan-change-seat-blocker')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('3')
    expect(banner?.textContent).toContain('1')
    const link = container!.querySelector('a[href="/settings/team"]')
    expect(link).not.toBeNull()

    const confirmButton = testId('plan-change-confirm') as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)
  })

  it('does not render a seat blocker banner when none is present', async () => {
    mockFetchSequence([{ ok: true, body: BASE_PREVIEW }])
    await render()

    expect(testId('plan-change-seat-blocker')).toBeNull()
    expect((testId('plan-change-confirm') as HTMLButtonElement).disabled).toBe(false)
  })

  it('confirming calls the change endpoint with the preview fingerprint and reports success', async () => {
    const onChanged = vi.fn()
    const fetchMock = mockFetchSequence([
      { ok: true, body: BASE_PREVIEW },
      { ok: true, body: { applied: 'immediate', newCatalogKey: 'pro_max_monthly', effectiveAt: '2026-03-16T00:00:00.000Z', creditDelta: 290 } },
    ])
    await render({ newCatalogKey: 'pro_max_monthly', onChanged })

    await act(async () => {
      testId('plan-change-confirm')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(onChanged).toHaveBeenCalledTimes(1)
    const [, changeCall] = fetchMock.mock.calls
    const changeBody = JSON.parse(changeCall[1].body as string)
    expect(changeBody.fingerprint).toBe(BASE_PREVIEW.fingerprint)
    expect(changeBody.newCatalogKey).toBe('pro_max_monthly')
  })

  it('shows an inline error and does not call onChanged when the change request fails', async () => {
    const onChanged = vi.fn()
    mockFetchSequence([
      { ok: true, body: BASE_PREVIEW },
      { ok: false, body: { error: 'Subscription changed since the preview was generated', code: 'stale_preview' } },
    ])
    await render({ newCatalogKey: 'pro_max_monthly', onChanged })

    await act(async () => {
      testId('plan-change-confirm')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(testId('plan-change-error')?.textContent).toContain('preview')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('renders a cancel button only when onCancel is provided', async () => {
    mockFetchSequence([{ ok: true, body: BASE_PREVIEW }])
    await render({ newCatalogKey: 'pro_max_monthly' })
    expect(testId('plan-change-cancel')).toBeNull()
  })
})
