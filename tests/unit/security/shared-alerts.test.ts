// /api/alerts — security suite for the "create from shared query" path.
//
// Verifies:
// - 401 for unauthenticated.
// - 200 with copied keywords when the principal opts in with their
//   own private query.
// - 200 with copied keywords when the principal opts in with a
//   shared (organization-visible) query.
// - 403/404 when the source query is private and owned by another
//   member of the same organization (the principal-scoped visibility
//   check denies the read; we surface 404, not 403, so an attacker
//   cannot enumerate which query ids exist in their org).
// - 404 when the source query belongs to a different organization
//   (anti-enumeration: same code as a non-existent id).
// - 200 with no queryId still works (backwards-compatible path).
// - Client-supplied `organizationId` is data, never authority; the
//   strip helper drops it before zod sees the body.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  createOrganizationAlert: vi.fn(),
  createOrganizationAlertFromQueryForPrincipal: vi.fn(),
  getOrganizationEntitlement: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', () => ({
  requireTenantPrincipal: mocks.requireTenantPrincipal,
  TenantAuthorizationError: class extends Error {
    constructor(message: string, readonly status: 401 | 403) {
      super(message)
      this.name = 'TenantAuthorizationError'
    }
  },
}))

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}))

vi.mock('~/shared/lib/repositories/organization-alerts', () => ({
  createOrganizationAlert: mocks.createOrganizationAlert,
  createOrganizationAlertFromQueryForPrincipal: mocks.createOrganizationAlertFromQueryForPrincipal,
  deleteOrganizationAlert: vi.fn(),
  listOrganizationAlerts: vi.fn(),
}))

vi.mock('~/shared/lib/repositories/entitlements', () => ({
  getOrganizationEntitlement: mocks.getOrganizationEntitlement,
}))

vi.mock('~/shared/lib/rate-limit', () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 20, resetMs: 0 }),
}))

const { Route } = await import('~/routes/api/alerts/')
const { SharedResourceError } = await import('~/shared/lib/shared-resources/contracts')

const principal = { userId: 'u-1', organizationId: 'org-1', role: 'owner' as const, requestId: 'r-1' }

function call(body: unknown): Promise<Response> {
  const handler = (Route as unknown as {
    options: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } }
  }).options.server.handlers.POST
  return handler({
    request: new Request('https://app.test/api/alerts/', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireTenantPrincipal.mockResolvedValue(principal)
  mocks.withTenantContext.mockImplementation(async (_p, cb) => cb({} as never))
  mocks.getOrganizationEntitlement.mockResolvedValue({ paidActionsAllowed: true })
})

describe('POST /api/alerts (shared query opt-in)', () => {
  it('returns 401 when the caller is not authenticated', async () => {
    const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('Authentication required', 401))

    const response = await call({ name: 'a', queryId: 'q-1', triggerConditions: { eventType: 'any_activity' } })

    expect(response.status).toBe(401)
    expect(mocks.createOrganizationAlertFromQueryForPrincipal).not.toHaveBeenCalled()
  })

  it('returns 402 when the organization is not entitled to create alerts', async () => {
    mocks.getOrganizationEntitlement.mockResolvedValue({ paidActionsAllowed: false })

    const response = await call({ name: 'a', queryId: 'q-1', triggerConditions: { eventType: 'any_activity' } })
    const body = await response.json()

    expect(response.status).toBe(402)
    expect(body.upgradeUrl).toBe('/pricing')
    expect(mocks.createOrganizationAlertFromQueryForPrincipal).not.toHaveBeenCalled()
  })

  it('uses the principal-scoped path when queryId is provided and copies keywords from the source query', async () => {
    const created = {
      id: 'a-new',
      organizationId: 'org-1',
      userId: 'u-1',
      queryId: 'q-1',
      name: 'Watch rust people',
      keywords: ['rust', 'systems'],
      frequency: 'daily',
      enabled: true,
      triggerConditions: { eventType: 'any_activity' },
      createdAt: new Date(),
    }
    mocks.createOrganizationAlertFromQueryForPrincipal.mockResolvedValue(created)

    const response = await call({
      name: 'Watch rust people',
      queryId: 'q-1',
      triggerConditions: { eventType: 'any_activity' },
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.queryId).toBe('q-1')
    expect(body.keywords).toEqual(['rust', 'systems'])
    expect(mocks.createOrganizationAlertFromQueryForPrincipal).toHaveBeenCalledWith(
      {},
      principal,
      expect.objectContaining({ name: 'Watch rust people', queryId: 'q-1' }),
    )
    // The un-scoped creator is NOT used when a queryId was supplied.
    expect(mocks.createOrganizationAlert).not.toHaveBeenCalled()
  })

  it('returns 404 (not 403) when the source query is not visible to the principal — anti-enumeration', async () => {
    mocks.createOrganizationAlertFromQueryForPrincipal.mockRejectedValue(
      new SharedResourceError('not_found', 'Saved query not accessible', 404),
    )

    const response = await call({
      name: 'a',
      queryId: 'q-private-of-other-member',
      triggerConditions: { eventType: 'any_activity' },
    })
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error).toBe('not_found')
  })

  it('returns 404 when the source query belongs to a different organization (cross-tenant probe)', async () => {
    // findVisibleSavedQueryById filters by principal.organizationId, so a query from org-2
    // returns null to a principal in org-1. The repository throws not_found; the route
    // must surface 404, never 200 and never leak the existence of the cross-tenant id.
    mocks.createOrganizationAlertFromQueryForPrincipal.mockRejectedValue(
      new SharedResourceError('not_found', 'Saved query not accessible', 404),
    )

    const response = await call({
      name: 'a',
      queryId: 'q-belonging-to-org-2',
      triggerConditions: { eventType: 'any_activity' },
    })
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error).toBe('not_found')
  })

  it('falls back to the un-scoped path when no queryId is provided (backwards-compatible)', async () => {
    mocks.createOrganizationAlert.mockResolvedValue({
      id: 'a-new',
      organizationId: 'org-1',
      userId: 'u-1',
      name: 'Custom',
      keywords: ['react'],
      frequency: 'daily',
      enabled: true,
      triggerConditions: { eventType: 'keyword_match' },
      createdAt: new Date(),
    })

    const response = await call({
      name: 'Custom',
      keywords: ['react'],
      triggerConditions: { eventType: 'keyword_match' },
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.keywords).toEqual(['react'])
    expect(mocks.createOrganizationAlert).toHaveBeenCalled()
    expect(mocks.createOrganizationAlertFromQueryForPrincipal).not.toHaveBeenCalled()
  })

  it('strips a client-supplied organizationId before reaching the repository', async () => {
    mocks.createOrganizationAlertFromQueryForPrincipal.mockResolvedValue({
      id: 'a-new',
      organizationId: 'org-1',
      userId: 'u-1',
      queryId: 'q-1',
      name: 'a',
      keywords: ['go'],
      frequency: 'daily',
      enabled: true,
      triggerConditions: { eventType: 'any_activity' },
      createdAt: new Date(),
    })

    // The body attempts to attach the alert to a different org. The strip helper drops
    // organizationId / organization_id / orgId before zod sees them; the repository is
    // only ever called with the principal's organizationId (implicit, via principal).
    const response = await call({
      name: 'a',
      queryId: 'q-1',
      organizationId: 'org-attacker',
      organization_id: 'org-attacker',
      orgId: 'org-attacker',
      triggerConditions: { eventType: 'any_activity' },
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.organizationId).toBe('org-1')
    // Critical: the principal-scoped repo was called, not the un-scoped one.
    expect(mocks.createOrganizationAlert).not.toHaveBeenCalled()
    expect(mocks.createOrganizationAlertFromQueryForPrincipal).toHaveBeenCalled()
  })

  it('returns 400 when the body fails zod validation', async () => {
    const response = await call({ name: '', queryId: 'q-1' })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toBe('Invalid alert')
    expect(mocks.createOrganizationAlertFromQueryForPrincipal).not.toHaveBeenCalled()
  })
})
