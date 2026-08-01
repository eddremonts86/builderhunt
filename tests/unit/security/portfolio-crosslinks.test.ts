/**
 * plans/UI/tasks.md Wave 6 "Add public/admin preview and profile/portfolio cross-links".
 *
 * `getPortfolioLinkContext` and `findVerifiedBuilderClaim`'s new `id`/`metadata` fields against a
 * real database — proves the "allowlisted public target exists" gate for both directions of the
 * builder-profile ↔ portfolio cross-link: a pending/rejected/revoked/expired claim must resolve the
 * same as no claim at all, and `findPublishedBuilderProfile` is the independent gate for whether a
 * builder identity's own profile page exists to link to.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, builderClaims, builderIdentities, organizationBuilders, organizations, publishedBuilderProfiles } from '~/shared/lib/db/schema'
import { getPortfolioLinkContext } from '~/shared/lib/repositories/builder-claims'
import { findPublishedBuilderProfile, findVerifiedBuilderClaim } from '~/shared/lib/repositories/public-builders'
import { findClaimantOwnedAiEnrichment } from '~/shared/lib/repositories/organization-builders'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const OWNER = 'pcl-owner'
const OTHER_USER = 'pcl-other'

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('portfolio_crosslinks')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values([
    { id: OWNER, name: 'Owner', email: 'pcl-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: OTHER_USER, name: 'Other', email: 'pcl-other@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(builderClaims)
  await db.delete(publishedBuilderProfiles)
  await db.delete(organizationBuilders)
  await db.delete(organizations)
  await db.delete(builderIdentities)
})

let seq = 0
async function seedIdentity() {
  seq += 1
  const id = `identity-${seq}`
  await db.insert(builderIdentities).values({
    id, source: 'github', sourceId: `gh-${seq}`, username: `user${seq}`, profileUrl: `https://github.com/user${seq}`,
  })
  return id
}

async function seedClaim(identityId: string, overrides: {
  status?: 'pending' | 'verified' | 'rejected' | 'revoked' | 'expired'
  portfolioPublished?: boolean
} = {}) {
  seq += 1
  const claimId = `claim-${seq}`
  await db.insert(builderClaims).values({
    id: claimId,
    builderIdentityId: identityId,
    subjectUserId: OWNER,
    evidenceSource: 'github',
    evidenceReference: `ev-${seq}`,
    status: overrides.status ?? 'verified',
    verifiedAt: (overrides.status ?? 'verified') === 'verified' ? new Date() : null,
    metadata: overrides.portfolioPublished === undefined
      ? {}
      : { portfolio: { published: overrides.portfolioPublished, publishedAt: overrides.portfolioPublished ? new Date().toISOString() : null } },
  })
  return claimId
}

describe('getPortfolioLinkContext', () => {
  it('returns the builderIdentityId and subjectUserId for a verified claim', async () => {
    const identityId = await seedIdentity()
    const claimId = await seedClaim(identityId, { status: 'verified' })
    const ctx = await getPortfolioLinkContext(db as never, claimId)
    expect(ctx).toEqual({ builderIdentityId: identityId, subjectUserId: OWNER })
  })

  it.each(['pending', 'rejected', 'revoked', 'expired'] as const)(
    'returns null for a %s claim (same as no claim at all)',
    async (status) => {
      const identityId = await seedIdentity()
      const claimId = await seedClaim(identityId, { status })
      expect(await getPortfolioLinkContext(db as never, claimId)).toBeNull()
    },
  )

  it('returns null for an unknown claimId', async () => {
    expect(await getPortfolioLinkContext(db as never, 'does-not-exist')).toBeNull()
  })

  it('never leaks verificationSecretHash or the raw metadata blob', async () => {
    const identityId = await seedIdentity()
    const claimId = await seedClaim(identityId, { status: 'verified', portfolioPublished: true })
    const ctx = await getPortfolioLinkContext(db as never, claimId)
    const serialized = JSON.stringify(ctx)
    expect(serialized).not.toContain('metadata')
    expect(serialized).not.toContain('portfolio')
  })
})

describe('findVerifiedBuilderClaim — id/metadata for the portfolio cross-link', () => {
  it('carries id and metadata so the caller can derive portfolioClaimId', async () => {
    const identityId = await seedIdentity()
    const claimId = await seedClaim(identityId, { status: 'verified', portfolioPublished: true })
    const claim = await findVerifiedBuilderClaim(identityId, db)
    expect(claim?.id).toBe(claimId)
    expect((claim?.metadata as Record<string, unknown>).portfolio).toMatchObject({ published: true })
  })

  it('returns null for a revoked claim, not the stale metadata', async () => {
    const identityId = await seedIdentity()
    await seedClaim(identityId, { status: 'revoked', portfolioPublished: true })
    expect(await findVerifiedBuilderClaim(identityId, db)).toBeNull()
  })
})

describe('findPublishedBuilderProfile — the independent gate for the reverse link', () => {
  it('is null until the identity has its own published_builder_profiles row, even with a published portfolio', async () => {
    const identityId = await seedIdentity()
    await seedClaim(identityId, { status: 'verified', portfolioPublished: true })
    expect(await findPublishedBuilderProfile(identityId, db)).toBeNull()
  })

  it('is non-null once the identity is published', async () => {
    const identityId = await seedIdentity()
    await db.insert(publishedBuilderProfiles).values({ builderIdentityId: identityId, publishedByUserId: OWNER })
    expect(await findPublishedBuilderProfile(identityId, db)).not.toBeNull()
  })
})

/**
 * plans/UI/tasks.md Wave 7 "Add opt-in AI persona to public portfolios" — `findClaimantOwnedAiEnrichment`
 * is the gate that keeps a public portfolio from ever surfacing another organization's private
 * research about the same shared `builder_identities` row.
 */
describe('findClaimantOwnedAiEnrichment — only the claimant\'s own tracking counts', () => {
  async function seedOrg(id: string) {
    await db.insert(organizations).values({ id, name: id, slug: id })
  }

  it('returns null when the identity has never been tracked by anyone', async () => {
    const identityId = await seedIdentity()
    expect(await findClaimantOwnedAiEnrichment(db as never, identityId, OWNER)).toBeNull()
  })

  it('returns null when the identity is tracked, but not by the claimant themselves', async () => {
    const identityId = await seedIdentity()
    await seedOrg('org-a')
    await db.insert(organizationBuilders).values({
      id: 'ob-1', organizationId: 'org-a', builderIdentityId: identityId, creatorUserId: OTHER_USER,
      privateMetadata: { aiEnrichment: { summary: 'a', model: 'x' } },
    })
    // OWNER did not track this builder themselves — org-a's enrichment (created by OTHER_USER) must
    // stay invisible to a lookup keyed on OWNER, even though the identity itself is shared/global.
    expect(await findClaimantOwnedAiEnrichment(db as never, identityId, OWNER)).toBeNull()
  })

  it('returns the raw artifact when the claimant tracked this identity themselves', async () => {
    const identityId = await seedIdentity()
    await seedOrg('org-b')
    const enrichment = { summary: 'Ships reliable systems.', model: 'minimax', enrichedAt: new Date().toISOString() }
    await db.insert(organizationBuilders).values({
      id: 'ob-2', organizationId: 'org-b', builderIdentityId: identityId, creatorUserId: OWNER,
      privateMetadata: { aiEnrichment: enrichment },
    })
    expect(await findClaimantOwnedAiEnrichment(db as never, identityId, OWNER)).toEqual(enrichment)
  })

  it('returns null when the claimant tracked the builder but has no enrichment yet', async () => {
    const identityId = await seedIdentity()
    await seedOrg('org-c')
    await db.insert(organizationBuilders).values({
      id: 'ob-3', organizationId: 'org-c', builderIdentityId: identityId, creatorUserId: OWNER,
    })
    expect(await findClaimantOwnedAiEnrichment(db as never, identityId, OWNER)).toBeNull()
  })
})
