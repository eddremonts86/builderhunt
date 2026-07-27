import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'

const navigateSpy = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => navigateSpy }
})

const { CheckoutReturn } = await import('~/modules/billing/CheckoutReturn')

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null
let queryClient: QueryClient

beforeEach(() => {
  navigateSpy.mockClear()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  queryClient.clear()
  vi.restoreAllMocks()
})

async function render(searchString = '') {
  const history = createMemoryHistory({ initialEntries: [`/settings/billing/return${searchString}`] })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <CheckoutReturn />
      </QueryClientProvider>
    ),
  })
  const router = createRouter({ routeTree: rootRoute, history })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
  // Extra flush for the mocked fetch + .json() promise chain and react-query's own internal
  // scheduling to settle and commit a re-render before assertions run.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function testId(id: string): Element | null {
  return container!.querySelector(`[data-testid="${id}"]`)
}

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok, status: ok ? 200 : 500, json: async () => body }))
}

describe('CheckoutReturn', () => {
  it('shows the pending view while the poll has not resolved yet', async () => {
    mockFetchOnce({ state: 'pending' })
    await render()

    expect(testId('checkout-return-pending')).not.toBeNull()
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('shows the succeeded view and navigates to billing settings exactly once', async () => {
    mockFetchOnce({ state: 'succeeded' })
    await render()

    expect(testId('checkout-return-succeeded')).not.toBeNull()
    expect(navigateSpy).toHaveBeenCalledTimes(1)
    expect(navigateSpy).toHaveBeenCalledWith({ to: '/settings/billing' })
  })

  it('shows the expired view with no navigation', async () => {
    mockFetchOnce({ state: 'expired' })
    await render()

    expect(testId('checkout-return-expired')).not.toBeNull()
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('shows the failed view with no navigation', async () => {
    mockFetchOnce({ state: 'failed' })
    await render()

    expect(testId('checkout-return-failed')).not.toBeNull()
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('shows a no-attempt view when nothing was ever started', async () => {
    mockFetchOnce({ state: 'no_attempt' })
    await render()

    expect(testId('checkout-return-no-attempt')).not.toBeNull()
  })

  it('shows a recovery view when the status endpoint itself fails', async () => {
    mockFetchOnce({ error: 'boom' }, false)
    await render()

    expect(testId('checkout-return-error')).not.toBeNull()
  })

  it('a forged ?status=success&session_id=... URL does nothing — the rendered view still reflects the polled (pending) state, not the URL', async () => {
    mockFetchOnce({ state: 'pending' })
    await render('?status=success&session_id=cs_forged_by_attacker')

    expect(testId('checkout-return-pending')).not.toBeNull()
    expect(testId('checkout-return-succeeded')).toBeNull()
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('a delayed transition from pending to succeeded (simulated by refetching) navigates exactly once, never twice', async () => {
    mockFetchOnce({ state: 'pending' })
    await render()
    expect(testId('checkout-return-pending')).not.toBeNull()
    expect(navigateSpy).not.toHaveBeenCalled()

    // Simulate the delayed webhook landing between two polls.
    mockFetchOnce({ state: 'succeeded' })
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['billing', 'checkout', 'status'] })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(testId('checkout-return-succeeded')).not.toBeNull()
    expect(navigateSpy).toHaveBeenCalledTimes(1)

    // A further refetch that still reports 'succeeded' (e.g. the browser tab regained focus and
    // react-query refetched again) must not trigger a second navigation.
    mockFetchOnce({ state: 'succeeded' })
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['billing', 'checkout', 'status'] })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(navigateSpy).toHaveBeenCalledTimes(1)
  })

  it('always renders a recovery link back to billing settings, regardless of state', async () => {
    mockFetchOnce({ state: 'failed' })
    await render()

    const link = container!.querySelector('a[href="/settings/billing"]')
    expect(link).not.toBeNull()
  })

  it('the polling status region is announced to assistive tech (role="status", aria-live="polite")', async () => {
    mockFetchOnce({ state: 'pending' })
    await render()

    const region = container!.querySelector('[role="status"]')
    expect(region?.getAttribute('aria-live')).toBe('polite')
  })
})
