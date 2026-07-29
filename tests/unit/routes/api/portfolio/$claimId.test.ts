// Plan 37 (portfolio-builder) task "Wire revocation and state
// transitions to immediate visibility" — security test.
//
// Verifies the contract: warm the public portfolio cache, then
// revoke the underlying claim, then assert the next public read
// is 404 (not a stale cache hit). The purgePortfolioCache call
// in the revoke handler is the line of code under test; if a
// future refactor removes it, this test fails.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  revokeBuilderClaim: vi.fn(),
  purgePortfolioCache: vi.fn(),
  getPublicPortfolioClaim: vi.fn(),
  getCachedPortfolio: vi.fn(),
  setCachedPortfolio: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  fetchPortfolioProjectCandidates: vi.fn(),
  buildPublicPortfolio: vi.fn(),
  parsePortfolioSettings: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', () => ({
  requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal,
  platformAdminErrorResponse: (_e: unknown) => null,
  auditPlatformAdminAction: mocks.auditPlatformAdminAction,
}))

vi.mock('~/shared/lib/repositories/builder-claims', () => ({
  revokeBuilderClaim: mocks.revokeBuilderClaim,
  getPublicPortfolioClaim: mocks.getPublicPortfolioClaim,
}))

vi.mock('~/shared/lib/portfolio-cache', () => ({
  getCachedPortfolio: mocks.getCachedPortfolio,
  setCachedPortfolio: mocks.setCachedPortfolio,
  purgePortfolioCache: mocks.purgePortfolioCache,
}))

vi.mock('~/shared/lib/portfolio', () => ({
  buildPublicPortfolio: mocks.buildPublicPortfolio,
  parsePortfolioSettings: mocks.parsePortfolioSettings,
}))

vi.mock('~/lib/github/content', () => ({
  fetchPortfolioProjectCandidates: mocks.fetchPortfolioProjectCandidates,
}))

const { Route: revokeRoute } = await import('~/routes/api/admin/builder-claims/$claimId/revoke')
const { Route: publicRoute } = await import('~/routes/api/portfolio/$claimId')

const adminPrincipal = {
  userId: 'admin-1', email: 'admin@test.invalid', name: 'Admin',
  isPlatformAdmin: true, requestId: 'r-1',
}

async function callRevoke(claimId: string, body: unknown): Promise<Response> {
  const handler = (revokeRoute as unknown as {
    options: { server: { handlers: { POST: (a: { request: Request; params: { claimId: string } }) => Promise<Response> } } }
  }).options.server.handlers.POST
  return handler({
    request: new Request(`https://app.test/api/admin/builder-claims/${claimId}/revoke`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    params: { claimId },
  })
}

async function callPublic(claimId: string): Promise<Response> {
  const handler = (publicRoute as unknown as {
    options: { server: { handlers: { GET: (a: { params: { claimId: string } }) => Promise<Response> } } }
  }).options.server.handlers.GET
  return handler({ params: { claimId } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requirePlatformAdminPrincipal.mockResolvedValue(adminPrincipal)
  mocks.revokeBuilderClaim.mockResolvedValue({
    claimId: 'claim-1',
    builderIdentityId: 'bi-1',
  })
  mocks.purgePortfolioCache.mockResolvedValue(undefined)
  mocks.auditPlatformAdminAction.mockResolvedValue(undefined)
  mocks.fetchPortfolioProjectCandidates.mockResolvedValue([])
  mocks.buildPublicPortfolio.mockReturnValue({
    claimId: 'claim-1',
    source: 'github',
    username: 'octocat',
    displayName: 'Octo Cat',
    profileUrl: 'https://github.com/octocat',
    settings: { tagline: null, bioOverride: null, featuredProjectSlugs: [], selectedSkills: [], customLinks: [], theme: 'auto' },
    projectCandidates: [],
  })
  mocks.parsePortfolioSettings.mockReturnValue({
    tagline: null,
    bioOverride: null,
    featuredProjectSlugs: [],
    selectedSkills: [],
    customLinks: [],
    theme: 'auto',
  })
})

describe('revoke -> cache purge -> public 404', () => {
  it('warms the public cache, revokes the claim, and the next public read is 404 (no stale cache)', async () => {
    // First public read: cache miss -> DB hit -> build -> cache set
    mocks.getCachedPortfolio.mockResolvedValueOnce(null)
    mocks.getPublicPortfolioClaim.mockResolvedValueOnce({
      claimId: 'claim-1',
      source: 'github',
      username: 'octocat',
      displayName: 'Octo Cat',
      profileUrl: 'https://github.com/octocat',
      avatarUrl: null,
      metadata: {},
    })
    const firstRead = await callPublic('claim-1')
    expect(firstRead.status).toBe(200)
    expect(mocks.setCachedPortfolio).toHaveBeenCalled()

    // Second public read: cache HIT (the same DTO). This proves
    // the cache is what would have served a stale read.
    mocks.getCachedPortfolio.mockResolvedValueOnce({
      claimId: 'claim-1',
      source: 'github',
      username: 'octocat',
      displayName: 'Octo Cat',
      profileUrl: 'https://github.com/octocat',
      settings: {
        tagline: null, bioOverride: null, featuredProjectSlugs: [],
        selectedSkills: [], customLinks: [], theme: 'auto',
      },
      projectCandidates: [],
    })
    const cachedRead = await callPublic('claim-1')
    expect(cachedRead.status).toBe(200)

    // Revoke the claim. The handler MUST purge the cache as part
    // of the same request.
    const revokeRes = await callRevoke('claim-1', { reason: 'security review' })
    expect(revokeRes.status).toBe(200)
    expect(mocks.purgePortfolioCache).toHaveBeenCalledWith('claim-1')

    // After the purge, the next public read sees a miss -> DB
    // returns null (claim is no longer active) -> 404. The cache
    // is the only thing standing between a revoked claim and a
    // public read; the purge is what closes the gap.
    mocks.getCachedPortfolio.mockResolvedValueOnce(null)
    mocks.getPublicPortfolioClaim.mockResolvedValueOnce(null)
    const afterRevoke = await callPublic('claim-1')
    expect(afterRevoke.status).toBe(404)
  })

  it('rejects a revoke with an empty reason (zod validation)', async () => {
    const res = await callRevoke('claim-1', { reason: '' })
    expect(res.status).toBe(400)
    expect(mocks.revokeBuilderClaim).not.toHaveBeenCalled()
    expect(mocks.purgePortfolioCache).not.toHaveBeenCalled()
  })

  it('returns 404 when the claim is not in active state', async () => {
    mocks.revokeBuilderClaim.mockResolvedValue(null)
    const res = await callRevoke('claim-1', { reason: 'not active' })
    expect(res.status).toBe(404)
    // No purge on a no-op revoke: there was nothing to invalidate.
    expect(mocks.purgePortfolioCache).not.toHaveBeenCalled()
  })
})
