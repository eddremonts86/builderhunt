import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, builderClaims, builderIdentities, builderProfileViews, publishedBuilderProfiles } from '~/shared/lib/db/schema'
import { getVerifiedProfileOwnerSummary } from '~/shared/lib/repositories/builder-profile-views'

/**
 * plans/ui-dashboard Wave 5, "Add an optional verified-profile-owner summary".
 *
 * This is where the cohort floor is actually enforced, and therefore where it has to be tested. The
 * widget is handed `null` and renders "fewer than N", which proves nothing about privacy — the
 * guarantee is that the number never gets produced.
 *
 * These run as the database superuser, so they say nothing about RLS. The row-level rules for this
 * table are checked by `scripts/db/verify-rls-local.mjs` against the real least-privilege roles; a
 * unit test here would report a pass no matter what the policies said.
 */

const FLOOR = 5
const WINDOW_START = new Date('2027-01-01T00:00:00Z')
const WINDOW_END = new Date('2027-02-01T00:00:00Z')
const INSIDE = new Date('2027-01-15T12:00:00Z')

let db: PostgresJsDatabase
let drop: () => Promise<void>

async function seedViews(builderId: string, viewerIds: string[]): Promise<void> {
  if (viewerIds.length === 0) return
  await db.insert(builderProfileViews).values(
    viewerIds.map((viewerId) => ({ builderId, viewerId, viewedAt: INSIDE })),
  )
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('repo_profile_owner')
  db = disposable.db
  drop = disposable.drop

  const users = [
    'owner-verified', 'owner-pending', 'owner-quiet', 'owner-published',
    ...Array.from({ length: 8 }, (_, index) => `viewer-${index}`),
  ]
  await db.insert(authUsers).values(users.map((id) => ({
    id, name: id, email: `${id}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })))

  await db.insert(builderIdentities).values([
    { id: 'ident-verified', source: 'github', sourceId: 'v', username: 'v', profileUrl: 'https://github.com/v' },
    { id: 'ident-pending', source: 'github', sourceId: 'p', username: 'p', profileUrl: 'https://github.com/p' },
    { id: 'ident-quiet', source: 'github', sourceId: 'q', username: 'q', profileUrl: 'https://github.com/q' },
    { id: 'ident-published', source: 'github', sourceId: 'pub', username: 'pub', profileUrl: 'https://github.com/pub' },
  ])

  await db.insert(builderClaims).values([
    { id: 'c-verified', builderIdentityId: 'ident-verified', subjectUserId: 'owner-verified', evidenceSource: 'email', evidenceReference: 'v@test.invalid', status: 'verified', createdAt: new Date() },
    { id: 'c-pending', builderIdentityId: 'ident-pending', subjectUserId: 'owner-pending', evidenceSource: 'email', evidenceReference: 'p@test.invalid', status: 'pending', createdAt: new Date() },
    { id: 'c-quiet', builderIdentityId: 'ident-quiet', subjectUserId: 'owner-quiet', evidenceSource: 'email', evidenceReference: 'q@test.invalid', status: 'verified', createdAt: new Date() },
    {
      id: 'c-published',
      builderIdentityId: 'ident-published',
      subjectUserId: 'owner-published',
      evidenceSource: 'email',
      evidenceReference: 'pub@test.invalid',
      status: 'verified',
      createdAt: new Date(),
      metadata: { portfolio: { published: true } },
    },
  ])

  await db.insert(publishedBuilderProfiles).values([
    { builderIdentityId: 'ident-verified', publishedByUserId: 'owner-verified' },
  ])

  // Six distinct viewers — one over the floor, so "counted" is a real threshold crossing rather than
  // a comfortable margin.
  await seedViews('ident-verified', Array.from({ length: 6 }, (_, index) => `viewer-${index}`))
  // Exactly one under, which is the case a floor exists for.
  await seedViews('ident-quiet', Array.from({ length: FLOOR - 1 }, (_, index) => `viewer-${index}`))
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('getVerifiedProfileOwnerSummary', () => {
  it('returns nothing at all for a user with no claim, so the section can be omitted', async () => {
    const summary = await db.transaction((tx) =>
      getVerifiedProfileOwnerSummary(tx, 'viewer-0', WINDOW_START, WINDOW_END, FLOOR))
    expect(summary).toBeNull()
  })

  /**
   * A claim that exists but is not verified must behave exactly like no claim. Anything else — an
   * empty summary, a zero — would tell someone mid-verification that the profile is being watched.
   */
  it('treats a pending claim as no claim', async () => {
    const summary = await db.transaction((tx) =>
      getVerifiedProfileOwnerSummary(tx, 'owner-pending', WINDOW_START, WINDOW_END, FLOOR))
    expect(summary).toBeNull()
  })

  it('counts distinct viewers for a verified owner above the floor', async () => {
    const summary = await db.transaction((tx) =>
      getVerifiedProfileOwnerSummary(tx, 'owner-verified', WINDOW_START, WINDOW_END, FLOOR))
    expect(summary?.viewsInWindow).toBe(6)
    expect(summary?.builderId).toBe('ident-verified')
  })

  /**
   * The point of the whole exercise: below the floor the number is not produced. Not rounded, not
   * bucketed, not returned for the client to hide — absent from the value the API will serialize.
   */
  it('produces no number at all below the floor', async () => {
    const summary = await db.transaction((tx) =>
      getVerifiedProfileOwnerSummary(tx, 'owner-quiet', WINDOW_START, WINDOW_END, FLOOR))
    expect(summary).not.toBeNull()
    expect(summary?.viewsInWindow).toBeNull()
    // The owner still learns their publication state — suppressing the count is not suppressing the tile.
    expect(summary?.directoryPublished).toBe(false)
  })

  it('counts only views inside the window', async () => {
    const summary = await db.transaction((tx) =>
      getVerifiedProfileOwnerSummary(tx, 'owner-verified', new Date('2028-01-01T00:00:00Z'), new Date('2028-02-01T00:00:00Z'), FLOOR))
    expect(summary?.viewsInWindow).toBeNull()
  })

  /**
   * Directory publication and portfolio publication are independent rows in different places — a
   * `published_builder_profiles` row and a flag inside `builder_claims.metadata`. Reporting one for
   * the other would be wrong for every owner who has exactly one of them, which is both fixtures here.
   */
  it('reports the two publication states from their two separate sources', async () => {
    const [directoryOnly, portfolioOnly] = await Promise.all([
      db.transaction((tx) => getVerifiedProfileOwnerSummary(tx, 'owner-verified', WINDOW_START, WINDOW_END, FLOOR)),
      db.transaction((tx) => getVerifiedProfileOwnerSummary(tx, 'owner-published', WINDOW_START, WINDOW_END, FLOOR)),
    ])

    expect(directoryOnly).toMatchObject({ directoryPublished: true, portfolioPublished: false })
    expect(portfolioOnly).toMatchObject({ directoryPublished: false, portfolioPublished: true })
  })
})
