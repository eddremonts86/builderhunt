/**
 * plans/UI/tasks.md Wave 6 "Add public/admin preview and profile/portfolio cross-links".
 *
 * `GET /api/builders/$builderId`'s new `portfolioClaimId` field — the builder profile's half of the
 * builder-profile ↔ portfolio cross-link. Only the anonymous (public) branch is exercised here:
 * `requireTenantPrincipal` is mocked to always reject, so every call falls through to
 * `findPublishedBuilderProfile`, matching how an anonymous visitor or crawler reaches this route.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  findPublishedBuilderProfile: vi.fn(),
  findVerifiedBuilderClaim: vi.fn(),
  isSuppressed: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/repositories/public-builders', () => ({
  findPublishedBuilderProfile: mocks.findPublishedBuilderProfile,
  findVerifiedBuilderClaim: mocks.findVerifiedBuilderClaim,
}))

vi.mock('~/shared/lib/profile-suppression', () => ({
  isSuppressed: mocks.isSuppressed,
}))

const { Route } = await import('~/routes/api/builders/$builderId')

async function callGet(builderId: string): Promise<Response> {
  const handler = (Route as unknown as {
    options: { server: { handlers: { GET: (a: { request: Request; params: { builderId: string } }) => Promise<Response> } } }
  }).options.server.handlers.GET
  return handler({ request: new Request(`https://app.test/api/builders/${builderId}`), params: { builderId } })
}

const PROFILE = {
  id: 'identity-1',
  source: 'github',
  sourceId: 'gh-1',
  username: 'octocat',
  displayName: 'Octo Cat',
  bio: null,
  avatarUrl: null,
  profileUrl: 'https://github.com/octocat',
  followersCount: 10,
  language: null,
  country: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireTenantPrincipal.mockRejectedValue(new Error('no session'))
  mocks.isSuppressed.mockResolvedValue(false)
  mocks.findPublishedBuilderProfile.mockResolvedValue(PROFILE)
})

describe('GET /api/builders/$builderId — portfolioClaimId', () => {
  it('is null when the builder has never been claimed', async () => {
    mocks.findVerifiedBuilderClaim.mockResolvedValue(null)
    const res = await callGet('identity-1')
    const body = await res.json()
    expect(body.portfolioClaimId).toBeNull()
  })

  it('is null when the claim is verified but the portfolio was never configured', async () => {
    mocks.findVerifiedBuilderClaim.mockResolvedValue({ id: 'claim-1', subjectUserId: 'u1', verifiedAt: new Date(), metadata: {} })
    const res = await callGet('identity-1')
    const body = await res.json()
    expect(body.isClaimed).toBe(true)
    expect(body.portfolioClaimId).toBeNull()
  })

  it('is null when the portfolio is configured but not published', async () => {
    mocks.findVerifiedBuilderClaim.mockResolvedValue({
      id: 'claim-1', subjectUserId: 'u1', verifiedAt: new Date(),
      metadata: { portfolio: { published: false, publishedAt: null } },
    })
    const res = await callGet('identity-1')
    const body = await res.json()
    expect(body.portfolioClaimId).toBeNull()
  })

  it('carries the claimId once the portfolio is published', async () => {
    mocks.findVerifiedBuilderClaim.mockResolvedValue({
      id: 'claim-1', subjectUserId: 'u1', verifiedAt: new Date(),
      metadata: { portfolio: { published: true, publishedAt: new Date().toISOString() } },
    })
    const res = await callGet('identity-1')
    const body = await res.json()
    expect(body.portfolioClaimId).toBe('claim-1')
  })

  it('is null again once the claim is revoked (findVerifiedBuilderClaim no longer matches it)', async () => {
    // A revoked claim's status moves off 'verified', so the repository's own filter excludes it —
    // simulated here by the mock simply returning null, exactly like the real query would.
    mocks.findVerifiedBuilderClaim.mockResolvedValue(null)
    const res = await callGet('identity-1')
    const body = await res.json()
    expect(body.isClaimed).toBe(false)
    expect(body.portfolioClaimId).toBeNull()
  })

  it('returns 404 (and never reaches portfolioClaimId) for a missing builder', async () => {
    mocks.findPublishedBuilderProfile.mockResolvedValue(null)
    const res = await callGet('does-not-exist')
    expect(res.status).toBe(404)
  })
})
