/**
 * plans/phase-1/43-solutions-intelligence Phase 3, "Persist approved source observations".
 * Verify line: "unchanged observations do not create duplicates; changed, deleted, stale, and
 * restricted sources produce the expected version/projection."
 *
 * `builder_source_snapshots` had a schema, a migration and a `(builder_identity_id, content_hash)`
 * unique index since it was created, and nothing ever inserted into it — the live dev table held 0
 * rows on 2026-08-01. So none of the behaviour that index implies had ever been exercised. These
 * tests are the first thing that does.
 *
 * Suppression is mocked because it reads through a process-local 60s cache backed by
 * `profile_removal` tables; the property under test is that a suppressed identity is refused, not
 * how the suppression list is loaded.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'

const mocks = vi.hoisted(() => ({ isSuppressed: vi.fn() }))
vi.mock('~/shared/lib/profile-suppression', () => ({
  isSuppressed: mocks.isSuppressed,
  filterSuppressed: (items: unknown[]) => Promise.resolve(items),
  invalidateSuppressionCache: () => {},
}))

const { authUsers, builderIdentities, builderProcessingRestrictions, builderSourceSnapshots } = await import('~/shared/lib/db/schema')
const { computeObservationContentHash, listSourceObservations, recordSourceObservation } = await import('~/shared/lib/repositories/source-observations')

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('source_observations')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values({
    id: 'so-actor', name: 'Actor', email: 'so-actor@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(builderSourceSnapshots)
  await db.delete(builderProcessingRestrictions)
  await db.delete(builderIdentities)
  mocks.isSuppressed.mockResolvedValue(false)
})

function observation(overrides: Record<string, unknown> = {}) {
  return {
    source: 'github',
    sourceId: 'gh-42',
    username: 'alice',
    profileUrl: 'https://github.com/alice',
    bio: 'Systems engineer',
    followersCount: 120,
    payload: { bio: 'Systems engineer', topics: ['rust', 'wasm'] },
    ...overrides,
  }
}

async function snapshotCount(): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`select count(*)::int as count from builder_source_snapshots`)
  return rows[0].count
}

describe('recording an observation', () => {
  it('creates the source account and its first snapshot', async () => {
    const result = await recordSourceObservation(observation(), db)

    expect(result).toMatchObject({ status: 'recorded', identityCreated: true })
    expect(await snapshotCount()).toBe(1)

    const [identity] = await db.select().from(builderIdentities)
    expect(identity.source).toBe('github')
    expect(identity.sourceId).toBe('gh-42')
    expect(identity.username).toBe('alice')
  })

  it('attaches the snapshot to the account it describes', async () => {
    const result = await recordSourceObservation(observation(), db)
    if (result.status !== 'recorded') throw new Error('expected recorded')

    const history = await listSourceObservations(result.builderIdentityId, 20, db)
    expect(history).toHaveLength(1)
    expect(history[0].payload).toEqual({ bio: 'Systems engineer', topics: ['rust', 'wasm'] })
    expect(history[0].contentHash).toBe(result.contentHash)
  })
})

describe('unchanged observations do not create duplicates', () => {
  it('returns unchanged and appends nothing on a byte-identical re-observation', async () => {
    await recordSourceObservation(observation(), db)
    const second = await recordSourceObservation(observation(), db)

    // The whole point of the content-hash unique index, exercised for the first time.
    expect(second.status).toBe('unchanged')
    expect(await snapshotCount()).toBe(1)
  })

  it('treats a payload whose keys are ordered differently as unchanged', async () => {
    await recordSourceObservation(observation({ payload: { bio: 'x', topics: ['a'] } }), db)
    const second = await recordSourceObservation(observation({ payload: { topics: ['a'], bio: 'x' } }), db)

    // Canonical hashing: without it, a connector that serialises its payload in a different key
    // order on every run would append a "new" snapshot every single refresh cycle.
    expect(second.status).toBe('unchanged')
    expect(await snapshotCount()).toBe(1)
  })

  it('still advances freshness on an unchanged observation', async () => {
    const first = await recordSourceObservation(observation({ observedAt: new Date('2026-07-01T00:00:00Z') }), db)
    if (first.status !== 'recorded') throw new Error('expected recorded')

    await recordSourceObservation(observation({ observedAt: new Date('2026-08-01T00:00:00Z') }), db)

    const [identity] = await db.select().from(builderIdentities)
    // "Nothing changed" and "we have not looked recently" are different facts; conflating them makes
    // a stable profile look abandoned.
    expect(identity.lastSeenAt.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(identity.firstSeenAt.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(await snapshotCount()).toBe(1)
  })
})

describe('changed observations version', () => {
  it('appends a second snapshot and keeps the first', async () => {
    await recordSourceObservation(observation({ payload: { bio: 'Systems engineer' } }), db)
    const changed = await recordSourceObservation(observation({ payload: { bio: 'Distributed systems engineer' } }), db)

    expect(changed.status).toBe('recorded')
    expect(await snapshotCount()).toBe(2)

    if (changed.status !== 'recorded') throw new Error('expected recorded')
    const history = await listSourceObservations(changed.builderIdentityId, 20, db)
    // History, not overwrite: "what did this source say before" has to remain answerable.
    expect(history).toHaveLength(2)
    expect(history.map((h) => h.contentHash)).toContain(changed.contentHash)
  })

  it('updates the projected account fields to the newest observation', async () => {
    await recordSourceObservation(observation({ followersCount: 120, bio: 'Old' }), db)
    await recordSourceObservation(observation({ followersCount: 900, bio: 'New', payload: { bio: 'New' } }), db)

    const [identity] = await db.select().from(builderIdentities)
    expect(identity.followersCount).toBe(900)
    expect(identity.bio).toBe('New')
  })

  it('does not create a second account for the same (source, sourceId)', async () => {
    await recordSourceObservation(observation(), db)
    await recordSourceObservation(observation({ payload: { changed: true } }), db)
    expect(await db.select().from(builderIdentities)).toHaveLength(1)
  })

  it('keeps two accounts distinct when they publish identical payloads', async () => {
    // The (source, sourceId) pair is part of the hash. Without it, two sparse profiles with the same
    // minimal payload would collide and the second one's snapshot would be dropped as a duplicate.
    const a = await recordSourceObservation(observation({ sourceId: 'gh-1', payload: { topics: [] } }), db)
    const b = await recordSourceObservation(observation({ sourceId: 'gh-2', payload: { topics: [] } }), db)

    expect(a.status).toBe('recorded')
    expect(b.status).toBe('recorded')
    if (a.status !== 'recorded' || b.status !== 'recorded') throw new Error('expected recorded')
    expect(a.contentHash).not.toBe(b.contentHash)
    expect(await snapshotCount()).toBe(2)
  })

  it('hashes the same payload for the same account identically across calls', () => {
    const hash = computeObservationContentHash({ source: 'github', sourceId: 'gh-42', payload: { a: 1, b: [2, 3] } })
    const again = computeObservationContentHash({ source: 'github', sourceId: 'gh-42', payload: { b: [2, 3], a: 1 } })
    expect(hash).toBe(again)
  })
})

describe('deletion and restriction win over ingestion', () => {
  it('writes nothing for a suppressed identity', async () => {
    mocks.isSuppressed.mockResolvedValue(true)

    const result = await recordSourceObservation(observation(), db)

    // The subject asked to be removed. Re-ingesting them would silently undo that.
    expect(result).toEqual({ status: 'skipped', reason: 'suppressed' })
    expect(await db.select().from(builderIdentities)).toHaveLength(0)
    expect(await snapshotCount()).toBe(0)
  })

  it('does not resurrect a suppressed identity that already exists', async () => {
    await recordSourceObservation(observation(), db)
    mocks.isSuppressed.mockResolvedValue(true)

    const result = await recordSourceObservation(observation({ payload: { changed: true } }), db)

    expect(result).toEqual({ status: 'skipped', reason: 'suppressed' })
    expect(await snapshotCount()).toBe(1)
  })

  it('writes nothing for a processing-restricted identity', async () => {
    const first = await recordSourceObservation(observation(), db)
    if (first.status !== 'recorded') throw new Error('expected recorded')
    await db.insert(builderProcessingRestrictions).values({
      builderIdentityId: first.builderIdentityId, reason: 'subject_request', status: 'active', actorUserId: 'so-actor',
    })

    const result = await recordSourceObservation(observation({ payload: { changed: true } }), db)

    expect(result).toEqual({ status: 'skipped', reason: 'processing_restricted' })
    expect(await snapshotCount()).toBe(1)
  })

  it('does not advance freshness for a restricted identity', async () => {
    const first = await recordSourceObservation(observation({ observedAt: new Date('2026-07-01T00:00:00Z') }), db)
    if (first.status !== 'recorded') throw new Error('expected recorded')
    await db.insert(builderProcessingRestrictions).values({
      builderIdentityId: first.builderIdentityId, reason: 'legal', status: 'active', actorUserId: 'so-actor',
    })

    await recordSourceObservation(observation({ observedAt: new Date('2026-08-01T00:00:00Z') }), db)

    const [identity] = await db.select().from(builderIdentities)
    // A last_seen_at bump is itself processing, so a restriction has to block it too — not just the
    // snapshot append.
    expect(identity.lastSeenAt.toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })

  it('resumes ingestion once the restriction is withdrawn', async () => {
    const first = await recordSourceObservation(observation(), db)
    if (first.status !== 'recorded') throw new Error('expected recorded')
    await db.insert(builderProcessingRestrictions).values({
      builderIdentityId: first.builderIdentityId, reason: 'subject_request', status: 'active', actorUserId: 'so-actor',
    })
    await recordSourceObservation(observation({ payload: { changed: true } }), db)
    expect(await snapshotCount()).toBe(1)

    await db.update(builderProcessingRestrictions).set({ status: 'withdrawn', withdrawnAt: new Date() })
    const resumed = await recordSourceObservation(observation({ payload: { changed: true } }), db)

    // A withdrawn restriction is not a permanent ban; the effective boolean has to be re-read, not
    // cached from the first refusal.
    expect(resumed.status).toBe('recorded')
    expect(await snapshotCount()).toBe(2)
  })
})

describe('history is bounded and ordered', () => {
  it('returns newest first and honours the limit', async () => {
    const first = await recordSourceObservation(observation({ payload: { v: 1 }, observedAt: new Date('2026-06-01T00:00:00Z') }), db)
    if (first.status !== 'recorded') throw new Error('expected recorded')
    await recordSourceObservation(observation({ payload: { v: 2 }, observedAt: new Date('2026-07-01T00:00:00Z') }), db)
    await recordSourceObservation(observation({ payload: { v: 3 }, observedAt: new Date('2026-08-01T00:00:00Z') }), db)

    const all = await listSourceObservations(first.builderIdentityId, 20, db)
    expect(all.map((h) => h.payload)).toEqual([{ v: 3 }, { v: 2 }, { v: 1 }])

    // Read on request paths; an account observed for years has unbounded snapshots.
    const bounded = await listSourceObservations(first.builderIdentityId, 2, db)
    expect(bounded).toHaveLength(2)
    expect(bounded[0].payload).toEqual({ v: 3 })
  })
})
