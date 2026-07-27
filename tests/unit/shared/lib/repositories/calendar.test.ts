import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, calendarEvents, organizations } from '~/shared/lib/db/schema'
import {
  cancelRemindersForEvent,
  countUnreadDeliveries,
  deleteEventWithVersion,
  deleteOccurrencesForEvent,
  findDefaultCalendar,
  findEventById,
  hasGrantedParticipation,
  insertCalendar,
  insertDeliveryIfAbsent,
  insertEvent,
  insertParticipants,
  insertReminders,
  listBusyRanges,
  listDueReminders,
  listEventsInRange,
  listOccurrencesInRange,
  listOwnDeliveries,
  listParticipants,
  listRemindersForEvent,
  markDeliveriesRead,
  markReminderState,
  searchEvents,
  updateEventWithVersion,
  updateOwnParticipantResponse,
  upsertOccurrences,
} from '~/shared/lib/repositories/calendar'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG_A = 'cal-org-a'
const ORG_B = 'cal-org-b'
const OWNER = 'cal-owner'
const PARTICIPANT = 'cal-participant'
const OTHER = 'cal-other'

let calendarA: string
let calendarB: string

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('repo_calendar')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([
    { id: ORG_A, name: 'A', slug: 'cal-org-a' },
    { id: ORG_B, name: 'B', slug: 'cal-org-b' },
  ])
  await db.insert(authUsers).values([
    { id: OWNER, name: 'Owner', email: 'cal-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: PARTICIPANT, name: 'Participant', email: 'cal-part@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: OTHER, name: 'Other', email: 'cal-other@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])

  const a = await db.transaction((tx) => insertCalendar(tx, { organizationId: ORG_A, ownerUserId: OWNER, name: 'A', timezone: 'Europe/Copenhagen', isDefault: true }))
  const b = await db.transaction((tx) => insertCalendar(tx, { organizationId: ORG_B, ownerUserId: OWNER, name: 'B', timezone: 'UTC', isDefault: true }))
  calendarA = a.id
  calendarB = b.id
}, 60_000)

afterAll(async () => {
  await drop()
})

function eventInput(overrides: Partial<Parameters<typeof insertEvent>[1]> = {}) {
  return {
    organizationId: ORG_A,
    calendarId: calendarA,
    ownerUserId: OWNER,
    type: 'personal',
    status: 'scheduled',
    title: 'Standup',
    startsAt: new Date('2026-08-03T09:00:00.000Z'),
    endsAt: new Date('2026-08-03T09:30:00.000Z'),
    timezone: 'Europe/Copenhagen',
    allDay: false,
    busy: true,
    ...overrides,
  }
}

describe('calendars', () => {
  it('finds the owner default calendar, and returns null for a different owner', async () => {
    const found = await db.transaction((tx) => findDefaultCalendar(tx, ORG_A, OWNER))
    expect(found?.id).toBe(calendarA)
    expect(await db.transaction((tx) => findDefaultCalendar(tx, ORG_A, OTHER))).toBeNull()
  })

  it('never returns another tenant calendar under the first tenant predicate', async () => {
    const found = await db.transaction((tx) => findDefaultCalendar(tx, ORG_A, OWNER))
    expect(found?.id).not.toBe(calendarB)
  })
})

describe('events', () => {
  it('inserts and reads an event back by id, scoped to its tenant', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput({ title: 'Read Back' })))
    const found = await db.transaction((tx) => findEventById(tx, ORG_A, created.id))
    expect(found?.title).toBe('Read Back')
    // Same id, wrong tenant → nothing, even though the row exists.
    expect(await db.transaction((tx) => findEventById(tx, ORG_B, created.id))).toBeNull()
  })

  it('does not serialize columns outside the explicit projection', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    const found = await db.transaction((tx) => findEventById(tx, ORG_A, created.id))
    expect(found).not.toHaveProperty('createdAt')
    expect(found).not.toHaveProperty('updatedAt')
  })

  it('lists only events overlapping a half-open range', async () => {
    const org = 'cal-org-range'
    await db.insert(organizations).values({ id: org, name: 'R', slug: 'cal-org-range' })
    const cal = await db.transaction((tx) => insertCalendar(tx, { organizationId: org, ownerUserId: OWNER, name: 'R', timezone: 'UTC', isDefault: true }))
    await db.transaction((tx) => insertEvent(tx, eventInput({
      organizationId: org, calendarId: cal.id, title: 'Inside',
      startsAt: new Date('2026-09-01T10:00:00.000Z'), endsAt: new Date('2026-09-01T11:00:00.000Z'),
    })))
    await db.transaction((tx) => insertEvent(tx, eventInput({
      organizationId: org, calendarId: cal.id, title: 'Outside',
      startsAt: new Date('2026-09-05T10:00:00.000Z'), endsAt: new Date('2026-09-05T11:00:00.000Z'),
    })))

    const rows = await db.transaction((tx) => listEventsInRange(tx, org, OWNER, {
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-02T00:00:00.000Z'),
    }))
    expect(rows.map((r) => r.title)).toEqual(['Inside'])
  })

  it('optimistic update succeeds on a matching version and bumps it', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput({ title: 'V1' })))
    expect(created.version).toBe(1)
    const updated = await db.transaction((tx) => updateEventWithVersion(tx, ORG_A, OWNER, created.id, 1, { title: 'V2' }))
    expect(updated?.title).toBe('V2')
    expect(updated?.version).toBe(2)
  })

  it('optimistic update returns null on a stale version, leaving the row untouched', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput({ title: 'Stale Base' })))
    await db.transaction((tx) => updateEventWithVersion(tx, ORG_A, OWNER, created.id, 1, { title: 'First Writer' }))

    const stale = await db.transaction((tx) => updateEventWithVersion(tx, ORG_A, OWNER, created.id, 1, { title: 'Second Writer' }))
    expect(stale).toBeNull()

    const current = await db.transaction((tx) => findEventById(tx, ORG_A, created.id))
    expect(current?.title).toBe('First Writer')
  })

  it('update is refused for a non-owner even with the right version', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput({ title: 'Owned' })))
    const attempt = await db.transaction((tx) => updateEventWithVersion(tx, ORG_A, OTHER, created.id, 1, { title: 'Hijacked' }))
    expect(attempt).toBeNull()
    const current = await db.transaction((tx) => findEventById(tx, ORG_A, created.id))
    expect(current?.title).toBe('Owned')
  })

  it('update is refused across tenants even for the same owner id', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput({ title: 'Tenant A Only' })))
    const attempt = await db.transaction((tx) => updateEventWithVersion(tx, ORG_B, OWNER, created.id, 1, { title: 'Cross Tenant' }))
    expect(attempt).toBeNull()
  })

  it('delete honours owner and version', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    expect(await db.transaction((tx) => deleteEventWithVersion(tx, ORG_A, OTHER, created.id, 1))).toBeNull()
    expect(await db.transaction((tx) => deleteEventWithVersion(tx, ORG_A, OWNER, created.id, 99))).toBeNull()
    expect(await db.transaction((tx) => deleteEventWithVersion(tx, ORG_A, OWNER, created.id, 1))).not.toBeNull()
    expect(await db.transaction((tx) => findEventById(tx, ORG_A, created.id))).toBeNull()
  })

  it('searches by title, type, and participant', async () => {
    const org = 'cal-org-search'
    await db.insert(organizations).values({ id: org, name: 'S', slug: 'cal-org-search' })
    const cal = await db.transaction((tx) => insertCalendar(tx, { organizationId: org, ownerUserId: OWNER, name: 'S', timezone: 'UTC', isDefault: true }))
    const interview = await db.transaction((tx) => insertEvent(tx, eventInput({
      organizationId: org, calendarId: cal.id, title: 'Backend Interview', type: 'interview',
      startsAt: new Date('2026-10-01T10:00:00.000Z'), endsAt: new Date('2026-10-01T11:00:00.000Z'),
    })))
    await db.transaction((tx) => insertEvent(tx, eventInput({
      organizationId: org, calendarId: cal.id, title: 'Lunch', type: 'personal',
      startsAt: new Date('2026-10-01T12:00:00.000Z'), endsAt: new Date('2026-10-01T13:00:00.000Z'),
    })))
    await db.transaction((tx) => insertParticipants(tx, [{
      organizationId: org, eventId: interview.id, eventOwnerUserId: OWNER,
      externalEmail: 'jamie@example.com', displayName: 'Jamie Doe', role: 'attendee', accessGranted: false,
    }]))

    const range = { from: new Date('2026-10-01T00:00:00.000Z'), to: new Date('2026-10-02T00:00:00.000Z') }
    expect((await db.transaction((tx) => searchEvents(tx, org, OWNER, { ...range, title: 'interview' }))).map((r) => r.title)).toEqual(['Backend Interview'])
    expect((await db.transaction((tx) => searchEvents(tx, org, OWNER, { ...range, eventType: 'personal' }))).map((r) => r.title)).toEqual(['Lunch'])
    expect((await db.transaction((tx) => searchEvents(tx, org, OWNER, { ...range, participant: 'Jamie' }))).map((r) => r.title)).toEqual(['Backend Interview'])
  })
})

describe('occurrences', () => {
  it('upsert is idempotent on the (org, event, recurrenceId) identity', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput({ title: 'Recurring' })))
    const row = {
      organizationId: ORG_A,
      eventId: created.id,
      recurrenceId: '2026-08-03',
      startsAt: new Date('2026-08-03T09:00:00.000Z'),
      endsAt: new Date('2026-08-03T09:30:00.000Z'),
      status: 'active',
      materializationVersion: 1,
    }
    await db.transaction((tx) => upsertOccurrences(tx, [row]))
    await db.transaction((tx) => upsertOccurrences(tx, [{ ...row, endsAt: new Date('2026-08-03T10:00:00.000Z'), materializationVersion: 2 }]))

    const rows = await db.transaction((tx) => listOccurrencesInRange(tx, ORG_A, {
      from: new Date('2026-08-03T00:00:00.000Z'),
      to: new Date('2026-08-04T00:00:00.000Z'),
    }))
    const mine = rows.filter((r) => r.eventId === created.id)
    expect(mine).toHaveLength(1)
    expect(mine[0].materializationVersion).toBe(2)
  })

  it('deletes all occurrences for an event', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    await db.transaction((tx) => upsertOccurrences(tx, [{
      organizationId: ORG_A, eventId: created.id, recurrenceId: 'r1',
      startsAt: new Date('2026-11-01T09:00:00.000Z'), endsAt: new Date('2026-11-01T10:00:00.000Z'),
      status: 'active', materializationVersion: 1,
    }]))
    const deleted = await db.transaction((tx) => deleteOccurrencesForEvent(tx, ORG_A, created.id))
    expect(deleted).toHaveLength(1)
  })

  it('upsert of an empty batch is a no-op', async () => {
    expect(await db.transaction((tx) => upsertOccurrences(tx, []))).toEqual([])
  })
})

describe('participants', () => {
  it('records access-granted participation and reports it', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    await db.transaction((tx) => insertParticipants(tx, [
      { organizationId: ORG_A, eventId: created.id, eventOwnerUserId: OWNER, userId: PARTICIPANT, role: 'attendee', accessGranted: true },
      { organizationId: ORG_A, eventId: created.id, eventOwnerUserId: OWNER, userId: OTHER, role: 'attendee', accessGranted: false },
    ]))

    expect(await db.transaction((tx) => hasGrantedParticipation(tx, ORG_A, created.id, PARTICIPANT))).toBe(true)
    // Present on the event but NOT access-granted — must not count as participation.
    expect(await db.transaction((tx) => hasGrantedParticipation(tx, ORG_A, created.id, OTHER))).toBe(false)
    expect(await db.transaction((tx) => hasGrantedParticipation(tx, ORG_A, created.id, 'nobody'))).toBe(false)
  })

  it('a participant updates only their own response row', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    await db.transaction((tx) => insertParticipants(tx, [
      { organizationId: ORG_A, eventId: created.id, eventOwnerUserId: OWNER, userId: PARTICIPANT, role: 'attendee', accessGranted: true },
      { organizationId: ORG_A, eventId: created.id, eventOwnerUserId: OWNER, userId: OTHER, role: 'attendee', accessGranted: true },
    ]))

    await db.transaction((tx) => updateOwnParticipantResponse(tx, ORG_A, created.id, PARTICIPANT, 'accepted'))
    const rows = await db.transaction((tx) => listParticipants(tx, ORG_A, created.id))
    expect(rows.find((r) => r.userId === PARTICIPANT)?.response).toBe('accepted')
    expect(rows.find((r) => r.userId === OTHER)?.response).toBe('needs_action')
  })

  it('the FK rejects a participant claiming the wrong event owner', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    await expect(
      db.transaction((tx) => insertParticipants(tx, [
        { organizationId: ORG_A, eventId: created.id, eventOwnerUserId: OTHER, userId: PARTICIPANT, role: 'attendee', accessGranted: true },
      ])),
    ).rejects.toThrow()
  })
})

describe('reminders', () => {
  it('lists due reminders and marks their state', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    await db.transaction((tx) => insertReminders(tx, [
      { organizationId: ORG_A, eventId: created.id, channel: 'email', offsetMinutes: 30, nextFireAt: new Date('2026-01-01T00:00:00.000Z') },
      { organizationId: ORG_A, eventId: created.id, channel: 'in_app', offsetMinutes: 10, nextFireAt: new Date('2099-01-01T00:00:00.000Z') },
    ]))

    const due = await db.transaction((tx) => listDueReminders(tx, ORG_A, new Date('2026-02-01T00:00:00.000Z'), 10))
    const mine = due.filter((r) => r.eventId === created.id)
    expect(mine).toHaveLength(1)
    expect(mine[0].channel).toBe('email')

    const marked = await db.transaction((tx) => markReminderState(tx, ORG_A, mine[0].id, 'sent'))
    expect(marked?.state).toBe('sent')
    expect(marked?.attempts).toBe(1)
  })

  it('cancelling an event cancels only its still-pending reminders', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    await db.transaction((tx) => insertReminders(tx, [
      { organizationId: ORG_A, eventId: created.id, channel: 'email', offsetMinutes: 60, nextFireAt: new Date('2026-01-01T00:00:00.000Z') },
      { organizationId: ORG_A, eventId: created.id, channel: 'in_app', offsetMinutes: 15, nextFireAt: new Date('2026-01-01T00:00:00.000Z') },
    ]))
    const reminders = await db.transaction((tx) => listRemindersForEvent(tx, ORG_A, created.id))
    await db.transaction((tx) => markReminderState(tx, ORG_A, reminders[0].id, 'sent'))

    const cancelled = await db.transaction((tx) => cancelRemindersForEvent(tx, ORG_A, created.id))
    expect(cancelled).toHaveLength(1)

    const after = await db.transaction((tx) => listRemindersForEvent(tx, ORG_A, created.id))
    expect(after.map((r) => r.state).sort()).toEqual(['cancelled', 'sent'])
  })

  it('rejects a reminder offset outside the allowlisted set', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    await expect(
      db.transaction((tx) => insertReminders(tx, [{ organizationId: ORG_A, eventId: created.id, channel: 'email', offsetMinutes: 7 }])),
    ).rejects.toThrow()
  })
})

describe('notification deliveries', () => {
  it('is idempotent by idempotencyKey', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    const input = {
      organizationId: ORG_A,
      eventId: created.id,
      kind: 'reminder',
      recipientUserId: OWNER,
      idempotencyKey: `delivery-${created.id}`,
    }
    expect(await db.transaction((tx) => insertDeliveryIfAbsent(tx, input))).not.toBeNull()
    // Second attempt with the same key must not create a second delivery.
    expect(await db.transaction((tx) => insertDeliveryIfAbsent(tx, input))).toBeNull()
  })

  it('marks only the caller own listed deliveries read', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    const mine = await db.transaction((tx) => insertDeliveryIfAbsent(tx, {
      organizationId: ORG_A, eventId: created.id, kind: 'reminder', recipientUserId: OWNER, idempotencyKey: `mine-${created.id}`,
    }))
    const theirs = await db.transaction((tx) => insertDeliveryIfAbsent(tx, {
      organizationId: ORG_A, eventId: created.id, kind: 'reminder', recipientUserId: PARTICIPANT, idempotencyKey: `theirs-${created.id}`,
    }))

    // OWNER tries to mark BOTH ids read — only their own is affected.
    const marked = await db.transaction((tx) => markDeliveriesRead(tx, ORG_A, OWNER, [mine!.id, theirs!.id]))
    expect(marked.map((r) => r.id)).toEqual([mine!.id])

    const theirDeliveries = await db.transaction((tx) => listOwnDeliveries(tx, ORG_A, PARTICIPANT, 50))
    expect(theirDeliveries.find((d) => d.id === theirs!.id)?.readAt).toBeNull()
  })

  it('counts only unread deliveries for the caller', async () => {
    const org = 'cal-org-unread'
    await db.insert(organizations).values({ id: org, name: 'U', slug: 'cal-org-unread' })
    const cal = await db.transaction((tx) => insertCalendar(tx, { organizationId: org, ownerUserId: OWNER, name: 'U', timezone: 'UTC', isDefault: true }))
    const created = await db.transaction((tx) => insertEvent(tx, eventInput({ organizationId: org, calendarId: cal.id })))
    await db.transaction((tx) => insertDeliveryIfAbsent(tx, { organizationId: org, eventId: created.id, kind: 'reminder', recipientUserId: OWNER, idempotencyKey: `u1-${created.id}` }))
    await db.transaction((tx) => insertDeliveryIfAbsent(tx, { organizationId: org, eventId: created.id, kind: 'reminder', recipientUserId: OWNER, idempotencyKey: `u2-${created.id}` }))

    expect(await db.transaction((tx) => countUnreadDeliveries(tx, org, OWNER))).toBe(2)
    const all = await db.transaction((tx) => listOwnDeliveries(tx, org, OWNER, 50))
    await db.transaction((tx) => markDeliveriesRead(tx, org, OWNER, [all[0].id]))
    expect(await db.transaction((tx) => countUnreadDeliveries(tx, org, OWNER))).toBe(1)
  })

  it('does not expose delivery plumbing internals', async () => {
    const created = await db.transaction((tx) => insertEvent(tx, eventInput()))
    await db.transaction((tx) => insertDeliveryIfAbsent(tx, {
      organizationId: ORG_A, eventId: created.id, kind: 'reminder', recipientUserId: OWNER, idempotencyKey: `plumbing-${created.id}`,
    }))
    const rows = await db.transaction((tx) => listOwnDeliveries(tx, ORG_A, OWNER, 50))
    expect(rows[0]).not.toHaveProperty('idempotencyKey')
    expect(rows[0]).not.toHaveProperty('providerReference')
    expect(rows[0]).not.toHaveProperty('externalRecipientHash')
  })
})

describe('busy ranges', () => {
  it('returns only busy, non-cancelled events in range', async () => {
    const org = 'cal-org-busy'
    await db.insert(organizations).values({ id: org, name: 'Busy', slug: 'cal-org-busy' })
    const cal = await db.transaction((tx) => insertCalendar(tx, { organizationId: org, ownerUserId: OWNER, name: 'Busy', timezone: 'UTC', isDefault: true }))
    const base = { organizationId: org, calendarId: cal.id }

    await db.transaction((tx) => insertEvent(tx, eventInput({ ...base, title: 'Busy', busy: true, startsAt: new Date('2026-12-01T09:00:00.000Z'), endsAt: new Date('2026-12-01T10:00:00.000Z') })))
    await db.transaction((tx) => insertEvent(tx, eventInput({ ...base, title: 'Free', busy: false, startsAt: new Date('2026-12-01T11:00:00.000Z'), endsAt: new Date('2026-12-01T12:00:00.000Z') })))
    const cancelled = await db.transaction((tx) => insertEvent(tx, eventInput({ ...base, title: 'Cancelled', busy: true, startsAt: new Date('2026-12-01T13:00:00.000Z'), endsAt: new Date('2026-12-01T14:00:00.000Z') })))
    await db.update(calendarEvents).set({ status: 'cancelled' }).where(eq(calendarEvents.id, cancelled.id))

    const ranges = await db.transaction((tx) => listBusyRanges(tx, org, OWNER, {
      from: new Date('2026-12-01T00:00:00.000Z'),
      to: new Date('2026-12-02T00:00:00.000Z'),
    }))
    expect(ranges).toHaveLength(1)
    expect(ranges[0].start.toISOString()).toBe('2026-12-01T09:00:00.000Z')
  })
})
