import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { AdminUsersPage } from '~/modules/admin/users/AdminUsersPage'

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

/**
 * Exactly what `GET /api/admin/users` returns — no more.
 *
 * These fixtures carried `plan`, `status` and `planEndsAt` until 2026-08-04, months after the API stopped
 * sending them with the retirement of the per-user `plans` table. That is how this file stayed green while every
 * manual grant in the real page answered 400: `startEdit` seeded the form from the now-absent `plan`, and a
 * fixture that still supplied it made the bug invisible here. A fixture richer than the response it stands in
 * for is not a fixture, it is a second implementation.
 */
const USERS = [
  {
    userId: 'u-canonical', name: 'Canonical Carl', email: 'carl@test.invalid', createdAt: '2027-01-01T00:00:00.000Z',
    billing: { organizationId: 'org-1', organizationName: 'Carl Co', entitlementTier: 'pro_max', entitlementStatus: 'active', currentPeriodEnd: null, trialEndsAt: null, provenance: 'canonical', hasActiveSubscription: true },
  },
  {
    userId: 'u-manual', name: 'Manual Mary', email: 'mary@test.invalid', createdAt: '2027-01-01T00:00:00.000Z',
    billing: { organizationId: 'org-2', organizationName: 'Mary Co', entitlementTier: 'team', entitlementStatus: 'active', currentPeriodEnd: '2099-01-01T00:00:00.000Z', trialEndsAt: null, provenance: 'manual_exception', hasActiveSubscription: false },
  },
  {
    userId: 'u-expired', name: 'Expired Eve', email: 'eve@test.invalid', createdAt: '2027-01-01T00:00:00.000Z',
    billing: { organizationId: 'org-3', organizationName: 'Eve Co', entitlementTier: 'pro', entitlementStatus: 'active', currentPeriodEnd: '2020-01-01T00:00:00.000Z', trialEndsAt: null, provenance: 'expired_exception', hasActiveSubscription: false },
  },
  {
    userId: 'u-none', name: 'Orgless Otto', email: 'otto@test.invalid', createdAt: '2027-01-01T00:00:00.000Z',
    billing: null,
  },
]

async function render() {
  const rootRoute = createRootRoute({ component: () => <AdminUsersPage /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function testId(id: string): Element | null {
  return container!.querySelector(`[data-testid="${id}"]`)
}

describe('AdminUsersPage', () => {
  it('distinguishes canonical, manual-exception, expired-exception, and no-organization fixtures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ users: USERS })))
    await render()

    expect(testId('admin-user-billing-canonical')?.textContent).toContain('Pro Max')
    expect(testId('admin-user-billing-manual_exception')?.textContent).toContain('team')
    expect(testId('admin-user-billing-expired_exception')?.textContent).toContain('pro')
    expect(testId('admin-user-billing-no-org')?.textContent).toContain('No organization')
  })

  it('links to Billing Operations, never presenting this page as Stripe subscription editing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ users: USERS })))
    await render()

    const link = testId('admin-users-billing-link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/admin/billing')
    // The page explicitly disclaims editing a Stripe subscription (a correct negative claim) —
    // what must never appear is a control that CLAIMS to manage/edit one directly.
    expect(container!.textContent).not.toMatch(/manage subscription/i)
    expect(testId('admin-user-plan-select')).toBeNull() // no edit in progress yet, so no risk of a misleading label on it
  })

  it('requires a reason before a manual grant can be saved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ users: USERS })))
    await render()

    await act(async () => (testId('admin-user-edit') as HTMLButtonElement)?.click())
    expect((testId('admin-user-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends a tier the route will accept, seeded from the canonical entitlement', async () => {
    /**
     * The test this file was missing, and its absence cost a working feature.
     *
     * Nothing here asserted the *shape* of the PATCH body, so when the API dropped the per-user `plan` field the
     * form began posting `plan: undefined` — dropped by `JSON.stringify`, rejected by the route's schema, shown
     * to the operator as "Failed: 400". Every assertion in this file still passed.
     *
     * `u-canonical` is deliberately the row under test: its organization is on `pro_max`, a tier the select
     * cannot offer because only Stripe can produce it. The form must fall back to a tier that *is* grantable
     * rather than post the current one.
     */
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ users: USERS }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, to: 'free' }))
      .mockResolvedValueOnce(jsonResponse({ users: USERS }))
    vi.stubGlobal('fetch', fetchMock)
    await render()

    await act(async () => (container!.querySelectorAll('[data-testid="admin-user-edit"]')[0] as HTMLButtonElement).click())
    const reasonInput = testId('admin-user-reason') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(reasonInput, 'paid by bank transfer')
      reasonInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      (testId('admin-user-save') as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const patchCall = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PATCH')
    expect(patchCall, 'Save must issue a PATCH').toBeTruthy()
    const body = JSON.parse((patchCall![1] as RequestInit).body as string) as { plan?: string; reason?: string }
    expect(['free', 'pro', 'team'], `posted plan: ${String(body.plan)}`).toContain(body.plan)
    expect(body.reason).toBe('paid by bank transfer')
    expect(testId('admin-users-success')).toBeTruthy()
  })

  it('surfaces a step-up rejection distinctly rather than a fake success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ users: USERS }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Recent re-authentication required' }, false, 401))
    vi.stubGlobal('fetch', fetchMock)
    await render()

    await act(async () => (container!.querySelectorAll('[data-testid="admin-user-edit"]')[0] as HTMLButtonElement).click())
    const reasonInput = testId('admin-user-reason') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(reasonInput, 'testing')
      reasonInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      (testId('admin-user-save') as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(testId('admin-users-error')?.textContent).toMatch(/re-authentication required/i)
  })
})
