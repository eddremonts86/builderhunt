/**
 * plans/implemented/43-solutions-intelligence Phase 3, "Dual-read/write organization tracking".
 * Verify line: "tracked notes/status remain tenant-private and intact through backfill, cutover, and
 * rollback."
 *
 * `organization_builders` is tenant-private and holds an organization's own notes, status,
 * visibility and private metadata. `canonical_humans` is global-public and a platform action can
 * delete or unmerge one. The cutover therefore has exactly one hard requirement: no global identity
 * decision may ever damage a tenant's private tracking. Everything below exists to pin that.
 */
import { eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, builderIdentities, builderNotes, canonicalHumans, humanSourceLinks, organizationBuilders, organizations } from '~/shared/lib/db/schema'
import {
  backfillCanonicalHumanIds,
  compareCanonicalHumanParity,
  findOrganizationBuilder,
  listOrganizationBuildersByCanonicalHuman,
} from '~/shared/lib/repositories/organization-builders'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'ocp-org'
const OTHER_ORG = 'ocp-other-org'
const USER = 'ocp-user'

/** `TenantTransaction` is the repository's parameter type; a disposable superuser db stands in. */
const tx = () => db as never

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('org_builders_canonical_parity')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values({
    id: USER, name: 'User', email: 'ocp-user@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
  await db.insert(organizations).values([
    { id: ORG, name: 'Org', slug: 'ocp-org' },
    { id: OTHER_ORG, name: 'Other', slug: 'ocp-other-org' },
  ])
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(builderNotes)
  await db.delete(organizationBuilders)
  await db.delete(humanSourceLinks)
  await db.delete(canonicalHumans)
  await db.delete(builderIdentities)
})

async function seedTracked(input: { identityId: string; orgBuilderId: string; organizationId?: string; status?: string; notes?: string[] }) {
  await db.insert(builderIdentities).values({
    id: input.identityId, source: 'github', sourceId: input.identityId, username: input.identityId,
    profileUrl: `https://github.com/${input.identityId}`,
  })
  await db.insert(organizationBuilders).values({
    id: input.orgBuilderId,
    organizationId: input.organizationId ?? ORG,
    builderIdentityId: input.identityId,
    creatorUserId: USER,
    status: input.status ?? 'shortlisted',
    visibility: 'organization',
    privateMetadata: { topics: ['rust'], note: 'internal assessment' },
  })
  for (const [index, content] of (input.notes ?? []).entries()) {
    await db.insert(builderNotes).values({
      id: `${input.orgBuilderId}-note-${index}`,
      organizationId: input.organizationId ?? ORG,
      userId: USER,
      builderId: input.orgBuilderId,
      content,
    })
  }
}

async function linkToHuman(identityId: string, canonicalHumanId: string, reviewState = 'auto_approved') {
  await db.insert(canonicalHumans).values({ id: canonicalHumanId, displayName: canonicalHumanId }).onConflictDoNothing()
  await db.insert(humanSourceLinks).values({
    id: `link-${identityId}-${canonicalHumanId}`,
    canonicalHumanId,
    builderIdentityId: identityId,
    linkMethod: reviewState === 'pending_review' ? 'probabilistic_candidate' : 'verified_claim',
    reviewState,
    confidenceBps: 10_000,
  })
}

describe('parity reporting before cutover', () => {
  it('reports a row the backfill has not reached yet as missingBackfill, not divergent', async () => {
    await seedTracked({ identityId: 'gh-a', orgBuilderId: 'ob-a' })
    await linkToHuman('gh-a', 'human-a')

    const report = await compareCanonicalHumanParity(tx(), ORG)

    expect(report.total).toBe(1)
    expect(report.missingBackfill).toBe(1)
    // Divergent means "the two reads disagree" and must block a cutover. "Not filled in yet" is
    // simply work outstanding, so conflating them would make the gate unusable.
    expect(report.divergent).toEqual([])
  })

  it('counts an account with no canonical human as matching, since both reads agree it has none', async () => {
    await seedTracked({ identityId: 'gh-b', orgBuilderId: 'ob-b' })

    const report = await compareCanonicalHumanParity(tx(), ORG)
    expect(report.matching).toBe(1)
    expect(report.missingBackfill).toBe(0)
  })

  it('does not count a queued proposal as a link', async () => {
    await seedTracked({ identityId: 'gh-c', orgBuilderId: 'ob-c' })
    await linkToHuman('gh-c', 'human-c', 'pending_review')

    const report = await compareCanonicalHumanParity(tx(), ORG)
    // An unreviewed guess must not make a tenant's tracking look like it belongs to a person nobody
    // has confirmed.
    expect(report.matching).toBe(1)
    expect(report.missingBackfill).toBe(0)
  })

  it('flags a stored pointer the link table no longer agrees with', async () => {
    await seedTracked({ identityId: 'gh-d', orgBuilderId: 'ob-d' })
    await linkToHuman('gh-d', 'human-d')
    await backfillCanonicalHumanIds(tx(), ORG)

    // The account is re-linked to a different person, e.g. after a mistaken merge was corrected.
    // Relative to the row's own `valid_from` rather than this process's clock — Postgres's `now()` and the Node
    // clock are not the same clock, and a skew in the wrong direction trips
    // `human_source_links_validity_order_check`.
    await db.update(humanSourceLinks)
      .set({ validUntil: sql`valid_from + interval '1 second'` })
      .where(eq(humanSourceLinks.builderIdentityId, 'gh-d'))
    await linkToHuman('gh-d', 'human-d2')

    const report = await compareCanonicalHumanParity(tx(), ORG)
    expect(report.divergent).toHaveLength(1)
    expect(report.divergent[0]).toMatchObject({ storedCanonicalHumanId: 'human-d', liveCanonicalHumanId: 'human-d2' })
  })

  it('scopes the report to one organization', async () => {
    await seedTracked({ identityId: 'gh-e', orgBuilderId: 'ob-e', organizationId: ORG })
    await seedTracked({ identityId: 'gh-f', orgBuilderId: 'ob-f', organizationId: OTHER_ORG })

    expect((await compareCanonicalHumanParity(tx(), ORG)).total).toBe(1)
    expect((await compareCanonicalHumanParity(tx(), OTHER_ORG)).total).toBe(1)
  })
})

describe('the backfill touches nothing but the pointer', () => {
  it('fills the pointer and reaches parity', async () => {
    await seedTracked({ identityId: 'gh-g', orgBuilderId: 'ob-g' })
    await linkToHuman('gh-g', 'human-g')

    expect((await backfillCanonicalHumanIds(tx(), ORG)).updated).toBe(1)

    const report = await compareCanonicalHumanParity(tx(), ORG)
    expect(report.matching).toBe(1)
    expect(report.missingBackfill).toBe(0)
    expect(report.divergent).toEqual([])
  })

  it('leaves notes, status, visibility and private metadata exactly as they were', async () => {
    await seedTracked({ identityId: 'gh-h', orgBuilderId: 'ob-h', status: 'shortlisted', notes: ['Strong on systems', 'Follow up in Q4'] })
    await linkToHuman('gh-h', 'human-h')

    const before = await db.select().from(organizationBuilders).where(eq(organizationBuilders.id, 'ob-h'))
    await backfillCanonicalHumanIds(tx(), ORG)
    const after = await db.select().from(organizationBuilders).where(eq(organizationBuilders.id, 'ob-h'))

    // The whole point: a global identity backfill is invisible to the tenant's own decisions.
    expect(after[0].status).toBe(before[0].status)
    expect(after[0].visibility).toBe(before[0].visibility)
    expect(after[0].privateMetadata).toEqual(before[0].privateMetadata)
    expect(after[0].creatorUserId).toBe(before[0].creatorUserId)

    const notes = await db.select().from(builderNotes).where(eq(builderNotes.builderId, 'ob-h'))
    expect(notes.map((n) => n.content).sort()).toEqual(['Follow up in Q4', 'Strong on systems'])
  })

  it('is idempotent — a second run finds nothing to do', async () => {
    await seedTracked({ identityId: 'gh-i', orgBuilderId: 'ob-i' })
    await linkToHuman('gh-i', 'human-i')

    expect((await backfillCanonicalHumanIds(tx(), ORG)).updated).toBe(1)
    // Resume safety: the WHERE clause alone makes an interrupted run continuable by re-running it.
    expect((await backfillCanonicalHumanIds(tx(), ORG)).updated).toBe(0)
  })

  it('does not cross organization boundaries', async () => {
    await seedTracked({ identityId: 'gh-j', orgBuilderId: 'ob-j', organizationId: OTHER_ORG })
    await linkToHuman('gh-j', 'human-j')

    // Backfilling one organization must not write another's rows, even though the identity and the
    // canonical human are global.
    expect((await backfillCanonicalHumanIds(tx(), ORG)).updated).toBe(0)
    const [row] = await db.select().from(organizationBuilders).where(eq(organizationBuilders.id, 'ob-j'))
    expect(row.canonicalHumanId).toBeNull()
  })

  it('skips accounts whose only link is a queued proposal', async () => {
    await seedTracked({ identityId: 'gh-k', orgBuilderId: 'ob-k' })
    await linkToHuman('gh-k', 'human-k', 'pending_review')

    expect((await backfillCanonicalHumanIds(tx(), ORG)).updated).toBe(0)
  })
})

describe('the new read shape', () => {
  it('returns every tracked account belonging to one canonical human', async () => {
    await seedTracked({ identityId: 'gh-l1', orgBuilderId: 'ob-l1' })
    await seedTracked({ identityId: 'gh-l2', orgBuilderId: 'ob-l2' })
    await seedTracked({ identityId: 'gh-l3', orgBuilderId: 'ob-l3' })
    await linkToHuman('gh-l1', 'human-l')
    await linkToHuman('gh-l2', 'human-l')
    await linkToHuman('gh-l3', 'human-other')
    await backfillCanonicalHumanIds(tx(), ORG)

    const rows = await listOrganizationBuildersByCanonicalHuman(tx(), ORG, 'human-l')
    expect(rows.map((r) => r.id).sort()).toEqual(['ob-l1', 'ob-l2'])
  })

  it('returns nothing for another organization\'s canonical human', async () => {
    await seedTracked({ identityId: 'gh-m', orgBuilderId: 'ob-m', organizationId: OTHER_ORG })
    await linkToHuman('gh-m', 'human-m')
    await backfillCanonicalHumanIds(tx(), OTHER_ORG)

    expect(await listOrganizationBuildersByCanonicalHuman(tx(), ORG, 'human-m')).toEqual([])
  })

  it('exposes the pointer on the ordinary read too, so both shapes agree', async () => {
    await seedTracked({ identityId: 'gh-n', orgBuilderId: 'ob-n' })
    await linkToHuman('gh-n', 'human-n')
    await backfillCanonicalHumanIds(tx(), ORG)

    const row = await findOrganizationBuilder(tx(), ORG, 'ob-n')
    expect(row?.canonicalHumanId).toBe('human-n')
  })
})

describe('a global identity decision cannot damage tenant tracking', () => {
  it('survives deletion of the canonical human, keeping notes and status', async () => {
    await seedTracked({ identityId: 'gh-o', orgBuilderId: 'ob-o', status: 'shortlisted', notes: ['Keep me'] })
    await linkToHuman('gh-o', 'human-o')
    await backfillCanonicalHumanIds(tx(), ORG)

    // A platform action deletes the canonical human — an unmerge, a correction, a purge.
    await db.delete(canonicalHumans).where(eq(canonicalHumans.id, 'human-o'))

    const [row] = await db.select().from(organizationBuilders).where(eq(organizationBuilders.id, 'ob-o'))
    // ON DELETE SET NULL, not CASCADE. A cascade here would let a global decision destroy a tenant's
    // private tracking — both data loss and a tenant-isolation violation.
    expect(row).toBeDefined()
    expect(row.canonicalHumanId).toBeNull()
    expect(row.status).toBe('shortlisted')
    expect(row.privateMetadata).toMatchObject({ note: 'internal assessment' })

    const notes = await db.select().from(builderNotes).where(eq(builderNotes.builderId, 'ob-o'))
    expect(notes.map((n) => n.content)).toEqual(['Keep me'])
  })

  it('leaves the row readable by the old key after the pointer is gone, which is the rollback path', async () => {
    await seedTracked({ identityId: 'gh-p', orgBuilderId: 'ob-p', notes: ['Still here'] })
    await linkToHuman('gh-p', 'human-p')
    await backfillCanonicalHumanIds(tx(), ORG)
    await db.delete(canonicalHumans).where(eq(canonicalHumans.id, 'human-p'))

    // Reverting the code to the identity-keyed read must still find everything.
    const row = await findOrganizationBuilder(tx(), ORG, 'ob-p')
    expect(row?.identityId).toBe('gh-p')
    expect(row?.canonicalHumanId).toBeNull()
  })

  it('never lets the canonical pointer widen a tenant read', async () => {
    // Same canonical human tracked by two different organizations — the shared-identity case.
    await seedTracked({ identityId: 'gh-q', orgBuilderId: 'ob-q-mine', organizationId: ORG })
    await seedTracked({ identityId: 'gh-r', orgBuilderId: 'ob-r-theirs', organizationId: OTHER_ORG })
    await linkToHuman('gh-q', 'human-shared')
    await linkToHuman('gh-r', 'human-shared')
    await backfillCanonicalHumanIds(tx(), ORG)
    await backfillCanonicalHumanIds(tx(), OTHER_ORG)

    const mine = await listOrganizationBuildersByCanonicalHuman(tx(), ORG, 'human-shared')
    // Both orgs track the same person; neither may see the other's row through the shared pointer.
    expect(mine.map((r) => r.id)).toEqual(['ob-q-mine'])
  })

  it('keeps the private metadata out of any canonical-human-keyed read of another tenant', async () => {
    await seedTracked({ identityId: 'gh-s', orgBuilderId: 'ob-s', organizationId: OTHER_ORG })
    await linkToHuman('gh-s', 'human-s')
    await backfillCanonicalHumanIds(tx(), OTHER_ORG)

    const leaked = await listOrganizationBuildersByCanonicalHuman(tx(), ORG, 'human-s')
    expect(JSON.stringify(leaked)).not.toContain('internal assessment')
  })
})

describe('the column is additive at the schema level', () => {
  it('is nullable, so every pre-migration row is valid', async () => {
    const rows = await db.execute<{ is_nullable: string }>(sql`
      select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'organization_builders' and column_name = 'canonical_human_id'
    `)
    expect(rows[0].is_nullable).toBe('YES')
  })

  it('deletes to null rather than cascading', async () => {
    const rows = await db.execute<{ delete_rule: string }>(sql`
      select rc.delete_rule
      from information_schema.referential_constraints rc
      join information_schema.key_column_usage kcu on kcu.constraint_name = rc.constraint_name
      where kcu.table_name = 'organization_builders' and kcu.column_name = 'canonical_human_id'
    `)
    // Asserted on the constraint itself, not only on observed behaviour, so a future migration that
    // "tidies up" the FK to CASCADE fails here rather than in production.
    expect(rows[0].delete_rule).toBe('SET NULL')
  })
})
