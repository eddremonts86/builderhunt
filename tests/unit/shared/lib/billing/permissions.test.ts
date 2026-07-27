import { describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { PlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import {
  BillingAuthorizationError,
  canConfigureAutoRecharge,
  canMutateBilling,
  canOpenBillingPortal,
  canReadBillingSummary,
  canRequestBillingRefund,
  canViewBillingAvailability,
  RECENT_AUTH_REQUIRED_BILLING_ACTIONS,
  requireBillingPermission,
  requirePlatformBillingConfigurationAccess,
  requireRecentBillingAuthentication,
} from '~/shared/lib/billing/permissions'

const principal = (role: TenantPrincipal['role']): TenantPrincipal => ({
  userId: 'user-a',
  organizationId: 'org-a',
  role,
  requestId: 'request-1',
})

describe('billing permissions — complete role/action matrix', () => {
  const matrix: Array<{
    name: string
    predicate: (p: TenantPrincipal) => boolean
    member: boolean
    admin: boolean
    owner: boolean
  }> = [
    { name: 'billing:availability', predicate: canViewBillingAvailability, member: true, admin: true, owner: true },
    { name: 'billing:read', predicate: canReadBillingSummary, member: false, admin: true, owner: true },
    { name: 'billing:mutate', predicate: canMutateBilling, member: false, admin: false, owner: true },
    { name: 'billing:refund', predicate: canRequestBillingRefund, member: false, admin: false, owner: true },
    { name: 'billing:portal', predicate: canOpenBillingPortal, member: false, admin: false, owner: true },
    { name: 'billing:auto-recharge', predicate: canConfigureAutoRecharge, member: false, admin: false, owner: true },
  ]

  for (const row of matrix) {
    it(`${row.name} follows owner/admin/member availability`, () => {
      expect(row.predicate(principal('member'))).toBe(row.member)
      expect(row.predicate(principal('admin'))).toBe(row.admin)
      expect(row.predicate(principal('owner'))).toBe(row.owner)
    })
  }

  it('member gets minimal availability only — never the financial summary or any mutation', () => {
    const member = principal('member')
    expect(canViewBillingAvailability(member)).toBe(true)
    expect(canReadBillingSummary(member)).toBe(false)
    expect(canMutateBilling(member)).toBe(false)
    expect(canRequestBillingRefund(member)).toBe(false)
    expect(canOpenBillingPortal(member)).toBe(false)
    expect(canConfigureAutoRecharge(member)).toBe(false)
  })

  it('admin reads the financial summary but cannot mutate, refund, open Portal, or configure auto-recharge', () => {
    const admin = principal('admin')
    expect(canReadBillingSummary(admin)).toBe(true)
    expect(canMutateBilling(admin)).toBe(false)
    expect(canRequestBillingRefund(admin)).toBe(false)
    expect(canOpenBillingPortal(admin)).toBe(false)
    expect(canConfigureAutoRecharge(admin)).toBe(false)
  })

  it('owner alone can do everything', () => {
    const owner = principal('owner')
    expect(canReadBillingSummary(owner)).toBe(true)
    expect(canMutateBilling(owner)).toBe(true)
    expect(canRequestBillingRefund(owner)).toBe(true)
    expect(canOpenBillingPortal(owner)).toBe(true)
    expect(canConfigureAutoRecharge(owner)).toBe(true)
  })
})

describe('requireBillingPermission — role gate', () => {
  it('throws 403 for a member attempting a mutation, before any recent-auth check runs', () => {
    expect(() => requireBillingPermission(principal('member'), 'billing:mutate'))
      .toThrowError(expect.objectContaining({ status: 403 }))
  })

  it('throws 403 for an admin attempting a refund', () => {
    expect(() => requireBillingPermission(principal('admin'), 'billing:refund'))
      .toThrowError(expect.objectContaining({ status: 403 }))
  })

  it('allows an owner to mutate general billing state with no session required (not in the recent-auth set)', () => {
    expect(() => requireBillingPermission(principal('owner'), 'billing:mutate')).not.toThrow()
  })
})

describe('requireBillingPermission — stale-session gate', () => {
  // requireBillingPermission always checks against the real wall clock (no `now` override in its
  // signature), so these two must be relative to Date.now() — only the explicit
  // requireRecentBillingAuthentication(session, now) call below uses a fixed instant.
  const freshSession = { authenticatedAt: new Date(Date.now() - 5 * 60 * 1000) }
  const staleSession = { authenticatedAt: new Date(Date.now() - 20 * 60 * 1000) }

  it('requires recent auth for refund, Portal, and auto-recharge, but not for a plain mutation', () => {
    expect(RECENT_AUTH_REQUIRED_BILLING_ACTIONS.has('billing:refund')).toBe(true)
    expect(RECENT_AUTH_REQUIRED_BILLING_ACTIONS.has('billing:portal')).toBe(true)
    expect(RECENT_AUTH_REQUIRED_BILLING_ACTIONS.has('billing:auto-recharge')).toBe(true)
    expect(RECENT_AUTH_REQUIRED_BILLING_ACTIONS.has('billing:mutate')).toBe(false)
    expect(RECENT_AUTH_REQUIRED_BILLING_ACTIONS.has('billing:read')).toBe(false)
    expect(RECENT_AUTH_REQUIRED_BILLING_ACTIONS.has('billing:availability')).toBe(false)
  })

  it('allows an owner refund request with a fresh session', () => {
    expect(() => requireBillingPermission(principal('owner'), 'billing:refund', freshSession)).not.toThrow()
  })

  it('rejects an owner refund request with a session older than 15 minutes', () => {
    expect(() => requireBillingPermission(principal('owner'), 'billing:refund', staleSession))
      .toThrowError(expect.objectContaining({ status: 401, message: 'Please sign in again to continue' }))
  })

  it('rejects a recent-auth-gated action with no session at all', () => {
    expect(() => requireBillingPermission(principal('owner'), 'billing:auto-recharge'))
      .toThrowError(expect.objectContaining({ status: 401 }))
  })

  it('requireRecentBillingAuthentication accepts exactly at the boundary and rejects just past it', () => {
    const now = new Date('2026-07-23T12:00:00Z')
    const exactlyAtLimit = { authenticatedAt: new Date(now.getTime() - 15 * 60 * 1000) }
    expect(() => requireRecentBillingAuthentication(exactlyAtLimit, now)).not.toThrow()

    const justPastLimit = { authenticatedAt: new Date(now.getTime() - 15 * 60 * 1000 - 1000) }
    expect(() => requireRecentBillingAuthentication(justPastLimit, now)).toThrow(BillingAuthorizationError)
  })
})

describe('platform operator billing configuration access — structurally separate from TenantPrincipal', () => {
  const platformAdmin: PlatformAdminPrincipal = { userId: 'platform-user-1', requestId: 'request-2' }

  it('accepts a resolved platform admin principal', () => {
    expect(() => requirePlatformBillingConfigurationAccess(platformAdmin)).not.toThrow()
  })

  it('never accepts an organizationId/role field — the principal type has neither', () => {
    expect(platformAdmin).not.toHaveProperty('organizationId')
    expect(platformAdmin).not.toHaveProperty('role')
  })
})
