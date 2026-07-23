import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatUsd, SubscribeCta } from './pricing'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'idem-test-1' })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const ENTRY = {
  key: 'pro_monthly' as const, tier: 'pro' as const, interval: 'monthly' as const,
  amountCents: 1900, currency: 'usd' as const, monthlyCredits: 140, seatLimit: 1,
}

async function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<SubscribeCta entry={ENTRY} tierLabel="Pro" />)
  })
}

function testId(id: string): Element | null {
  return container!.querySelector(`[data-testid="${id}"]`)
}

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok, status: ok ? 200 : 400, json: async () => body }))
}

describe('formatUsd', () => {
  it('formats a whole-dollar amount with no decimals', () => {
    expect(formatUsd(1900)).toBe('$19')
    expect(formatUsd(19900)).toBe('$199')
  })

  it('formats a fractional amount with two decimals', () => {
    expect(formatUsd(1500)).toBe('$15')
    expect(formatUsd(4550)).toBe('$45.50')
  })
})

describe('SubscribeCta', () => {
  it('shows a Subscribe button before any interaction, never the disclosure form', async () => {
    await render()
    expect(testId('pricing-cta-pro')).not.toBeNull()
    expect(testId('pricing-subscribe-form-pro')).toBeNull()
    expect(testId('pricing-cta-pro')!.textContent).toContain('Subscribe to Pro')
  })

  it('expands the disclosure form on click, with the confirm button disabled until agreed', async () => {
    await render()
    await act(async () => {
      testId('pricing-cta-pro')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(testId('pricing-subscribe-form-pro')).not.toBeNull()
    const confirmButton = testId('pricing-confirm-pro') as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)
  })

  it('enables the confirm button once the disclosure checkbox is checked and country is 2 letters', async () => {
    await render()
    await act(async () => {
      testId('pricing-cta-pro')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const checkbox = container!.querySelector('button[role="checkbox"]') as HTMLButtonElement
    await act(async () => {
      checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const confirmButton = testId('pricing-confirm-pro') as HTMLButtonElement
    expect(confirmButton.disabled).toBe(false)
  })

  it('posts the exact catalog key, disclosures, and idempotency key, then redirects to the returned checkoutUrl', async () => {
    mockFetchOnce({ checkoutUrl: 'https://billing.stripe.test/checkout/cs_test_1', status: 'open' })
    const originalLocation = window.location
    // jsdom's window.location isn't writable by default — replace it for this one assertion.
    Object.defineProperty(window, 'location', { value: { ...originalLocation, href: '', origin: 'https://app.test' }, writable: true })

    await render()
    await act(async () => {
      testId('pricing-cta-pro')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const checkbox = container!.querySelector('button[role="checkbox"]') as HTMLButtonElement
    await act(async () => {
      checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      testId('pricing-confirm-pro')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(fetch).toHaveBeenCalledWith('/api/billing/checkout/subscription', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        catalogKey: 'pro_monthly',
        country: 'DK',
        disclosures: {
          renewal: true, amount: true, interval: true, cancellationRefundPolicy: true, creditExpiryNonTransferability: true, tax: true, total: true,
        },
        idempotencyKey: 'idem-test-1',
        successUrl: 'https://app.test/settings/billing/return',
        cancelUrl: 'https://app.test/pricing',
      }),
    }))
    expect(window.location.href).toBe('https://billing.stripe.test/checkout/cs_test_1')

    Object.defineProperty(window, 'location', { value: originalLocation, writable: true })
  })

  it('surfaces a server error message without redirecting', async () => {
    mockFetchOnce({ error: 'Country not eligible yet', code: 'country_not_allowed' }, false)

    await render()
    await act(async () => {
      testId('pricing-cta-pro')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const checkbox = container!.querySelector('button[role="checkbox"]') as HTMLButtonElement
    await act(async () => {
      checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      testId('pricing-confirm-pro')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container!.textContent).toContain('Country not eligible yet')
  })
})
