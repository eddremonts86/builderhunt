import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import type { OrganizationEntitlementDto } from '~/shared/lib/organizations/contracts'
import { OrganizationBillingCard } from './OrganizationBillingCard'

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
})

function baseEntitlement(viewerRole: OrganizationEntitlementDto['viewerRole']): OrganizationEntitlementDto {
  return {
    organizationName: 'Acme',
    isPersonal: false,
    viewerRole,
    tier: 'team',
    status: 'active',
    billingPeriod: 'monthly',
    currentPeriodEnd: '2026-08-22T00:00:00.000Z',
    trialEndsAt: null,
    notes: null,
    seatUsage: { used: 4, limit: 10 },
    paidActionsAllowed: true,
  }
}

async function render(entitlement: OrganizationEntitlementDto) {
  // `OrganizationBillingCard` renders a `<Link>` for its plan-change CTA —
  // needs a real router in the tree, same as `OrganizationSwitcher.test.tsx`.
  const rootRoute = createRootRoute({
    component: () => <OrganizationBillingCard entitlement={entitlement} />,
  })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
}

function testIds(): string[] {
  return Array.from(container!.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid')!)
}

describe('OrganizationBillingCard — authorization matrix', () => {
  it('owner sees full read state plus the plan-change affordance', async () => {
    await render(baseEntitlement('owner'))
    const ids = testIds()

    expect(ids).toContain('billing-plan-name')
    expect(ids).toContain('billing-seats')
    expect(ids).toContain('billing-features')
    expect(ids).toContain('billing-compare-cta')
    expect(ids).toContain('billing-email-us')
    expect(ids).not.toContain('billing-member-minimal')
  })

  it('a free-tier owner sees an upgrade CTA instead of compare-plans', async () => {
    const free = baseEntitlement('owner')
    free.tier = 'free'
    free.billingPeriod = 'none'
    free.seatUsage = { used: 1, limit: 1 }
    await render(free)
    const ids = testIds()

    expect(ids).toContain('billing-upgrade-cta')
    expect(ids).not.toContain('billing-compare-cta')
  })

  it('admin sees the same read-only detail as owner but no plan-change affordance', async () => {
    await render(baseEntitlement('admin'))
    const ids = testIds()

    expect(ids).toContain('billing-plan-name')
    expect(ids).toContain('billing-seats')
    expect(ids).toContain('billing-features')

    expect(ids).not.toContain('billing-compare-cta')
    expect(ids).not.toContain('billing-upgrade-cta')
    expect(ids).not.toContain('billing-email-us')
    expect(ids).not.toContain('billing-member-minimal')
  })

  it('member sees only a minimal plan notice, nothing else', async () => {
    await render(baseEntitlement('member'))
    const ids = testIds()

    expect(ids).toContain('billing-member-minimal')
    expect(ids).not.toContain('billing-plan-name')
    expect(ids).not.toContain('billing-seats')
    expect(ids).not.toContain('billing-features')
    expect(ids).not.toContain('billing-compare-cta')
    expect(ids).not.toContain('billing-upgrade-cta')
    expect(ids).not.toContain('billing-email-us')
  })

  it('shows a lapsed banner to every role once paid actions are no longer allowed, without hiding membership', async () => {
    const lapsedOwner = baseEntitlement('owner')
    lapsedOwner.status = 'past_due'
    lapsedOwner.paidActionsAllowed = false
    await render(lapsedOwner)
    expect(testIds()).toContain('billing-lapsed-banner')

    const lapsedMember = baseEntitlement('member')
    lapsedMember.status = 'canceled'
    lapsedMember.paidActionsAllowed = false
    await render(lapsedMember)
    const memberIds = testIds()
    expect(memberIds).toContain('billing-lapsed-banner')
    expect(memberIds).toContain('billing-member-minimal')
  })

  it('never shows a lapsed banner for a free-tier org (free is never "paid actions allowed" by design)', async () => {
    const free = baseEntitlement('member')
    free.tier = 'free'
    free.paidActionsAllowed = false
    await render(free)
    expect(testIds()).not.toContain('billing-lapsed-banner')
  })

  it('shows a trial banner only to owner/admin, never to a member', async () => {
    const trialingOwner = baseEntitlement('owner')
    trialingOwner.status = 'trialing'
    trialingOwner.trialEndsAt = '2026-09-01T00:00:00.000Z'
    await render(trialingOwner)
    expect(testIds()).toContain('billing-trial-banner')

    const trialingMember = baseEntitlement('member')
    trialingMember.status = 'trialing'
    await render(trialingMember)
    expect(testIds()).not.toContain('billing-trial-banner')
  })

  it('never renders fields beyond the DTO shape, even when a fixture is contaminated with extra data', async () => {
    const contaminated = baseEntitlement('owner')
    // @ts-expect-error deliberately contaminating the fixture with a field the DTO doesn't declare
    contaminated.stripeCustomerId = 'cus_super_secret'

    await render(contaminated)
    expect(container!.innerHTML).not.toContain('cus_super_secret')
  })
})
