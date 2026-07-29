import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  getConsentStatus: vi.fn(),
  isVerifiedBuilderClaimant: vi.fn(),
  findBuilderProfileViewForDay: vi.fn(),
  recordBuilderProfileView: vi.fn(),
  listBuilderProfileViewCounts: vi.fn(),
}))

vi.mock('~/shared/lib/auth/better-auth', () => ({
  auth: { api: { getSession: mocks.getSession } },
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

vi.mock('~/shared/lib/legal', () => ({
  getConsentStatus: mocks.getConsentStatus,
}))

vi.mock('~/shared/lib/repositories/builder-claims', () => ({
  isVerifiedBuilderClaimant: mocks.isVerifiedBuilderClaimant,
}))

vi.mock('~/shared/lib/repositories/builder-profile-views', () => ({
  findBuilderProfileViewForDay: mocks.findBuilderProfileViewForDay,
  recordBuilderProfileView: mocks.recordBuilderProfileView,
  listBuilderProfileViewCounts: mocks.listBuilderProfileViewCounts,
}))

const { Route } = await import('~/routes/api/builders/$builderId/views')

function call(method: 'GET' | 'POST'): Promise<Response> {
  const handler = (Route as unknown as {
    options: { server: { handlers: { POST: (a: { request: Request; params: { builderId: string } }) => Promise<Response>; GET: (a: { request: Request; params: { builderId: string } }) => Promise<Response> } } }
  }).options.server.handlers[method]
  return handler({
    request: new Request('https://app.test/api/builders/builder-1/views', { method }),
    params: { builderId: 'builder-1' },
  })
}

const fakePrincipal = { userId: 'u-owner', organizationId: 'org-1', role: 'owner' as const, requestId: 'r-1' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireTenantPrincipal.mockResolvedValue(fakePrincipal)
  // by default withTenantContext invokes its callback with a fake tx
  mocks.withTenantContext.mockImplementation(async (_p, cb) => cb({} as never))
})

describe('POST /api/builders/$builderId/views', () => {
  it('writes a row when the caller is authenticated and has privacy consent', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u-viewer' } })
    mocks.getConsentStatus.mockResolvedValue({ needsAcceptance: [] })
    mocks.findBuilderProfileViewForDay.mockResolvedValue(false)

    const response = await call('POST')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(mocks.recordBuilderProfileView).toHaveBeenCalledWith({}, 'builder-1', 'u-viewer', expect.any(Date))
  })

  it('returns 401 for an anonymous request and never writes a row', async () => {
    mocks.getSession.mockResolvedValue(null)

    const response = await call('POST')
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.error).toBe('authentication_required')
    expect(mocks.recordBuilderProfileView).not.toHaveBeenCalled()
    expect(mocks.getConsentStatus).not.toHaveBeenCalled()
  })

  it('returns 451 consent_required when the viewer has not accepted privacy', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u-viewer' } })
    mocks.getConsentStatus.mockResolvedValue({ needsAcceptance: ['privacy'] })

    const response = await call('POST')
    const body = await response.json()

    expect(response.status).toBe(451)
    expect(body.error).toBe('consent_required')
    expect(body.document).toBe('privacy')
    expect(mocks.recordBuilderProfileView).not.toHaveBeenCalled()
  })

  it('is idempotent at the (viewer, builder, day) granularity', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u-viewer' } })
    mocks.getConsentStatus.mockResolvedValue({ needsAcceptance: [] })
    // Already saw this builder today — must not write again.
    mocks.findBuilderProfileViewForDay.mockResolvedValue(true)

    const response = await call('POST')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(mocks.recordBuilderProfileView).not.toHaveBeenCalled()
  })
})

describe('GET /api/builders/$builderId/views', () => {
  it('returns counts to the verified owner', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u-owner' } })
    mocks.isVerifiedBuilderClaimant.mockResolvedValue(true)
    mocks.listBuilderProfileViewCounts.mockResolvedValue([
      { day: '2026-07-29', count: 4 },
      { day: '2026-07-28', count: 7 },
    ])

    const response = await call('GET')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.builderId).toBe('builder-1')
    expect(body.windowDays).toBe(30)
    expect(body.total).toBe(11)
    expect(body.daily).toHaveLength(2)
    // No viewer identities leak in the payload.
    expect(JSON.stringify(body)).not.toMatch(/u-viewer|u-other/)
  })

  it('returns 403 to a non-owner who is still authenticated', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u-stranger' } })
    mocks.isVerifiedBuilderClaimant.mockResolvedValue(false)

    const response = await call('GET')
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error).toBe('forbidden')
    expect(mocks.listBuilderProfileViewCounts).not.toHaveBeenCalled()
  })

  it('returns 401 to an anonymous request', async () => {
    mocks.getSession.mockResolvedValue(null)

    const response = await call('GET')
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.error).toBe('authentication_required')
    expect(mocks.isVerifiedBuilderClaimant).not.toHaveBeenCalled()
  })
})
