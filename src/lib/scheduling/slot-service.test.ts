import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations } from '~/shared/lib/db/schema'
import { insertCalendar, insertEvent } from '~/shared/lib/repositories/calendar'
import { replaceAvailabilityPolicy, upsertAvailabilityPolicyWithVersion } from '~/shared/lib/repositories/scheduling'
import { MAX_SLOT_RANGE_DAYS, querySlots } from './slot-service'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'slot-org'
const OWNER = 'slot-owner'
const QUIET_OWNER = 'slot-quiet-owner'
let calendarId: string

/** A Monday, well clear of any DST boundary in Europe/Copenhagen. */
const MONDAY = new Date(Date.UTC(2027, 5, 7, 0, 0, 0))

function rule(overrides: Record<string, unknown> = {}) {
  return {
    timezone: 'Europe/Copenhagen',
    weekdays: [1, 2, 3, 4, 5],
    localStart: '09:00',
    localEnd: '17:00',
    slotMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    horizonDays: 60,
    enabled: true,
    ...overrides,
  }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('scheduling_slot_service')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values({ id: ORG, name: 'Slot', slug: 'slot-org' })
  await db.insert(authUsers).values([
    { id: OWNER, name: 'Owner', email: 'slot-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: QUIET_OWNER, name: 'Quiet', email: 'slot-quiet@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  const cal = await db.transaction((tx) => insertCalendar(tx, {
    organizationId: ORG, ownerUserId: OWNER, name: 'Cal', timezone: 'Europe/Copenhagen', isDefault: true,
  }))
  calendarId = cal.id

  // Two writes, because the policy is two rows: the header carries the version a booking request
  // echoes back, the rule rows carry the shape of the week.
  await db.transaction((tx) => upsertAvailabilityPolicyWithVersion(tx, ORG, OWNER, 1, {
    defaultReminderOffsets: [],
    defaultReminderChannels: [],
  }))
  await db.transaction((tx) => replaceAvailabilityPolicy(tx, ORG, OWNER, {
    rules: [rule()],
    overrides: [],
  }))
}, 60_000)

afterAll(async () => {
  await drop()
})

function query(overrides: Partial<Parameters<typeof querySlots>[1]> = {}) {
  return {
    organizationId: ORG,
    ownerUserId: OWNER,
    durationMinutes: 30,
    from: MONDAY,
    to: new Date(MONDAY.getTime() + 2 * 24 * 60 * 60_000),
    now: new Date(MONDAY.getTime() - 24 * 60 * 60_000),
    ...overrides,
  }
}

describe('slot service (plan: calendar-scheduling-interview-intelligence, Phase 5)', () => {
  it('derives bookable slots inside the configured window', async () => {
    const result = await db.transaction((tx) => querySlots(tx, query()))
    expect(result.slots.length).toBeGreaterThan(0)
    expect(result.policyVersion).not.toBeNull()

    for (const slot of result.slots) {
      expect(slot.endsAt.getTime()).toBeGreaterThan(slot.startsAt.getTime())
      // Nothing outside the requested window.
      expect(slot.startsAt.getTime()).toBeGreaterThanOrEqual(query().from.getTime())
      expect(slot.endsAt.getTime()).toBeLessThanOrEqual(query().to.getTime())
    }
  })

  it('returns slots in chronological order with unique opaque ids', async () => {
    const { slots } = await db.transaction((tx) => querySlots(tx, query()))
    const starts = slots.map((s) => s.startsAt.getTime())
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    expect(new Set(slots.map((s) => s.slotId)).size).toBe(slots.length)
    // Opaque: the id must not simply be a readable timestamp.
    for (const slot of slots) {
      expect(slot.slotId).not.toContain(String(slot.startsAt.getTime()))
      expect(slot.slotId).not.toContain(slot.startsAt.toISOString())
    }
  })

  it('never offers a slot shorter than the interview', async () => {
    // The rule's slot size is 30 minutes; a 45-minute interview must not be squeezed into it.
    const { slots } = await db.transaction((tx) => querySlots(tx, query({ durationMinutes: 45 })))
    for (const slot of slots) {
      expect(slot.endsAt.getTime() - slot.startsAt.getTime()).toBeGreaterThanOrEqual(45 * 60_000)
    }
  })

  it('subtracts the organizer\'s existing events without revealing them', async () => {
    const before = await db.transaction((tx) => querySlots(tx, query()))

    // Block the whole first working day.
    await db.transaction((tx) => insertEvent(tx, {
      organizationId: ORG,
      calendarId,
      ownerUserId: OWNER,
      type: 'personal',
      title: 'SECRET BOARD MEETING',
      timezone: 'Europe/Copenhagen',
      allDay: false,
      startsAt: new Date(Date.UTC(2027, 5, 7, 6, 0, 0)),
      endsAt: new Date(Date.UTC(2027, 5, 7, 16, 0, 0)),
      status: 'confirmed',
      busy: true,
    }))

    const after = await db.transaction((tx) => querySlots(tx, query()))
    expect(after.slots.length).toBeLessThan(before.slots.length)

    // The reason a time disappeared must not be discoverable from the response.
    const serialised = JSON.stringify(after)
    expect(serialised).not.toContain('SECRET BOARD MEETING')
    expect(serialised).not.toContain(calendarId)
    expect(serialised).not.toMatch(/title|busy|conflict|event/i)
  })

  it('clamps an absurd range instead of scanning it', async () => {
    const result = await db.transaction((tx) => querySlots(tx, query({
      from: MONDAY,
      to: new Date(Date.UTC(2999, 0, 1)),
    })))
    const spanDays = (result.effectiveRange.to.getTime() - result.effectiveRange.from.getTime()) / (24 * 60 * 60_000)
    expect(spanDays).toBeLessThanOrEqual(MAX_SLOT_RANGE_DAYS)
  })

  it('returns nothing for an inverted range', async () => {
    const result = await db.transaction((tx) => querySlots(tx, query({
      from: new Date(MONDAY.getTime() + 60_000),
      to: MONDAY,
    })))
    expect(result.slots).toEqual([])
  })

  it('an organizer with no availability looks identical to one with nothing free', async () => {
    // Both must be an empty list, not an error and not a distinguishable shape: the candidate is
    // unauthenticated and must not learn whether the organizer ever configured anything.
    const unconfigured = await db.transaction((tx) => querySlots(tx, query({ ownerUserId: QUIET_OWNER })))
    expect(unconfigured.slots).toEqual([])
    expect(unconfigured.policyVersion).toBeNull()

    const nothingFree = await db.transaction((tx) => querySlots(tx, query({
      // A window entirely in the past relative to `now` leaves nothing bookable.
      from: new Date(MONDAY.getTime() - 10 * 24 * 60 * 60_000),
      to: new Date(MONDAY.getTime() - 9 * 24 * 60 * 60_000),
    })))
    expect(nothingFree.slots).toEqual([])
  })

  it('honours minimum notice', async () => {
    await db.transaction((tx) => replaceAvailabilityPolicy(tx, ORG, QUIET_OWNER, {
      rules: [rule({ minNoticeMinutes: 60 * 24 * 30 })], // 30 days' notice
      overrides: [],
    }))
    const result = await db.transaction((tx) => querySlots(tx, query({ ownerUserId: QUIET_OWNER })))
    // The window is two days out; a 30-day notice period rules all of it out.
    expect(result.slots).toEqual([])
  })

  it('ignores disabled rules', async () => {
    await db.transaction((tx) => replaceAvailabilityPolicy(tx, ORG, QUIET_OWNER, {
      rules: [rule({ enabled: false })],
      overrides: [],
    }))
    const result = await db.transaction((tx) => querySlots(tx, query({ ownerUserId: QUIET_OWNER })))
    expect(result.slots).toEqual([])
  })
})
