/**
 * plans/UI/tasks.md Wave 6 "Connect paid-state actions consistently".
 *
 * `PaidStateActions` is the one shared component every paid-gated surface (Solutions,
 * CreditBalance, WorkSamplePanel, SearchPage) renders instead of hand-rolling its own upgrade
 * link — this pins the contract: Billing settings is always primary, Pricing details is secondary
 * only for `not_entitled` (Free/Pro/Pro Max/Team all hit this — the caller decides *whether* to gate,
 * this component decides *what to offer* once gated), `past_due` drops Pricing entirely (the org
 * already has the right tier — the fix is the payment, not the plan), and `stale_session` offers
 * neither until the caller can prove who they are again, carrying a return path back to the exact
 * page that sent them there.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PaidStateActions, type PaidStateReason } from '~/shared/components/PaidStateActions'

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

async function render(reason: PaidStateReason, opts: { returnTo?: string; initialPath?: string } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const rootRoute = createRootRoute({ component: () => <PaidStateActions reason={reason} returnTo={opts.returnTo} /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: [opts.initialPath ?? '/solutions'] }) })
  await act(async () => {
    root!.render(<RouterProvider router={router as never} />)
    await router.load()
  })
}

function links(): Record<string, HTMLAnchorElement> {
  const out: Record<string, HTMLAnchorElement> = {}
  for (const a of container!.querySelectorAll('a')) {
    const testId = a.getAttribute('data-testid')
    if (testId) out[testId] = a as HTMLAnchorElement
  }
  return out
}

describe('PaidStateActions — not_entitled (Free/Pro/Pro Max/Team hitting a higher-tier feature)', () => {
  it('offers Billing settings as primary and Pricing details as secondary', async () => {
    await render('not_entitled')
    expect(links()['paid-state-billing']).toBeDefined()
    expect(links()['paid-state-billing'].getAttribute('href')).toBe('/settings/billing')
    expect(links()['paid-state-pricing']).toBeDefined()
    expect(links()['paid-state-pricing'].getAttribute('href')).toBe('/pricing')
    expect(links()['paid-state-sign-in']).toBeUndefined()
  })
})

describe('PaidStateActions — past_due (org already entitled, payment problem)', () => {
  it('offers only Billing settings — Pricing would be a wrong nudge here', async () => {
    await render('past_due')
    expect(links()['paid-state-billing']).toBeDefined()
    expect(links()['paid-state-pricing']).toBeUndefined()
    expect(links()['paid-state-sign-in']).toBeUndefined()
  })
})

describe('PaidStateActions — stale_session (caller could not even check entitlement)', () => {
  it('offers only "sign in again" — neither Billing nor Pricing until the session is proven', async () => {
    await render('stale_session', { initialPath: '/solutions' })
    expect(links()['paid-state-sign-in']).toBeDefined()
    expect(links()['paid-state-billing']).toBeUndefined()
    expect(links()['paid-state-pricing']).toBeUndefined()
  })

  it('preserves the current path as the sign-in return path by default', async () => {
    await render('stale_session', { initialPath: '/search' })
    expect(links()['paid-state-sign-in'].getAttribute('href')).toBe('/auth/sign-in?redirect=%2Fsearch')
  })

  it('an explicit returnTo overrides the current path', async () => {
    await render('stale_session', { initialPath: '/search', returnTo: '/interviews/int-1' })
    expect(links()['paid-state-sign-in'].getAttribute('href')).toBe('/auth/sign-in?redirect=%2Finterviews%2Fint-1')
  })
})
