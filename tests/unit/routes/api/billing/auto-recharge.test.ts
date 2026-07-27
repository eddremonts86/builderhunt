import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  getSession: vi.fn(),
  withTenantContext: vi.fn(),
  configureAutoRecharge: vi.fn(),
  disableAutoRecharge: vi.fn(),
  getAutoRechargeRuleForOwner: vi.fn(),
  getBillingProvider: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/auth/better-auth', () => ({
  auth: { api: { getSession: mocks.getSession } },
}))

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}))

vi.mock('~/shared/lib/billing/auto-recharge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/auto-recharge')>()
  return {
    ...actual,
    configureAutoRecharge: mocks.configureAutoRecharge,
    disableAutoRecharge: mocks.disableAutoRecharge,
    getAutoRechargeRuleForOwner: mocks.getAutoRechargeRuleForOwner,
  }
})

vi.mock('~/shared/lib/billing/stripe-provider', () => ({
  getBillingProvider: mocks.getBillingProvider,
}))

const { Route } = await import('~/routes/api/billing/auto-recharge')
const { AutoRechargeError } = await import('~/shared/lib/billing/auto-recharge')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

const RECENT_SESSION = { session: { createdAt: new Date().toISOString() } }

const ENABLE_BODY = {
  enabled: true,
  packCatalogKey: 'starter_300',
  balanceThresholdUnits: 50,
  monthlyCapCents: 10_000,
  acknowledgedOffSessionCharge: true,
}

function request(method: 'GET' | 'PUT', body?: unknown): Request {
  return new Request('https://app.test/api/billing/auto-recharge', {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  })
}

async function callRoute(method: 'GET' | 'PUT', body?: unknown): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: Record<string, (args: { request: Request }) => Promise<Response>> } } }).options.server.handlers[method]
  return handler({ request: request(method, body) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withTenantContext.mockImplementation((_principal: TenantPrincipal, fn: (tx: unknown) => unknown) => fn({}))
  mocks.getBillingProvider.mockReturnValue({})
  mocks.getSession.mockResolvedValue(RECENT_SESSION)
})

describe('GET /api/billing/auto-recharge — permission matrix', () => {
  it('allows an owner to read the rule', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getAutoRechargeRuleForOwner.mockResolvedValue({ enabled: true })

    const response = await callRoute('GET')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ rule: { enabled: true } })
  })

  it('rejects an admin with 403', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))

    const response = await callRoute('GET')

    expect(response.status).toBe(403)
    expect(mocks.getAutoRechargeRuleForOwner).not.toHaveBeenCalled()
  })

  it('rejects a member with 403', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('member'))

    const response = await callRoute('GET')

    expect(response.status).toBe(403)
  })

  it('rejects an owner with a stale session (401) — recent-auth required', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getSession.mockResolvedValue({ session: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() } })

    const response = await callRoute('GET')

    expect(response.status).toBe(401)
    expect(mocks.getAutoRechargeRuleForOwner).not.toHaveBeenCalled()
  })
})

describe('PUT /api/billing/auto-recharge — enable', () => {
  beforeEach(() => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
  })

  it('allows an owner to enable auto-recharge', async () => {
    mocks.configureAutoRecharge.mockResolvedValue({ enabled: true, state: 'active' })

    const response = await callRoute('PUT', ENABLE_BODY)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ rule: { enabled: true, state: 'active' } })
    expect(mocks.configureAutoRecharge).toHaveBeenCalledTimes(1)
  })

  it('rejects a spoofed field (unknown key, strict schema)', async () => {
    const response = await callRoute('PUT', { ...ENABLE_BODY, organizationId: 'attacker-org' })

    expect(response.status).toBe(400)
    expect(mocks.configureAutoRecharge).not.toHaveBeenCalled()
  })

  it('rejects a missing acknowledgment', async () => {
    const response = await callRoute('PUT', { ...ENABLE_BODY, acknowledgedOffSessionCharge: undefined })

    expect(response.status).toBe(400)
    expect(mocks.configureAutoRecharge).not.toHaveBeenCalled()
  })

  it.each([
    ['no_active_subscription', 403],
    ['unknown_pack_catalog_key', 400],
    ['invalid_threshold', 400],
    ['invalid_monthly_cap', 400],
    ['setup_requires_action', 409],
    ['provider_error', 502],
  ] as const)('maps AutoRechargeError(%s) to HTTP %i', async (code, expectedStatus) => {
    mocks.configureAutoRecharge.mockRejectedValue(new AutoRechargeError('service error', code))

    const response = await callRoute('PUT', ENABLE_BODY)

    expect(response.status).toBe(expectedStatus)
    expect((await response.json()).code).toBe(code)
  })

  it('maps an unexpected error to a generic 500', async () => {
    mocks.configureAutoRecharge.mockRejectedValue(new Error('unexpected db failure'))

    const response = await callRoute('PUT', ENABLE_BODY)

    expect(response.status).toBe(500)
  })
})

describe('PUT /api/billing/auto-recharge — disable', () => {
  it('allows an owner to disable auto-recharge without the enable-only fields', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.disableAutoRecharge.mockResolvedValue({ enabled: false, state: 'inactive' })

    const response = await callRoute('PUT', { enabled: false })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ rule: { enabled: false, state: 'inactive' } })
    expect(mocks.configureAutoRecharge).not.toHaveBeenCalled()
  })

  it('rejects a member with 403, never reaching the service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('member'))

    const response = await callRoute('PUT', { enabled: false })

    expect(response.status).toBe(403)
    expect(mocks.disableAutoRecharge).not.toHaveBeenCalled()
  })
})
