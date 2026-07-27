import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations } from '~/shared/lib/db/schema'
import {
  MAX_AVAILABILITY_HORIZON_DAYS,
  normalizeAvailabilityRules,
  type AvailabilityOverrideInput,
  type AvailabilityRuleInput,
} from '~/shared/lib/scheduling'
import {
  addOwnAvailabilityOverride,
  deleteOwnAvailabilityOverride,
  getOwnAvailability,
  putOwnAvailability,
} from '~/lib/scheduling/availability'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'avl-org'
const ALICE = 'avl-alice'
const BOB = 'avl-bob'

function principal(userId: string, role: TenantPrincipal['role'] = 'member'): TenantPrincipal {
  return { userId, organizationId: ORG, role, requestId: 'req-test' }
}

function rule(overrides: Partial<AvailabilityRuleInput> = {}): AvailabilityRuleInput {
  return {
    timeZone: 'Europe/Copenhagen',
    weekdays: [1, 2, 3],
    localStart: '09:00',
    localEnd: '12:00',
    slotMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 60,
    horizonDays: 30,
    enabled: true,
    ...overrides,
  }
}

function override(overrides: Partial<AvailabilityOverrideInput> = {}): AvailabilityOverrideInput {
  return { localDate: '2027-12-24', localStart: null, localEnd: null, kind: 'blocked', timeZone: 'Europe/Copenhagen', ...overrides }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('scheduling_availability')
  db = disposable.db
  drop = disposable.drop
  await db.insert(organizations).values({ id: ORG, name: 'Avl', slug: 'avl-org' })
  await db.insert(authUsers).values([
    { id: ALICE, name: 'Alice', email: 'avl-alice@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: BOB, name: 'Bob', email: 'avl-bob@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
}, 60_000)

afterAll(async () => {
  await drop()
})

function emptyPut(partial: Partial<Parameters<typeof putOwnAvailability>[2]> = {}) {
  return { version: 1, rules: [], overrides: [], defaultReminderOffsets: [], defaultReminderChannels: [], ...partial }
}

describe('normalizeAvailabilityRules', () => {
  it('merges two overlapping windows with identical settings into one', () => {
    const result = normalizeAvailabilityRules([
      rule({ weekdays: [1], localStart: '09:00', localEnd: '12:00' }),
      rule({ weekdays: [1], localStart: '11:00', localEnd: '15:00' }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0]).toMatchObject({ localStart: '09:00', localEnd: '15:00' })
  })

  it('merges windows that merely touch, leaving no phantom boundary', () => {
    const result = normalizeAvailabilityRules([
      rule({ weekdays: [1], localStart: '09:00', localEnd: '12:00' }),
      rule({ weekdays: [1], localStart: '12:00', localEnd: '15:00' }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0]).toMatchObject({ localStart: '09:00', localEnd: '15:00' })
  })

  it('keeps genuinely separate windows on the same day apart', () => {
    const result = normalizeAvailabilityRules([
      rule({ weekdays: [1], localStart: '09:00', localEnd: '12:00' }),
      rule({ weekdays: [1], localStart: '14:00', localEnd: '17:00' }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rules).toHaveLength(2)
  })

  it('refuses to merge overlapping windows whose slot settings disagree', () => {
    // There is no honest answer here: picking either rule's slot length would generate slots the
    // owner never configured, and keeping both would double-book the overlap.
    const result = normalizeAvailabilityRules([
      rule({ weekdays: [1], localStart: '09:00', localEnd: '12:00', slotMinutes: 30 }),
      rule({ weekdays: [1], localStart: '11:00', localEnd: '15:00', slotMinutes: 45 }),
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('conflicting_overlap')
    expect(result.weekday).toBe(1)
  })

  it('does not treat the same clock window in different timezones as an overlap', () => {
    // 09:00 in Copenhagen and 09:00 in Tokyo are different instants — merging them would invent
    // availability the owner never offered.
    const result = normalizeAvailabilityRules([
      rule({ weekdays: [1], timeZone: 'Europe/Copenhagen', slotMinutes: 30 }),
      rule({ weekdays: [1], timeZone: 'Asia/Tokyo', slotMinutes: 45 }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rules).toHaveLength(2)
  })

  it('re-collapses an identical window across days back into one multi-weekday rule', () => {
    const result = normalizeAvailabilityRules([rule({ weekdays: [1, 2, 3] })])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0].weekdays).toEqual([1, 2, 3])
  })
})

describe('putOwnAvailability', () => {
  it('reads back an empty policy at version 1 before anything is saved', async () => {
    const policy = await db.transaction((tx) => getOwnAvailability(tx, principal(BOB)))
    expect(policy).toMatchObject({ rules: [], overrides: [], version: 1 })
  })

  it('saves a policy and advances the version', async () => {
    const saved = await db.transaction((tx) => putOwnAvailability(tx, principal(ALICE), emptyPut({
      rules: [rule()],
      defaultReminderOffsets: [15, 60],
      defaultReminderChannels: ['email'],
    })))

    // The first save lands at 2, not 1: 1 is what "never saved" reads as, so a created policy has
    // to be distinguishable from an absent one or the next writer cannot tell them apart.
    expect(saved.version).toBe(2)
    expect(saved.rules).toHaveLength(1)

    const second = await db.transaction((tx) => putOwnAvailability(tx, principal(ALICE), emptyPut({
      version: 2, rules: [rule({ localEnd: '13:00' })],
    })))
    expect(second.version).toBe(3)

    const read = await db.transaction((tx) => getOwnAvailability(tx, principal(ALICE)))
    expect(read.version).toBe(3)
    expect(read.rules[0]).toMatchObject({ localStart: '09:00', localEnd: '13:00' })
  })

  it('rejects a stale version instead of overwriting the newer policy', async () => {
    await db.transaction((tx) => putOwnAvailability(tx, principal(BOB), emptyPut({ rules: [rule()] })))

    // Version 1 is now stale: the create advanced it to 2. A second client still holding 1 --
    // including one that raced the very first write -- must be refused.

    await expect(
      db.transaction((tx) => putOwnAvailability(tx, principal(BOB), emptyPut({ version: 1, rules: [rule({ localEnd: '18:00' })] }))),
    ).rejects.toMatchObject({ code: 'state_changed' })

    // The losing write must leave nothing behind — the version bump gates the row rewrite.
    const read = await db.transaction((tx) => getOwnAvailability(tx, principal(BOB)))
    expect(read.rules[0].localEnd).toBe('12:00')
  })

  it('rejects a time zone that is syntactically fine but does not exist', async () => {
    await expect(
      db.transaction((tx) => putOwnAvailability(tx, principal(ALICE), emptyPut({
        version: 3, rules: [rule({ timeZone: 'Europe/Atlantis' })],
      }))),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('rejects an unbounded horizon', async () => {
    await expect(
      db.transaction((tx) => putOwnAvailability(tx, principal(ALICE), emptyPut({
        version: 3, rules: [rule({ horizonDays: MAX_AVAILABILITY_HORIZON_DAYS + 1 })],
      }))),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('rejects conflicting overlapping rules rather than silently picking one', async () => {
    await expect(
      db.transaction((tx) => putOwnAvailability(tx, principal(ALICE), emptyPut({
        version: 3,
        rules: [
          rule({ weekdays: [1], localStart: '09:00', localEnd: '12:00', slotMinutes: 30 }),
          rule({ weekdays: [1], localStart: '11:00', localEnd: '15:00', slotMinutes: 45 }),
        ],
      }))),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('never lets one owner\'s policy appear in another owner\'s read', async () => {
    const alice = await db.transaction((tx) => getOwnAvailability(tx, principal(ALICE)))
    const bob = await db.transaction((tx) => getOwnAvailability(tx, principal(BOB)))

    // Both users have saved policies by now; each sees only their own version lineage.
    expect(alice.version).not.toBe(0)
    expect(bob.version).not.toBe(0)
    expect(alice.rules[0]?.localEnd).toBe('13:00')
    expect(bob.rules[0]?.localEnd).toBe('12:00')
  })

  it('grants an org admin no access to another member\'s availability', async () => {
    // `scheduling:manage` never consults `elevated`, so an admin acting on their own principal only
    // ever reaches their own row — there is no request shape that names someone else.
    const asAdmin = await db.transaction((tx) => getOwnAvailability(tx, principal('avl-admin-unknown', 'admin')))
    expect(asAdmin.rules).toEqual([])
    expect(asAdmin.version).toBe(1)
  })
})

describe('availability overrides', () => {
  it('adds an override and advances the policy version', async () => {
    const before = await db.transaction((tx) => getOwnAvailability(tx, principal(ALICE)))
    const after = await db.transaction((tx) => addOwnAvailabilityOverride(tx, principal(ALICE), {
      version: before.version, override: override(),
    }))

    expect(after.version).toBe(before.version + 1)
    expect(after.overrides).toHaveLength(1)
    expect(after.overrides[0]).toMatchObject({ localDate: '2027-12-24', kind: 'blocked' })
    // The rules must survive an override-only write — this path round-trips the whole policy.
    expect(after.rules).toHaveLength(before.rules.length)
  })

  it('replaces rather than duplicates an override for a date that already has one', async () => {
    const before = await db.transaction((tx) => getOwnAvailability(tx, principal(ALICE)))
    const after = await db.transaction((tx) => addOwnAvailabilityOverride(tx, principal(ALICE), {
      version: before.version,
      override: override({ kind: 'available', localStart: '14:00', localEnd: '16:00' }),
    }))

    // "Blocked all day" and "available 14:00-16:00" on one date cannot both be true.
    const sameDate = after.overrides.filter((row) => row.localDate === '2027-12-24')
    expect(sameDate).toHaveLength(1)
    expect(sameDate[0]).toMatchObject({ kind: 'available', localStart: '14:00' })
  })

  it('deletes an override', async () => {
    const before = await db.transaction((tx) => getOwnAvailability(tx, principal(ALICE)))
    const after = await db.transaction((tx) => deleteOwnAvailabilityOverride(tx, principal(ALICE), {
      version: before.version, localDate: '2027-12-24',
    }))

    expect(after.overrides.find((row) => row.localDate === '2027-12-24')).toBeUndefined()
  })

  it('treats deleting a date with no override as success, not 404', async () => {
    const before = await db.transaction((tx) => getOwnAvailability(tx, principal(ALICE)))
    const after = await db.transaction((tx) => deleteOwnAvailabilityOverride(tx, principal(ALICE), {
      version: before.version, localDate: '2099-01-01',
    }))

    // Reporting "not found" would tell a prober whether the owner had blocked that day.
    expect(after.version).toBe(before.version + 1)
  })

  it('rejects a stale version on an override write', async () => {
    const current = await db.transaction((tx) => getOwnAvailability(tx, principal(ALICE)))
    await expect(
      db.transaction((tx) => addOwnAvailabilityOverride(tx, principal(ALICE), {
        version: current.version - 1, override: override({ localDate: '2027-11-11' }),
      })),
    ).rejects.toMatchObject({ code: 'state_changed' })
  })
})
