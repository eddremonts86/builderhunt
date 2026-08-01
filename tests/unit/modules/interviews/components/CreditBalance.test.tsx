/**
 * Two properties carry most of the weight here.
 *
 * A plain member must see no financial detail — the route already role-minimizes, and this asserts the
 * component does not reconstruct a balance from what it was given. And the live region must announce a
 * warning *once*: a session ticks every few seconds, and a region that re-announced "90% used" on
 * every tick would make a screen reader unusable for exactly the person who most needs to hear it.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CreditBalance, type CreditBalanceProps } from '~/modules/interviews/components/CreditBalance'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

/**
 * The component renders router links, so it needs a router in context — and the router must be
 * `load()`ed inside `act` before it renders anything. Without the await, `RouterProvider` mounts
 * empty and every assertion below fails against an empty container rather than against the component.
 * Same shape as `tests/unit/shared/components/TosModal.test.tsx`.
 */
async function render(props: CreditBalanceProps) {
  const rootRoute = createRootRoute({ component: () => <CreditBalance {...props} /> })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await act(async () => {
    root?.render(<RouterProvider router={router as never} />)
    await router.load()
  })
}

const ownerSummary = (overrides: Partial<CreditBalanceProps['summary'] & object> = {}) => ({
  tier: 'pro',
  status: 'active',
  grace: { gracePeriodEndsAt: null, paymentBlockedAt: null },
  activeCreditGrants: [
    { id: 'g1', source: 'subscription', remainingUnits: 90, expiresAt: '2027-12-01T00:00:00.000Z' },
    { id: 'g2', source: 'pack', remainingUnits: 30, expiresAt: '2028-01-01T00:00:00.000Z' },
  ],
  capabilities: { paidActionsAllowed: true, canOpenPortal: true, canConfigureAutoRecharge: true },
  ...overrides,
}) as CreditBalanceProps['summary']

const text = () => container?.textContent ?? ''
const liveRegion = () => container?.querySelector('[aria-live="polite"]')?.textContent ?? ''
const links = () => [...(container?.querySelectorAll('a') ?? [])].map((a) => a.textContent ?? '')

describe('a member sees availability, not money', () => {
  it('renders no balance and no billing links', async () => {
    await render({ summary: { capabilities: { paidActionsAllowed: true } } })

    expect(text()).toMatch(/available on this organization/i)
    // The number must not be reconstructed from anything: a member's DTO carries no grants at all,
    // and this asserts the component does not invent a zero either.
    expect(text()).not.toMatch(/\d+ credits remaining/)
    expect(links()).toEqual([])
  })

  it('says paid features are unavailable without naming a reason it was not told, and offers Billing/Pricing links', async () => {
    await render({ summary: { capabilities: { paidActionsAllowed: false } } })
    expect(text()).toMatch(/not available on this organization/i)
    expect(links().join(' ')).toMatch(/billing settings/i)
    expect(links().join(' ')).toMatch(/pricing details/i)
  })
})

describe('an owner sees the platform’s own numbers', () => {
  it('sums the active grants rather than keeping its own total', async () => {
    await render({ summary: ownerSummary() })
    expect(text()).toMatch(/120 credits remaining/)
  })

  it('links to billing settings and never renders a payment control', async () => {
    await render({ summary: ownerSummary() })
    expect(links().join(' ')).toMatch(/billing settings/i)
    expect(links().join(' ')).toMatch(/auto-recharge/i)
    // No form, no button: the pack picker and the portal already exist in billing settings, and a
    // second copy here is a second place to get a refund policy wrong.
    expect(container?.querySelector('form')).toBeNull()
    expect(container?.querySelector('button')).toBeNull()
  })

  it('hides the links a capability withholds', async () => {
    await render({
      summary: ownerSummary({
        capabilities: { paidActionsAllowed: true, canOpenPortal: false, canConfigureAutoRecharge: false },
      }),
    })
    expect(links()).toEqual([])
  })

  it('explains a payment block as a pause, not a plan problem, and offers only Billing settings (not Pricing)', async () => {
    await render({
      summary: ownerSummary({
        grace: { gracePeriodEndsAt: null, paymentBlockedAt: '2027-06-01T00:00:00.000Z' },
        capabilities: { paidActionsAllowed: false, canOpenPortal: true, canConfigureAutoRecharge: true },
      }),
    })
    expect(text()).toMatch(/paused while a payment problem is resolved/i)
    expect(links().join(' ')).toMatch(/billing settings/i)
    expect(links().join(' ')).not.toMatch(/pricing details/i)
  })

  it('offers Billing settings and Pricing details when the plan itself does not include this feature', async () => {
    await render({
      summary: ownerSummary({
        grace: { gracePeriodEndsAt: null, paymentBlockedAt: null },
        capabilities: { paidActionsAllowed: false, canOpenPortal: true, canConfigureAutoRecharge: true },
      }),
    })
    expect(text()).toMatch(/not available on the current plan/i)
    expect(links().join(' ')).toMatch(/billing settings/i)
    expect(links().join(' ')).toMatch(/pricing details/i)
  })

  it('keeps a stale balance on screen with a caveat', async () => {
    // Blanking a balance mid-interview reads as "you have none", which is a worse lie than a slightly
    // old number honestly labelled.
    await render({ summary: ownerSummary(), stale: true })
    expect(text()).toMatch(/120 credits remaining/)
    expect(text()).toMatch(/may be out of date/i)
  })

  it('shows a loading state rather than a zero', async () => {
    await render({ summary: null })
    expect(text()).toMatch(/loading credit balance/i)
    expect(text()).not.toMatch(/0 credits/)
  })
})

describe('live-session warnings', () => {
  it.each([
    [320, /80%/],
    [360, /90%/],
  ])('announces the right threshold at %i units consumed', async (consumed, pattern) => {
    // 400 reserved, so the percentage thresholds and the ten-minute floor do not coincide. At 100
    // reserved they do — 90% consumed leaves exactly ten minutes — and the ten-minute warning
    // legitimately wins, which is why these numbers are chosen deliberately.
    await render({ summary: ownerSummary(), liveSession: { reservedUnits: 400, consumedUnits: consumed } })
    expect(text()).toMatch(pattern)
    expect(liveRegion()).toMatch(pattern)
  })

  it('announces the ten-minute floor', async () => {
    // 10 remaining units = 10 minutes of transcription at 1 credit per minute.
    await render({ summary: ownerSummary(), liveSession: { reservedUnits: 200, consumedUnits: 190 } })
    expect(liveRegion()).toMatch(/ten minutes/i)
  })

  it('announces the most severe warning when several apply at once', async () => {
    // 90% of 100 leaves exactly ten minutes, so all three fire. The ten-minute floor is the one a
    // person can act on, and it must win regardless of the order they were collected in.
    await render({ summary: ownerSummary(), liveSession: { reservedUnits: 100, consumedUnits: 90 } })
    expect(liveRegion()).toMatch(/ten minutes/i)
    expect(liveRegion()).not.toMatch(/90%/)
  })

  it('says transcription stopped but the interview did not, at zero', async () => {
    await render({ summary: ownerSummary(), liveSession: { reservedUnits: 100, consumedUnits: 100 } })
    // spec.md: only paid provider capture stops. Saying "credits exhausted" alone would read as the
    // whole interview being over.
    expect(text()).toMatch(/notes and interview controls still work/i)
    expect(liveRegion()).toMatch(/notes and controls still work/i)
  })

  it('says nothing when there is no live session', async () => {
    await render({ summary: ownerSummary(), liveSession: null })
    expect(liveRegion()).toBe('')
    expect(text()).not.toMatch(/80%|90%|ten minutes/i)
  })

  it('does not re-announce the same warning as consumption ticks', async () => {
    // The property that makes the live region usable. Between 90 and 92 units the warning set is
    // unchanged, so the announcement must not be rewritten — a screen reader would repeat it.
    const props: CreditBalanceProps = {
      summary: ownerSummary(),
      liveSession: { reservedUnits: 400, consumedUnits: 360 },
    }
    await render(props)
    const first = liveRegion()
    expect(first).toMatch(/90%/)

    await render({ ...props, liveSession: { reservedUnits: 400, consumedUnits: 364 } })
    expect(liveRegion(), 'same warning set — the announcement is not rewritten').toBe(first)
  })

  it('re-announces when the warning set actually changes', async () => {
    const props: CreditBalanceProps = {
      summary: ownerSummary(),
      liveSession: { reservedUnits: 400, consumedUnits: 320 },
    }
    await render(props)
    expect(liveRegion()).toMatch(/80%/)

    await render({ ...props, liveSession: { reservedUnits: 400, consumedUnits: 360 } })
    expect(liveRegion()).toMatch(/90%/)
  })
})

describe('the rendered summary carries nothing from a provider', () => {
  it('never shows a stripe identifier, even if one leaked into the dto', async () => {
    // The route's DTO has no Stripe object, and this pins that the component would not render one
    // anyway — a summary shape change must not turn this panel into a place customer ids appear.
    await render({
      summary: ownerSummary({
        // @ts-expect-error deliberately shaped wrong: this is the leak being guarded against
        customer: { stripeCustomerId: 'cus_LEAKED', livemode: true },
      }),
    })
    expect(text()).not.toMatch(/cus_/)
    expect(text()).not.toMatch(/stripe/i)
  })
})
