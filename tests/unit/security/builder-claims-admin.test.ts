/**
 * `listBuilderClaimsForAdmin` (plans/UI/tasks.md Wave 4 "Build platform-admin claim management
 * projection").
 *
 * What matters: the DTO never carries `verificationSecretHash` or the raw `metadata` jsonb — only
 * the derived `portfolioPublished` boolean — and bounded cursor pagination/filters behave correctly
 * against a real database rather than a mock, since the pagination logic is hand-built SQL (no
 * tuple comparator in Drizzle) and a jsonb predicate for the portfolio-published filter.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const schema = await import('~/shared/lib/db/schema')
const { listBuilderClaimsForAdmin: listBuilderClaimsForAdminRaw } = await import('~/shared/lib/repositories/builder-claims')

let db: PostgresJsDatabase
let drop: () => Promise<void>

// `authDb` is a real module-level singleton pointed at the app's normal DATABASE_URL, not this
// disposable database — inject the disposable `db` as the auth-broker override (same seam
// `billing/checkout.ts` uses) so the claimant name/email lookup resolves against the rows this
// file actually seeded, instead of failing to authenticate against the wrong database.
function listBuilderClaimsForAdmin(
  dbArg: Parameters<typeof listBuilderClaimsForAdminRaw>[0],
  options?: Parameters<typeof listBuilderClaimsForAdminRaw>[1],
) {
  return listBuilderClaimsForAdminRaw(dbArg, options, db as never)
}

const OWNER = 'bca-owner'

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('builder_claims_admin')
  db = disposable.db
  drop = disposable.drop

  await db.insert(schema.authUsers).values({
    id: OWNER, name: 'Owner', email: 'bca-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(schema.builderClaims)
  await db.delete(schema.publishedBuilderProfiles)
  await db.delete(schema.builderIdentities)
})

let identityCounter = 0
async function seedClaim(overrides: {
  status?: 'pending' | 'verified' | 'rejected' | 'revoked' | 'expired'
  source?: string
  verifiedAt?: Date | null
  createdAt?: Date
  portfolioPublished?: boolean
  publishDirectory?: boolean
  verificationSecretHash?: string | null
} = {}) {
  identityCounter += 1
  const suffix = `bca-${identityCounter}`
  const [identity] = await db.insert(schema.builderIdentities).values({
    id: `identity-${suffix}`,
    source: overrides.source ?? 'github', sourceId: suffix, username: suffix, displayName: `Builder ${suffix}`,
    profileUrl: `https://e2e.test/${suffix}`,
  }).returning({ id: schema.builderIdentities.id })

  const claimId = `claim-${suffix}`
  await db.insert(schema.builderClaims).values({
    id: claimId,
    builderIdentityId: identity.id,
    subjectUserId: OWNER,
    evidenceSource: overrides.source ?? 'github',
    evidenceReference: suffix,
    verificationSecretHash: overrides.verificationSecretHash ?? 'sha256:should-never-leave-the-repository',
    status: overrides.status ?? 'verified',
    verifiedAt: overrides.verifiedAt === undefined ? new Date() : overrides.verifiedAt,
    createdAt: overrides.createdAt ?? new Date(),
    metadata: overrides.portfolioPublished === undefined
      ? {}
      : { portfolio: { published: overrides.portfolioPublished, publishedAt: overrides.portfolioPublished ? new Date().toISOString() : null } },
  })

  if (overrides.publishDirectory) {
    await db.insert(schema.publishedBuilderProfiles).values({
      builderIdentityId: identity.id, publishedByUserId: OWNER, displayName: `Builder ${suffix}`,
    })
  }

  return { claimId, builderIdentityId: identity.id }
}

describe('listBuilderClaimsForAdmin', () => {
  it('never includes verificationSecretHash or raw metadata in the DTO', async () => {
    await seedClaim({ portfolioPublished: true })
    const result = await listBuilderClaimsForAdmin(db as never)
    expect(result.rows).toHaveLength(1)
    const serialized = JSON.stringify(result.rows[0])
    expect(serialized).not.toContain('should-never-leave-the-repository')
    expect(serialized).not.toContain('verificationSecretHash')
    expect(serialized).not.toContain('"metadata"')
    // Only the derived boolean survives.
    expect(result.rows[0].portfolioPublished).toBe(true)
  })

  it('filters by status', async () => {
    await seedClaim({ status: 'verified' })
    await seedClaim({ status: 'pending', verifiedAt: null })
    await seedClaim({ status: 'revoked' })

    const verifiedOnly = await listBuilderClaimsForAdmin(db as never, { status: ['verified'] })
    expect(verifiedOnly.rows).toHaveLength(1)
    expect(verifiedOnly.rows[0].status).toBe('verified')

    const pendingOrRevoked = await listBuilderClaimsForAdmin(db as never, { status: ['pending', 'revoked'] })
    expect(pendingOrRevoked.rows.map((r) => r.status).sort()).toEqual(['pending', 'revoked'])
  })

  it('filters by source', async () => {
    await seedClaim({ source: 'github' })
    await seedClaim({ source: 'reddit' })
    const result = await listBuilderClaimsForAdmin(db as never, { source: 'reddit' })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].builderSource).toBe('reddit')
  })

  it('filters by portfolioPublished via the jsonb predicate, not a post-filter (page stays full)', async () => {
    for (let i = 0; i < 3; i++) await seedClaim({ portfolioPublished: true })
    for (let i = 0; i < 2; i++) await seedClaim({ portfolioPublished: false })

    const published = await listBuilderClaimsForAdmin(db as never, { portfolioPublished: true, limit: 10 })
    expect(published.rows).toHaveLength(3)
    expect(published.rows.every((r) => r.portfolioPublished)).toBe(true)

    const unpublished = await listBuilderClaimsForAdmin(db as never, { portfolioPublished: false, limit: 10 })
    expect(unpublished.rows).toHaveLength(2)
  })

  it('reports directoryPublished independently of the portfolio-builder publish flag', async () => {
    await seedClaim({ publishDirectory: true, portfolioPublished: false })
    const result = await listBuilderClaimsForAdmin(db as never)
    expect(result.rows[0].directoryPublished).toBe(true)
    expect(result.rows[0].portfolioPublished).toBe(false)
  })

  it('paginates with a keyset cursor, oldest-safe and without skipping or repeating rows', async () => {
    const base = new Date('2026-01-01T00:00:00.000Z')
    const seeded = []
    for (let i = 0; i < 5; i++) {
      seeded.push(await seedClaim({ createdAt: new Date(base.getTime() + i * 60_000) }))
    }

    const page1 = await listBuilderClaimsForAdmin(db as never, { limit: 2 })
    expect(page1.rows).toHaveLength(2)
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await listBuilderClaimsForAdmin(db as never, { limit: 2, before: { createdAt: new Date(page1.nextCursor!.createdAt), id: page1.nextCursor!.id } })
    expect(page2.rows).toHaveLength(2)

    const page3 = await listBuilderClaimsForAdmin(db as never, { limit: 2, before: { createdAt: new Date(page2.nextCursor!.createdAt), id: page2.nextCursor!.id } })
    expect(page3.rows).toHaveLength(1)
    expect(page3.nextCursor).toBeNull()

    const allIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id)
    expect(new Set(allIds).size).toBe(5)
    expect(allIds.sort()).toEqual(seeded.map((s) => s.claimId).sort())
  })
})
