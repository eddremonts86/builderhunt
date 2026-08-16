import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, userPreferences } from '~/shared/lib/db/schema'
import type { TenantTransaction } from '~/shared/lib/db/client'
import {
  countUsersBySegment,
  emptyUserPreferences,
  getUserPreferences,
  setPrimarySegment,
} from '~/shared/lib/repositories/user-preferences'

/**
 * ## What this file can and cannot prove
 *
 * It connects as a superuser, so **row-level security is not in force here**. Nothing below is
 * evidence that user A cannot read user B — that was proven separately against the real
 * `builderhunt_app` role (see the header of `drizzle/0171_user_preferences.sql`), where reading B's
 * row returns nothing, updating it reports zero rows, and inserting a row for somebody else is
 * refused by the policy.
 *
 * What these tests do cover is the behaviour the repository owes its callers regardless of the role:
 * absence as a value, idempotence, narrowing of anything a column happens to hold, and a
 * distribution that still adds up when the taxonomy has moved on.
 */

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('user_preferences')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values([
    { id: 'user-a', name: 'A', email: 'a@example.test', emailVerified: true },
    { id: 'user-b', name: 'B', email: 'b@example.test', emailVerified: true },
  ])
}, 60_000)

afterAll(async () => {
  await drop?.()
})

beforeEach(async () => {
  await db.delete(userPreferences)
})

/** The repository takes a `TenantTransaction`; the disposable client is shape-compatible here. */
const tx = () => db as unknown as TenantTransaction

describe('reading somebody who has never answered', () => {
  it('returns a record with a null segment rather than no record', async () => {
    const preferences = await getUserPreferences(tx(), 'user-a')

    expect(preferences).toEqual(emptyUserPreferences('user-a'))
    expect(preferences.primarySegment).toBeNull()
    expect(preferences.userId).toBe('user-a')
  })

  /**
   * One shape for callers instead of two. Every consumer in phase-2 has to handle `null` anyway —
   * returning `null` for the whole record would make them each handle it twice.
   */
  it('does not write a row as a side effect of being read', async () => {
    await getUserPreferences(tx(), 'user-a')
    expect(await db.select().from(userPreferences)).toHaveLength(0)
  })
})

describe('setting a segment', () => {
  it('creates, then updates in place rather than failing on the second write', async () => {
    const first = await setPrimarySegment(tx(), {
      subjectUserId: 'user-a', segment: 'hiring', source: 'onboarding',
    })
    expect(first.primarySegment).toBe('hiring')
    expect(first.segmentSource).toBe('onboarding')
    expect(first.segmentSchemaVersion).toBe(1)

    const second = await setPrimarySegment(tx(), {
      subjectUserId: 'user-a', segment: 'investing', source: 'settings',
    })
    expect(second.primarySegment).toBe('investing')
    expect(second.segmentSource).toBe('settings')

    // One row, not two: the upsert targets the primary key.
    expect(await db.select().from(userPreferences)).toHaveLength(1)
  })

  /**
   * Re-affirming the same value is a real event that the analytics distinguish from a change, so
   * the timestamp has to move even when the value does not.
   */
  it('moves segment_selected_at even when the value is unchanged', async () => {
    const earlier = new Date('2026-01-01T00:00:00.000Z')
    const later = new Date('2026-02-01T00:00:00.000Z')

    await setPrimarySegment(tx(), { subjectUserId: 'user-a', segment: 'hiring', source: 'onboarding', now: earlier })
    const again = await setPrimarySegment(tx(), { subjectUserId: 'user-a', segment: 'hiring', source: 'settings', now: later })

    expect(again.segmentSelectedAt?.toISOString()).toBe(later.toISOString())
  })

  /** Clearing returns somebody to the general preset without deleting their row or their history. */
  it('accepts null, and drops the schema version with it', async () => {
    await setPrimarySegment(tx(), { subjectUserId: 'user-a', segment: 'hiring', source: 'onboarding' })
    const cleared = await setPrimarySegment(tx(), { subjectUserId: 'user-a', segment: null, source: 'settings' })

    expect(cleared.primarySegment).toBeNull()
    // A version describes a value; with no value there is nothing to describe.
    expect(cleared.segmentSchemaVersion).toBeNull()
    expect(await db.select().from(userPreferences)).toHaveLength(1)
  })

  it('keeps two people independent', async () => {
    await setPrimarySegment(tx(), { subjectUserId: 'user-a', segment: 'hiring', source: 'settings' })
    await setPrimarySegment(tx(), { subjectUserId: 'user-b', segment: 'building', source: 'settings' })

    expect((await getUserPreferences(tx(), 'user-a')).primarySegment).toBe('hiring')
    expect((await getUserPreferences(tx(), 'user-b')).primarySegment).toBe('building')
  })
})

describe('narrowing what a column actually holds', () => {
  /**
   * A value written under an older taxonomy, or edited by hand, must not crash a page. The segment
   * grants nothing, so degrading to the general preset is the proportionate failure.
   */
  it('reads an unknown segment as null instead of throwing', async () => {
    await db.insert(userPreferences).values({
      userId: 'user-a', primarySegment: 'recruiter', segmentSource: 'settings', segmentSchemaVersion: 0,
    })

    const preferences = await getUserPreferences(tx(), 'user-a')
    expect(preferences.primarySegment).toBeNull()
    // The version is kept verbatim: it is the evidence of which taxonomy wrote the value.
    expect(preferences.segmentSchemaVersion).toBe(0)
  })

  it('reads an unknown source as null', async () => {
    await db.insert(userPreferences).values({ userId: 'user-a', primarySegment: 'hiring', segmentSource: 'api' })
    expect((await getUserPreferences(tx(), 'user-a')).segmentSource).toBeNull()
  })
})

describe('the internal distribution', () => {
  it('counts every account, including those with no segment and those with a retired one', async () => {
    await db.insert(userPreferences).values([
      { userId: 'user-a', primarySegment: 'hiring' },
      { userId: 'user-b', primarySegment: 'recruiter' },
    ])

    const counts = await countUsersBySegment(db as unknown as TenantTransaction)

    expect(counts.hiring).toBe(1)
    // Folded into `unknown` rather than dropped: a distribution that silently fails to add up to the
    // number of accounts is worse than one that admits it does not recognise a value.
    expect(counts.unknown).toBe(1)
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(2)
  })
})
