import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { TransferOwnershipPreview, type TransferOwnershipPreviewProps } from './TransferOwnershipPreview'

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

async function render(props: TransferOwnershipPreviewProps) {
  const rootRoute = createRootRoute({
    component: () => <TransferOwnershipPreview {...props} />,
  })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
  // The preview fetch resolves on a microtask — flush once so the
  // loading -> loaded/error transition has already happened by the time
  // callers start asserting on rendered content.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function testId(id: string): Element | null {
  return container!.querySelector(`[data-testid="${id}"]`)
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

describe('TransferOwnershipPreview', () => {
  it('shows masked payment method, plan, and next charge for an active subscription', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        hasBillingCustomer: true,
        paymentMethod: { brand: 'visa', last4: '4242' },
        tier: 'team',
        billingPeriod: 'monthly',
        currentPeriodEnd: '2026-02-01T00:00:00.000Z',
        nextChargeAmountCents: 4900,
        cancelAtPeriodEnd: false,
      }),
    )

    await render({ targetName: 'Nate New', onConfirm: vi.fn(), onCancel: vi.fn() })

    expect(testId('transfer-ownership-preview')).not.toBeNull()
    expect(testId('transfer-ownership-payment-method')?.textContent).toContain('4242')
    expect(testId('transfer-ownership-next-charge')?.textContent).toContain('$49.00')
    expect(testId('transfer-ownership-cancel-notice')).toBeNull()
  })

  it('shows a cancellation notice instead of a next charge when already scheduled to cancel', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        hasBillingCustomer: true,
        paymentMethod: { brand: 'visa', last4: '4242' },
        tier: 'team',
        billingPeriod: 'monthly',
        currentPeriodEnd: '2026-02-01T00:00:00.000Z',
        nextChargeAmountCents: 4900,
        cancelAtPeriodEnd: true,
      }),
    )

    await render({ targetName: 'Nate New', onConfirm: vi.fn(), onCancel: vi.fn() })

    expect(testId('transfer-ownership-cancel-notice')).not.toBeNull()
    expect(testId('transfer-ownership-next-charge')).toBeNull()
  })

  it('shows a no-billing message when the organization has no billing customer at all', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        hasBillingCustomer: false,
        paymentMethod: null,
        tier: 'free',
        billingPeriod: 'monthly',
        currentPeriodEnd: null,
        nextChargeAmountCents: null,
        cancelAtPeriodEnd: false,
      }),
    )

    await render({ targetName: 'Nate New', onConfirm: vi.fn(), onCancel: vi.fn() })

    expect(testId('transfer-ownership-no-billing')).not.toBeNull()
  })

  it('shows an error state when the preview fetch fails', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Forbidden' }, false))

    await render({ targetName: 'Nate New', onConfirm: vi.fn(), onCancel: vi.fn() })

    expect(testId('transfer-ownership-preview-error')?.textContent).toContain('Forbidden')
  })

  it('calls onConfirm/onCancel from their respective buttons', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        hasBillingCustomer: false,
        paymentMethod: null,
        tier: 'free',
        billingPeriod: 'monthly',
        currentPeriodEnd: null,
        nextChargeAmountCents: null,
        cancelAtPeriodEnd: false,
      }),
    )
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    await render({ targetName: 'Nate New', onConfirm, onCancel })
    await act(async () => (testId('transfer-ownership-confirm') as HTMLButtonElement).click())
    expect(onConfirm).toHaveBeenCalledTimes(1)

    await act(async () => (testId('transfer-ownership-preview-cancel') as HTMLButtonElement).click())
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('never renders more than brand/last4 for the payment method (no PAN, no expiry)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        hasBillingCustomer: true,
        paymentMethod: { brand: 'visa', last4: '4242' },
        tier: 'team',
        billingPeriod: 'monthly',
        currentPeriodEnd: '2026-02-01T00:00:00.000Z',
        nextChargeAmountCents: 4900,
        cancelAtPeriodEnd: false,
      }),
    )

    await render({ targetName: 'Nate New', onConfirm: vi.fn(), onCancel: vi.fn() })

    // The only card-shaped fields this component ever receives are brand/last4 —
    // asserting the rendered text is exactly the masked form guards against a
    // future DTO widening (e.g. adding a raw PAN) leaking into this UI unnoticed.
    expect(testId('transfer-ownership-payment-method')?.textContent?.trim()).toBe('visa •••• 4242')
  })
})
