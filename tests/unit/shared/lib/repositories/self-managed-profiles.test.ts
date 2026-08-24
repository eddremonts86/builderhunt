/**
 * The self-managed profile repository (plan: phase-2/07-perfiles-autogestionados, task 2).
 *
 * ## What these can and cannot prove
 *
 * They connect as the database superuser, so they say nothing about RLS. Every claim about one
 * person being unable to reach another's row is proved by `scripts/db/verify-rls-local.mjs` against
 * the real `builderhunt_app` role, and by the five-case negative test recorded on task 1.
 *
 * What is worth testing here is the layer above that: the repository's own `WHERE` clauses, the two
 * partial unique indexes, and the thirty-day handle hold. Those are application rules, they hold for
 * a superuser exactly as they hold for anyone, and getting them wrong is how a handle gets handed to
 * a stranger while the policies are all correct.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { TenantTransaction } from '~/shared/lib/db/client'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, selfManagedHandleReservations, selfManagedProfiles } from '~/shared/lib/db/schema'
import { HANDLE_RELEASE_AFTER_DELETE_MS, HANDLE_RESERVATION_TTL_MS } from '~/shared/lib/self-managed/contracts'
import {
  SelfManagedProfileError,
  createProfile,
  getOwnProfile,
  getPublicProfileByHandle,
  isHandleAvailable,
  purgeDeletedProfiles,
  releaseExpiredHandleReservations,
  reserveHandle,
  setVisibility,
  softDeleteProfile,
  updateProfile,
} from '~/shared/lib/repositories/self-managed-profiles'

let db: PostgresJsDatabase
let drop: () => Promise<void>
const tx = () => db as unknown as TenantTransaction

const NOW = new Date('2027-03-01T10:00:00Z')

/** The minimum a profile needs, so each test names only what it is actually about. */
function profile(overrides: Partial<Parameters<typeof createProfile>[1]['profile']> = {}) {
  return {
    handle: 'ada',
    displayName: 'Ada',
    languages: [],
    services: [],
    topics: [],
    visibility: 'draft' as const,
    ...overrides,
  }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('repo_self_managed')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values(
    ['owner-a', 'owner-b'].map((id) => ({
      id,
      name: id,
      email: `${id}@test.invalid`,
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  )
}, 120_000)

afterAll(async () => {
  await drop?.()
})

beforeEach(async () => {
  await db.delete(selfManagedProfiles)
  await db.delete(selfManagedHandleReservations)
})

describe('createProfile', () => {
  it('stores what the owner sent and resolves the owner from the argument, not the body', async () => {
    const created = await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })

    expect(created.ownerUserId).toBe('owner-a')
    expect(created.handle).toBe('ada')
    expect(created.visibility).toBe('draft')
    expect(await getOwnProfile(tx(), 'owner-a')).toMatchObject({ id: created.id, handle: 'ada' })
  })

  it('refuses a second profile for the same person, by name rather than by constraint violation', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })

    await expect(
      createProfile(tx(), { ownerUserId: 'owner-a', profile: profile({ handle: 'ada-two' }), now: NOW }),
    ).rejects.toMatchObject({ code: 'already-exists' })
  })

  it('refuses a handle another live profile already holds', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })

    await expect(
      createProfile(tx(), { ownerUserId: 'owner-b', profile: profile(), now: NOW }),
    ).rejects.toBeInstanceOf(SelfManagedProfileError)
  })

  it('clears the reservation the handle no longer needs', async () => {
    await reserveHandle(tx(), { handle: 'ada', userId: 'owner-a', now: NOW })
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })

    expect(await db.select().from(selfManagedHandleReservations)).toHaveLength(0)
  })
})

describe('updateProfile', () => {
  it('replaces the whole profile, so a cleared field is actually cleared', async () => {
    await createProfile(tx(), {
      ownerUserId: 'owner-a',
      profile: profile({ headline: 'Translator', bio: 'Long bio' }),
      now: NOW,
    })

    const updated = await updateProfile(tx(), {
      ownerUserId: 'owner-a',
      profile: profile({ headline: null }),
      now: new Date(NOW.getTime() + 1000),
    })

    expect(updated.headline).toBeNull()
    expect(updated.bio).toBeNull()
  })

  it('lets the owner keep their own handle — a no-op rename is not a conflict', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })

    const updated = await updateProfile(tx(), {
      ownerUserId: 'owner-a',
      profile: profile({ displayName: 'Ada L.' }),
      now: NOW,
    })

    expect(updated.handle).toBe('ada')
    expect(updated.displayName).toBe('Ada L.')
  })

  it('refuses a rename onto a handle somebody else holds', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })
    await createProfile(tx(), { ownerUserId: 'owner-b', profile: profile({ handle: 'grace' }), now: NOW })

    await expect(
      updateProfile(tx(), { ownerUserId: 'owner-b', profile: profile({ handle: 'ada' }), now: NOW }),
    ).rejects.toMatchObject({ code: 'handle-taken' })
  })

  it('refuses to update a profile that does not exist', async () => {
    await expect(
      updateProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW }),
    ).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('setVisibility', () => {
  /**
   * All three transitions are legal today, so this asserts they work rather than pretending some are
   * forbidden. `isAllowedVisibilityTransition` exists so that when one stops being legal there is a
   * single place to say so; the test below proves the guard is wired to it, not decoration.
   */
  it('moves freely between the three states the product allows', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })

    expect((await setVisibility(tx(), { ownerUserId: 'owner-a', visibility: 'public', now: NOW })).visibility)
      .toBe('public')
    expect((await setVisibility(tx(), { ownerUserId: 'owner-a', visibility: 'unlisted', now: NOW })).visibility)
      .toBe('unlisted')
    expect((await setVisibility(tx(), { ownerUserId: 'owner-a', visibility: 'draft', now: NOW })).visibility)
      .toBe('draft')
  })

  it('refuses a state that is not one of the three', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })

    await expect(
      // Deliberately outside the union: the guard is what stands between a stray string arriving
      // from an older client and a row whose visibility nothing in the codebase understands.
      setVisibility(tx(), { ownerUserId: 'owner-a', visibility: 'archived' as never, now: NOW }),
    ).rejects.toMatchObject({ code: 'invalid-transition' })
  })
})

describe('getPublicProfileByHandle', () => {
  it('serves public and unlisted, and withholds draft', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile({ visibility: 'draft' }), now: NOW })
    expect(await getPublicProfileByHandle(tx(), 'ada')).toBeNull()

    await setVisibility(tx(), { ownerUserId: 'owner-a', visibility: 'unlisted', now: NOW })
    expect(await getPublicProfileByHandle(tx(), 'ada')).toMatchObject({ handle: 'ada', verified: false })

    await setVisibility(tx(), { ownerUserId: 'owner-a', visibility: 'public', now: NOW })
    expect(await getPublicProfileByHandle(tx(), 'ada')).toMatchObject({ handle: 'ada' })
  })

  it('is a projection, so a column added later cannot leak through it', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile({ visibility: 'public' }), now: NOW })
    const seen = await getPublicProfileByHandle(tx(), 'ada')

    expect(Object.keys(seen ?? {}).sort()).toEqual([
      'bio', 'displayName', 'handle', 'headline', 'languages',
      'locationCity', 'locationCountryCode', 'services', 'topics', 'updatedAt', 'verified',
    ])
  })

  it('disappears the moment the profile is soft-deleted', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile({ visibility: 'public' }), now: NOW })
    await softDeleteProfile(tx(), { ownerUserId: 'owner-a', now: NOW })

    expect(await getPublicProfileByHandle(tx(), 'ada')).toBeNull()
    expect(await getOwnProfile(tx(), 'owner-a')).toBeNull()
  })
})

describe('isHandleAvailable', () => {
  it('holds a deleted profile’s handle for thirty days and releases it after', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })
    await softDeleteProfile(tx(), { ownerUserId: 'owner-a', now: NOW })

    const dayBefore = new Date(NOW.getTime() + HANDLE_RELEASE_AFTER_DELETE_MS - 1000)
    const dayAfter = new Date(NOW.getTime() + HANDLE_RELEASE_AFTER_DELETE_MS + 1000)

    expect(await isHandleAvailable(tx(), { handle: 'ada', forUserId: 'owner-b', now: dayBefore })).toBe(false)
    expect(await isHandleAvailable(tx(), { handle: 'ada', forUserId: 'owner-b', now: dayAfter })).toBe(true)
  })

  it('lets the person who deleted it make a second profile immediately', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })
    await softDeleteProfile(tx(), { ownerUserId: 'owner-a', now: NOW })

    // The partial unique indexes exist so this works at all: a plain `unique` would report the
    // handle taken by a row nobody can see.
    const again = await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })
    expect(again.handle).toBe('ada')
  })

  it('blocks a handle somebody else has reserved, and stops once the reservation lapses', async () => {
    await reserveHandle(tx(), { handle: 'grace', userId: 'owner-a', now: NOW })

    expect(await isHandleAvailable(tx(), { handle: 'grace', forUserId: 'owner-b', now: NOW })).toBe(false)
    // Their own reservation is never an obstacle to themselves.
    expect(await isHandleAvailable(tx(), { handle: 'grace', forUserId: 'owner-a', now: NOW })).toBe(true)

    const afterExpiry = new Date(NOW.getTime() + HANDLE_RESERVATION_TTL_MS + 1000)
    expect(await isHandleAvailable(tx(), { handle: 'grace', forUserId: 'owner-b', now: afterExpiry })).toBe(true)
  })
})

describe('reserveHandle', () => {
  it('refuses to take over somebody else’s live reservation', async () => {
    await reserveHandle(tx(), { handle: 'grace', userId: 'owner-a', now: NOW })

    await expect(
      reserveHandle(tx(), { handle: 'grace', userId: 'owner-b', now: NOW }),
    ).rejects.toMatchObject({ code: 'handle-taken' })
  })

  it('lets a lapsed reservation be taken by the next person', async () => {
    await reserveHandle(tx(), { handle: 'grace', userId: 'owner-a', now: NOW })
    const afterExpiry = new Date(NOW.getTime() + HANDLE_RESERVATION_TTL_MS + 1000)

    const taken = await reserveHandle(tx(), { handle: 'grace', userId: 'owner-b', now: afterExpiry })
    expect(taken.handle).toBe('grace')

    const [row] = await db.select().from(selfManagedHandleReservations)
    expect(row?.reservedByUserId).toBe('owner-b')
  })

  it('refreshes the caller’s own reservation rather than failing on it', async () => {
    const first = await reserveHandle(tx(), { handle: 'grace', userId: 'owner-a', now: NOW })
    const later = new Date(NOW.getTime() + 60_000)
    const second = await reserveHandle(tx(), { handle: 'grace', userId: 'owner-a', now: later })

    expect(second.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime())
  })
})

describe('the bounded sweeps', () => {
  it('releases only lapsed reservations, and only as many as asked for', async () => {
    for (const handle of ['a-one', 'a-two', 'a-three']) {
      await reserveHandle(tx(), { handle, userId: 'owner-a', now: NOW })
    }
    await reserveHandle(tx(), { handle: 'still-live', userId: 'owner-b', now: NOW })

    // Far enough past that the three lapse and `still-live` is refreshed to sit beyond the sweep.
    const later = new Date(NOW.getTime() + HANDLE_RESERVATION_TTL_MS + 1000)
    await reserveHandle(tx(), { handle: 'still-live', userId: 'owner-b', now: later })

    expect(await releaseExpiredHandleReservations(tx(), { now: later, limit: 2 })).toBe(2)
    expect(await releaseExpiredHandleReservations(tx(), { now: later, limit: 2 })).toBe(1)
    expect(await releaseExpiredHandleReservations(tx(), { now: later, limit: 2 })).toBe(0)

    const left = await db.select().from(selfManagedHandleReservations)
    expect(left.map((row) => row.handle)).toEqual(['still-live'])
  })

  it('purges a profile only once its handle hold has run out', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })
    await softDeleteProfile(tx(), { ownerUserId: 'owner-a', now: NOW })

    const tooSoon = new Date(NOW.getTime() + HANDLE_RELEASE_AFTER_DELETE_MS - 1000)
    expect(await purgeDeletedProfiles(tx(), { now: tooSoon })).toBe(0)

    const ripe = new Date(NOW.getTime() + HANDLE_RELEASE_AFTER_DELETE_MS + 1000)
    expect(await purgeDeletedProfiles(tx(), { now: ripe })).toBe(1)
    expect(await db.select().from(selfManagedProfiles)).toHaveLength(0)
  })

  it('never purges a live profile', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })

    const farFuture = new Date(NOW.getTime() + HANDLE_RELEASE_AFTER_DELETE_MS * 10)
    expect(await purgeDeletedProfiles(tx(), { now: farFuture })).toBe(0)
    expect(await getOwnProfile(tx(), 'owner-a')).not.toBeNull()
  })
})

describe('one person’s writes never reach another’s row', () => {
  /**
   * The repository's own scoping, not RLS. Both are needed: the policy is the guarantee, and this is
   * what stops a query from being written in a way the policy then has to catch.
   */
  it('leaves B’s profile untouched when A updates, deletes and re-reads', async () => {
    await createProfile(tx(), { ownerUserId: 'owner-a', profile: profile(), now: NOW })
    await createProfile(tx(), { ownerUserId: 'owner-b', profile: profile({ handle: 'grace' }), now: NOW })

    await updateProfile(tx(), { ownerUserId: 'owner-a', profile: profile({ displayName: 'Changed' }), now: NOW })
    await softDeleteProfile(tx(), { ownerUserId: 'owner-a', now: NOW })

    // Still live, still theirs, still saying what they wrote — `getOwnProfile` returns null for a
    // soft-deleted row, so a non-null answer here is itself the assertion that A's delete missed it.
    expect(await getOwnProfile(tx(), 'owner-b')).toMatchObject({ handle: 'grace', displayName: 'Ada' })
  })
})
