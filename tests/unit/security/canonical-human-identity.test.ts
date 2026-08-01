/**
 * plans/phase-1/43-solutions-intelligence Phase 3, "Add canonical human and source-link schema".
 * Verify line: "migration/integrity/RLS tests cover duplicate links, conflicting facts, tenant
 * access, public DTO boundaries, and forward rollback."
 *
 * These are database-level guarantees, asserted against a real migrated database rather than
 * through a repository, because the property that matters is that *no code path at all* can
 * violate them — including one written next year that inserts directly. Plan 43 Phase 2 had to
 * remove a username-equality merge from `dedup.ts` that silently fused unrelated people; the
 * constraints here are what stop an equivalent mistake from being expressible in this schema.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { builderIdentities, canonicalHumans, humanMergeEvents, humanSourceLinks } from '~/shared/lib/db/schema'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('canonical_humans')
  db = disposable.db
  drop = disposable.drop
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(humanMergeEvents)
  await db.delete(humanSourceLinks)
  await db.delete(canonicalHumans)
  await db.delete(builderIdentities)

  // Two accounts sharing the handle "alice" on different platforms — the exact shape that used to
  // be collapsed into one builder.
  await db.insert(builderIdentities).values([
    { id: 'identity-github-alice', source: 'github', sourceId: 'gh-alice', username: 'alice', profileUrl: 'https://github.com/alice' },
    { id: 'identity-hn-alice', source: 'hn', sourceId: 'hn-alice', username: 'alice', profileUrl: 'https://news.ycombinator.com/user?id=alice' },
  ])
  await db.insert(canonicalHumans).values([
    { id: 'human-1', displayName: 'Alice One' },
    { id: 'human-2', displayName: 'Alice Two' },
  ])
})

/**
 * Asserts the write was refused by a specific named constraint.
 *
 * Drizzle wraps the driver error in a `Failed query: ...` message and hangs the real one off
 * `cause`, so matching the top-level message would pass for *any* rejection — including a typo in
 * the fixture. Walking the chain for `constraint_name` is what makes these tests prove that the
 * intended rule fired rather than merely that something went wrong.
 */
async function expectConstraintViolation(write: Promise<unknown>, constraint: string): Promise<void> {
  let thrown: unknown
  try {
    await write
  } catch (error) {
    thrown = error
  }
  expect(thrown, `expected ${constraint} to reject this write, but it succeeded`).toBeDefined()

  const names: string[] = []
  for (let error = thrown; error instanceof Error; error = (error as { cause?: unknown }).cause) {
    const candidate = (error as { constraint_name?: unknown }).constraint_name
    if (typeof candidate === 'string') names.push(candidate)
    names.push(error.message)
  }
  expect(names.join('\n')).toContain(constraint)
}

function link(overrides: Partial<typeof humanSourceLinks.$inferInsert> = {}) {
  return {
    id: 'link-1',
    canonicalHumanId: 'human-1',
    builderIdentityId: 'identity-github-alice',
    linkMethod: 'verified_claim',
    reviewState: 'auto_approved',
    confidenceBps: 10000,
    ...overrides,
  }
}

describe('a similarity guess can never become an identity assertion', () => {
  it('rejects a probabilistic link that tries to auto-approve itself', async () => {
    // The whole "two people called alice are one person" class of bug, made unrepresentable.
    await expectConstraintViolation(db.insert(humanSourceLinks).values(link({
      linkMethod: 'probabilistic_candidate',
      reviewState: 'auto_approved',
      confidenceBps: 9900,
    })), 'human_source_links_probabilistic_needs_review_check')
  })

  it('accepts the same probabilistic link as a pending review', async () => {
    // Proposing is fine — that is the review queue's whole purpose. Only activating is forbidden.
    await db.insert(humanSourceLinks).values(link({
      linkMethod: 'probabilistic_candidate',
      reviewState: 'pending_review',
      confidenceBps: 9900,
    }))
    const [row] = await db.select().from(humanSourceLinks)
    expect(row.reviewState).toBe('pending_review')
  })

  it('lets a human approve a proposed link, which is the only route to activation', async () => {
    await db.insert(humanSourceLinks).values(link({ linkMethod: 'probabilistic_candidate', reviewState: 'pending_review' }))
    await db.update(humanSourceLinks).set({ reviewState: 'approved', reviewedAt: new Date() })
    const [row] = await db.select().from(humanSourceLinks)
    expect(row.reviewState).toBe('approved')
  })

  it.each(['verified_claim', 'explicit_cross_link', 'reviewed_deterministic'] as const)(
    'allows %s to auto-approve, because each rests on evidence rather than resemblance',
    async (linkMethod) => {
      await db.insert(humanSourceLinks).values(link({ linkMethod, reviewState: 'auto_approved' }))
      const [row] = await db.select().from(humanSourceLinks)
      expect(row.linkMethod).toBe(linkMethod)
    },
  )

  it('rejects an unknown link method rather than storing it', async () => {
    await expectConstraintViolation(db.insert(humanSourceLinks).values(link({ linkMethod: 'vibes' })), 'human_source_links_method_check')
  })
})

describe('one account belongs to one person at a time', () => {
  it('refuses to actively link the same account to a second human', async () => {
    await db.insert(humanSourceLinks).values(link({ id: 'link-1', canonicalHumanId: 'human-1' }))
    // Without this, an account could be simultaneously "owned" by two people and every projection
    // built from it would depend on which row a query happened to read first.
    await expectConstraintViolation(db.insert(humanSourceLinks).values(link({ id: 'link-2', canonicalHumanId: 'human-2' })), 'human_source_links_active_identity_unique')
  })

  it('allows a re-link once the previous one is withdrawn', async () => {
    await db.insert(humanSourceLinks).values(link({ id: 'link-1', canonicalHumanId: 'human-1' }))
    await db.update(humanSourceLinks).set({ validUntil: new Date() })

    // This is what makes an unmerge reversible: the constraint is partial, so history does not
    // permanently poison the account.
    await db.insert(humanSourceLinks).values(link({ id: 'link-2', canonicalHumanId: 'human-2' }))
    const active = await db.select().from(humanSourceLinks).where(sql`valid_until is null`)
    expect(active).toHaveLength(1)
    expect(active[0].canonicalHumanId).toBe('human-2')
  })

  it('does not let a rejected link block a correct one', async () => {
    await db.insert(humanSourceLinks).values(link({ id: 'link-1', canonicalHumanId: 'human-1', linkMethod: 'probabilistic_candidate', reviewState: 'rejected' }))
    await db.insert(humanSourceLinks).values(link({ id: 'link-2', canonicalHumanId: 'human-2' }))
    expect(await db.select().from(humanSourceLinks)).toHaveLength(2)
  })

  it('keeps a pending proposal from reserving the account', async () => {
    // A queued guess must not pre-empt a verified claim that arrives while it waits for review.
    await db.insert(humanSourceLinks).values(link({ id: 'link-1', canonicalHumanId: 'human-2', linkMethod: 'probabilistic_candidate', reviewState: 'pending_review' }))
    await db.insert(humanSourceLinks).values(link({ id: 'link-2', canonicalHumanId: 'human-1', linkMethod: 'verified_claim', reviewState: 'auto_approved' }))
    expect(await db.select().from(humanSourceLinks)).toHaveLength(2)
  })

  it('stores at most one link row per (human, account) pair', async () => {
    await db.insert(humanSourceLinks).values(link({ id: 'link-1' }))
    // A re-link must revalidate the existing row, not stack duplicates that then disagree about
    // review state.
    await expectConstraintViolation(db.insert(humanSourceLinks).values(link({ id: 'link-2' })), 'human_source_links_human_identity_unique')
  })

  it('lets one person hold several accounts, which is the entire point', async () => {
    await db.insert(humanSourceLinks).values([
      link({ id: 'link-1', builderIdentityId: 'identity-github-alice' }),
      link({ id: 'link-2', builderIdentityId: 'identity-hn-alice' }),
    ])
    const rows = await db.select().from(humanSourceLinks)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.canonicalHumanId))).toEqual(new Set(['human-1']))
  })
})

describe('field and validity integrity', () => {
  it('rejects a confidence outside 0-10000 bps', async () => {
    await expectConstraintViolation(db.insert(humanSourceLinks).values(link({ confidenceBps: 10001 })), 'human_source_links_confidence_range_check')
    await expectConstraintViolation(db.insert(humanSourceLinks).values(link({ confidenceBps: -1 })), 'human_source_links_confidence_range_check')
  })

  it('rejects a validity window that ends before it starts', async () => {
    await expectConstraintViolation(db.insert(humanSourceLinks).values(link({
      validFrom: new Date('2026-08-01T00:00:00Z'),
      validUntil: new Date('2026-07-01T00:00:00Z'),
    })), 'human_source_links_validity_order_check')
  })

  it('defaults field provenance to an empty object rather than null', async () => {
    // Downstream code reads `fieldProvenance[field]`; a null column would make every read a
    // null-check, and one missed check is a crash on a page that renders a person.
    const [row] = await db.select().from(canonicalHumans).where(sql`id = 'human-1'`)
    expect(row.fieldProvenance).toEqual({})
  })
})

describe('merge lineage survives what it describes', () => {
  it('keeps the lineage row after the absorbed human is deleted', async () => {
    await db.insert(humanMergeEvents).values({
      targetCanonicalHumanId: 'human-1',
      sourceCanonicalHumanId: 'human-2',
      reason: 'Same person, verified on both platforms',
      restoreSnapshot: { displayName: 'Alice Two', movedLinkIds: ['link-1'] },
    })

    // `source_canonical_human_id` is deliberately not a foreign key: a merge normally ends with the
    // absorbed row gone, and if that took the audit trail with it the merge would stop being
    // reversible at exactly the moment someone needed to reverse it.
    await db.delete(canonicalHumans).where(sql`id = 'human-2'`)

    const [event] = await db.select().from(humanMergeEvents)
    expect(event.sourceCanonicalHumanId).toBe('human-2')
    expect(event.restoreSnapshot).toMatchObject({ displayName: 'Alice Two' })
    expect(event.revertedAt).toBeNull()
  })

  it('cascades away with the surviving human, since the lineage then has no subject', async () => {
    await db.insert(humanMergeEvents).values({
      targetCanonicalHumanId: 'human-1',
      sourceCanonicalHumanId: 'human-2',
      reason: 'test',
      restoreSnapshot: {},
    })
    await db.delete(canonicalHumans).where(sql`id = 'human-1'`)
    expect(await db.select().from(humanMergeEvents)).toHaveLength(0)
  })
})

describe('public DTO boundary', () => {
  it('carries no organization column, so no tenant data can be stored here', async () => {
    // Canonical humans are global-public (audit-schema.ts classifies them alongside
    // `builder_identities`). A tenant's private opinion about a person belongs in
    // `organization_builders.private_metadata`; if either table grew an organization column, that
    // separation would quietly collapse.
    for (const table of ['canonical_humans', 'human_source_links']) {
      const columns = await db.execute<{ column_name: string }>(sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = ${table}
      `)
      const names = [...columns].map((c) => c.column_name)
      expect(names).not.toContain('organization_id')
    }
  })
})
