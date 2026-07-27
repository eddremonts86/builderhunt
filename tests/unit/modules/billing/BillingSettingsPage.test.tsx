import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, createRootRoute, RouterProvider } from '@tanstack/react-router'

vi.mock('~/shared/components/TenantQueryProvider', () => ({
  useActiveOrganizationId: () => 'org-1',
}))

const { BillingSettingsPage } = await import('~/modules/billing/BillingSettingsPage')

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

async function render() {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <BillingSettingsPage />
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
  // Two flushes: the first settles the summary query; the disputes query only becomes `enabled`
  // once the summary result is known, so it needs a second tick to fire and settle in turn.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function testId(id: string): Element | null {
  return container!.querySelector(`[data-testid="${id}"]`)
}

const BASE_SUMMARY = {
  tier: 'pro',
  status: 'active',
  billingPeriod: 'monthly',
  currentPeriodEnd: '2027-01-01T00:00:00.000Z',
  trialEndsAt: null,
  notes: null,
  cancelAtPeriodEnd: false,
  canceledAt: null,
  scheduledChange: null,
  grace: { gracePeriodEndsAt: null, paymentBlockedAt: null },
  seats: { limit: 1, used: 1 },
  customer: { hasStripeCustomer: true, livemode: false },
  activeCreditGrants: [],
  recentRefunds: [],
  usage: { savedSearches: 1, savedBuilders: 2 },
  limits: { savedSearches: 50, savedBuilders: null, rssSubscriptions: null },
  billingContact: null,
  capabilities: { paidActionsAllowed: true, canOpenPortal: false, canRequestRefund: false, canConfigureAutoRecharge: false },
}

function mockFetch(handlers: { summary?: unknown; disputes?: unknown }) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/billing/summary')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => handlers.summary })
    }
    if (url.includes('/api/billing/disputes')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => (handlers.disputes ?? { disputes: [] }) })
    }
    if (url.includes('/api/billing/contact')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ contact: null }) })
    }
    if (url.includes('/api/billing/auto-recharge')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ rule: null }) })
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'not found' }) })
  }))
}

describe('BillingSettingsPage', () => {
  it('shows the availability-only view for a member (no plan/seat/credit detail rendered)', async () => {
    mockFetch({ summary: { capabilities: { paidActionsAllowed: true } } })
    await render()

    expect(testId('billing-availability')).not.toBeNull()
    expect(testId('billing-settings-content')).toBeNull()
    expect(container!.textContent).toContain('paid features enabled')
    expect(container!.textContent).toContain('Ask your workspace owner')
  })

  it('shows the free-plan message for a member with no paid features', async () => {
    mockFetch({ summary: { capabilities: { paidActionsAllowed: false } } })
    await render()

    expect(container!.textContent).toContain('free plan')
  })

  it('shows the full plan/seats view and mutation controls for an owner', async () => {
    mockFetch({ summary: { ...BASE_SUMMARY, capabilities: { ...BASE_SUMMARY.capabilities, canOpenPortal: true, canRequestRefund: true, canConfigureAutoRecharge: true } } })
    await render()

    expect(testId('billing-settings-content')).not.toBeNull()
    expect(testId('open-portal-button')).not.toBeNull()
    expect(testId('cancel-subscription-button')).not.toBeNull()
    expect(testId('plan-picker')).not.toBeNull()
    expect(container!.textContent).toContain('1 of 1 seat')
  })

  it('shows the full read-only view for an admin, without any owner-only mutation controls', async () => {
    mockFetch({ summary: BASE_SUMMARY })
    await render()

    expect(testId('billing-settings-content')).not.toBeNull()
    expect(testId('open-portal-button')).toBeNull()
    expect(testId('cancel-subscription-button')).toBeNull()
    expect(testId('plan-picker')).toBeNull()
  })

  it('shows a danger banner once payment is blocked', async () => {
    mockFetch({ summary: { ...BASE_SUMMARY, grace: { gracePeriodEndsAt: '2026-01-01T00:00:00.000Z', paymentBlockedAt: '2026-01-08T00:00:00.000Z' } } })
    await render()

    expect(testId('warning-payment-blocked')).not.toBeNull()
    expect(testId('warning-grace-period')).toBeNull()
  })

  it('shows a grace-period warning banner while payment has failed but access is not blocked yet', async () => {
    const gracePeriodEndsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    mockFetch({ summary: { ...BASE_SUMMARY, grace: { gracePeriodEndsAt, paymentBlockedAt: null } } })
    await render()

    expect(testId('warning-grace-period')).not.toBeNull()
    expect(testId('warning-payment-blocked')).toBeNull()
  })

  it('shows a scheduled-change banner when a plan change is pending', async () => {
    mockFetch({ summary: { ...BASE_SUMMARY, scheduledChange: { catalogKey: 'team_monthly', effectiveAt: '2027-02-01T00:00:00.000Z' } } })
    await render()

    expect(testId('warning-scheduled-change')).not.toBeNull()
    expect(container!.textContent).toContain('team_monthly')
  })

  it('shows a cancel-scheduled banner instead of the cancel button when already canceling', async () => {
    mockFetch({ summary: { ...BASE_SUMMARY, cancelAtPeriodEnd: true, capabilities: { ...BASE_SUMMARY.capabilities, canOpenPortal: true } } })
    await render()

    expect(testId('warning-cancel-scheduled')).not.toBeNull()
    expect(testId('cancel-subscription-button')).toBeNull()
  })

  it('renders the credit balance and disputes sections from real summary/disputes data', async () => {
    mockFetch({
      summary: { ...BASE_SUMMARY, activeCreditGrants: [{ id: 'grant-1', source: 'pack', remainingUnits: 300, expiresAt: '2027-01-01T00:00:00.000Z' }] },
      disputes: { disputes: [{ id: 'dispute-1', amountCents: 1500, reason: 'fraudulent', stripeStatus: 'needs_response', outcome: 'open', evidenceDueBy: '2027-01-10T00:00:00.000Z' }] },
    })
    await render()

    expect(testId('credit-grant-grant-1')).not.toBeNull()
    expect(testId('disputes-section')).not.toBeNull()
    expect(testId('dispute-dispute-1')).not.toBeNull()
  })

  it('shows an error state when the summary request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })))
    await render()

    expect(testId('billing-settings-error')).not.toBeNull()
  })
})
