import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { can } from '~/shared/lib/authorization/permissions'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, calendarEvents, organizations } from '~/shared/lib/db/schema'
import { insertCalendar, insertParticipants, listEventExceptions, listRemindersForEvent } from '~/shared/lib/repositories/calendar'
import {
  cancelEvent,
  CalendarServiceError,
  createEvent,
  deleteEvent,
  evaluateOverlap,
  getEvent,
  icsSequenceForEvent,
  icsUidForEvent,
  listRange,
  transitionEventStatus,
  updateEvent,
} from '~/lib/calendar/service'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'svc-org'
const OWNER = 'svc-owner'
const PARTICIPANT = 'svc-participant'
const MEMBER = 'svc-member'
const ADMIN = 'svc-admin'
let calendarId: string

function principal(userId: string, role: TenantPrincipal['role'] = 'member'): TenantPrincipal {
  return { userId, organizationId: ORG, role, requestId: 'req-test' }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('calendar_service')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values({ id: ORG, name: 'Svc', slug: 'svc-org' })
  await db.insert(authUsers).values([
    { id: OWNER, name: 'Owner', email: 'svc-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: PARTICIPANT, name: 'Part', email: 'svc-part@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: MEMBER, name: 'Member', email: 'svc-member@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: ADMIN, name: 'Admin', email: 'svc-admin@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  const cal = await db.transaction((tx) => insertCalendar(tx, { organizationId: ORG, ownerUserId: OWNER, name: 'Cal', timezone: 'Europe/Copenhagen', isDefault: true }))
  calendarId = cal.id
}, 60_000)

afterAll(async () => {
  await drop()
})

let slot = 0
function nextSlot() {
  slot += 1
  const start = new Date(Date.UTC(2027, 0, slot, 9, 0, 0))
  return { startsAt: start, endsAt: new Date(start.getTime() + 30 * 60_000) }
}

function eventInput(overrides: Partial<Parameters<typeof createEvent>[2]> = {}) {
  return {
    calendarId,
    type: 'personal',
    title: 'Event',
    timezone: 'Europe/Copenhagen',
    allDay: false,
    busy: true,
    ...nextSlot(),
    ...overrides,
  }
}

describe('permission matrix', () => {
  const ownerCtx = { creatorUserId: OWNER, isGrantedParticipant: true }
  const participantCtx = { creatorUserId: OWNER, isGrantedParticipant: true }
  const strangerCtx = { creatorUserId: OWNER, isGrantedParticipant: false }

  it('the owner may read, mutate, respond, and reach candidate data', () => {
    const p = principal(OWNER, 'member')
    for (const action of ['calendar:read', 'calendar:mutate', 'calendar:respond', 'scheduling:manage', 'candidate-data:read'] as const) {
      expect(can(p, action, { creatorUserId: OWNER })).toBe(true)
    }
    expect(ownerCtx.creatorUserId).toBe(OWNER)
  })

  it('a granted participant may read and respond but never mutate or reach candidate data', () => {
    const p = principal(PARTICIPANT)
    expect(can(p, 'calendar:read', participantCtx)).toBe(true)
    expect(can(p, 'calendar:respond', participantCtx)).toBe(true)
    expect(can(p, 'calendar:mutate', participantCtx)).toBe(false)
    expect(can(p, 'candidate-data:read', participantCtx)).toBe(false)
    expect(can(p, 'scheduling:manage', participantCtx)).toBe(false)
  })

  it('an unrelated member sees nothing', () => {
    const p = principal(MEMBER)
    expect(can(p, 'calendar:read', strangerCtx)).toBe(false)
    expect(can(p, 'calendar:mutate', strangerCtx)).toBe(false)
  })

  it('an org admin with no participation has no implicit access — no elevated branch exists', () => {
    for (const role of ['admin', 'owner'] as const) {
      const p = principal(ADMIN, role)
      expect(can(p, 'calendar:read', strangerCtx)).toBe(false)
      expect(can(p, 'calendar:mutate', strangerCtx)).toBe(false)
      expect(can(p, 'candidate-data:read', strangerCtx)).toBe(false)
    }
  })
})

describe('createEvent', () => {
  it('creates an event owned by the caller, always starting scheduled', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({ title: 'Made' })))
    expect(event.title).toBe('Made')
    expect(event.ownerUserId).toBe(OWNER)
    expect(event.status).toBe('scheduled')
    expect(event.visibility).toBe('private')
    expect(event.version).toBe(1)
  })

  it('rejects endsAt on or before startsAt', async () => {
    const start = new Date('2027-06-01T09:00:00.000Z')
    await expect(
      db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({ startsAt: start, endsAt: start }))),
    ).rejects.toThrow(CalendarServiceError)
  })

  it('rejects an unsupported recurrence rule instead of approximating it', async () => {
    await expect(
      db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({ rrule: 'FREQ=SECONDLY' }))),
    ).rejects.toThrow()
  })

  it('schedules reminders relative to the start time', async () => {
    const slotTimes = nextSlot()
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({
      ...slotTimes,
      reminders: [{ channel: 'email', offsetMinutes: 30 }],
    })))
    const reminders = await db.transaction((tx) => listRemindersForEvent(tx, ORG, event.id))
    expect(reminders).toHaveLength(1)
    expect(reminders[0].nextFireAt?.toISOString()).toBe(new Date(slotTimes.startsAt.getTime() - 30 * 60_000).toISOString())
  })

  it('grants read access to internal participants but not to external contacts', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({
      participants: [
        { userId: PARTICIPANT, role: 'attendee' },
        { externalEmail: 'outside@example.com', displayName: 'Outside', role: 'attendee' },
      ],
    })))
    const detail = await db.transaction((tx) => getEvent(tx, principal(OWNER), event.id))
    const internal = detail!.participants.find((p) => p.userId === PARTICIPANT)
    const external = detail!.participants.find((p) => p.externalEmail === 'outside@example.com')
    expect(internal?.accessGranted).toBe(true)
    expect(external?.accessGranted).toBe(false)
  })
})

describe('overlap policy', () => {
  it('a personal overlap warns and is allowed once acknowledged', async () => {
    const times = nextSlot()
    await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({ ...times, title: 'First' })))

    await expect(
      db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({ ...times, title: 'Second' }))),
    ).rejects.toMatchObject({ code: 'overlap_warning' })

    const { event, overlapWarning } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({
      ...times, title: 'Second Acknowledged', acknowledgeOverlapWarning: true,
    })))
    expect(event.title).toBe('Second Acknowledged')
    expect(overlapWarning).toBeGreaterThan(0)
  })

  it('an interview overlap is a hard conflict that acknowledgement cannot override', async () => {
    const times = nextSlot()
    await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({ ...times, title: 'Blocking' })))

    await expect(
      db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({
        ...times, type: 'interview', title: 'Interview', acknowledgeOverlapWarning: true,
      }))),
    ).rejects.toMatchObject({ code: 'slot_unavailable' })
  })

  it('a free (non-busy) event never conflicts', async () => {
    const times = nextSlot()
    await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({ ...times, title: 'Busy' })))
    const verdict = await db.transaction((tx) => evaluateOverlap(tx, principal(OWNER), { ...times, type: 'personal', busy: false }))
    expect(verdict.kind).toBe('clear')
  })

  it('back-to-back events do not overlap (half-open)', async () => {
    const first = nextSlot()
    await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({ ...first, title: 'Earlier' })))
    const verdict = await db.transaction((tx) => evaluateOverlap(tx, principal(OWNER), {
      startsAt: first.endsAt,
      endsAt: new Date(first.endsAt.getTime() + 30 * 60_000),
      type: 'interview',
      busy: true,
    }))
    expect(verdict.kind).toBe('clear')
  })
})

describe('read authorization', () => {
  it('the owner and a granted participant both read the event; a stranger gets null', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({
      participants: [{ userId: PARTICIPANT, role: 'attendee' }],
    })))

    expect(await db.transaction((tx) => getEvent(tx, principal(OWNER), event.id))).not.toBeNull()
    expect(await db.transaction((tx) => getEvent(tx, principal(PARTICIPANT), event.id))).not.toBeNull()
    expect(await db.transaction((tx) => getEvent(tx, principal(MEMBER), event.id))).toBeNull()
  })

  it('an admin who is not a participant gets null, indistinguishable from a missing event', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput()))
    expect(await db.transaction((tx) => getEvent(tx, principal(ADMIN, 'admin'), event.id))).toBeNull()
    expect(await db.transaction((tx) => getEvent(tx, principal(ADMIN, 'admin'), '11111111-1111-4111-8111-111111111111'))).toBeNull()
  })

  it('reports editable:false to a participant and true to the owner', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({
      participants: [{ userId: PARTICIPANT, role: 'attendee' }],
    })))
    expect((await db.transaction((tx) => getEvent(tx, principal(OWNER), event.id)))!.editable).toBe(true)
    expect((await db.transaction((tx) => getEvent(tx, principal(PARTICIPANT), event.id)))!.editable).toBe(false)
  })

  it('a participant added without access_granted still cannot read', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput()))
    await db.transaction((tx) => insertParticipants(tx, [{
      organizationId: ORG, eventId: event.id, eventOwnerUserId: OWNER, userId: MEMBER, role: 'attendee', accessGranted: false,
    }]))
    expect(await db.transaction((tx) => getEvent(tx, principal(MEMBER), event.id))).toBeNull()
  })

  it('listRange rejects an inverted range', async () => {
    await expect(
      db.transaction((tx) => listRange(tx, principal(OWNER), { from: new Date('2027-02-02'), to: new Date('2027-02-01') })),
    ).rejects.toThrow(CalendarServiceError)
  })
})

describe('updateEvent', () => {
  it('the owner updates and the version increments', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({ title: 'Before' })))
    const { event: updated } = await db.transaction((tx) => updateEvent(tx, principal(OWNER), event.id, { version: 1, patch: { title: 'After' } }))
    expect(updated.title).toBe('After')
    expect(updated.version).toBe(2)
  })

  it('a participant cannot update, even though they can read', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({
      participants: [{ userId: PARTICIPANT, role: 'attendee' }],
    })))
    await expect(
      db.transaction((tx) => updateEvent(tx, principal(PARTICIPANT), event.id, { version: 1, patch: { title: 'Hijack' } })),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('an unrelated member gets not_found, never forbidden — no existence leak', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput()))
    await expect(
      db.transaction((tx) => updateEvent(tx, principal(MEMBER), event.id, { version: 1, patch: { title: 'X' } })),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a stale version is refused', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput()))
    await db.transaction((tx) => updateEvent(tx, principal(OWNER), event.id, { version: 1, patch: { title: 'First' } }))
    await expect(
      db.transaction((tx) => updateEvent(tx, principal(OWNER), event.id, { version: 1, patch: { title: 'Second' } })),
    ).rejects.toMatchObject({ code: 'event_changed' })
  })

  it('a recurring event edit without a scope is refused', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({ rrule: 'FREQ=WEEKLY;COUNT=4' })))
    await expect(
      db.transaction((tx) => updateEvent(tx, principal(OWNER), event.id, { version: 1, patch: { title: 'No Scope' } })),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  /*
   * This block replaces a test called "each recurrence scope resolves to its own plan", which
   * asserted that `updateEvent` *returned* `{ kind: 'single_occurrence_exception' }` for scope
   * `this` — and passed, while renaming every occurrence in the series. It measured the object the
   * code had just computed, so it could not disagree with the code no matter what the code did.
   *
   * What matters is the effect on the rows: a scope of `this` or `following` must not rewrite the
   * series, and today the only way to guarantee that is to refuse the request.
   */
  it('a series-scoped edit applies to the series', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({ rrule: 'FREQ=WEEKLY;COUNT=4' })))
    const result = await db.transaction((tx) => updateEvent(tx, principal(OWNER), event.id, {
      version: 1, recurrenceScope: 'series', patch: { title: 'All' },
    }))
    expect(result.recurrencePlan).toEqual({ kind: 'rematerialize_series' })
    expect(result.event.title).toBe('All')
  })

  it('a single-occurrence or following edit is refused rather than applied to the series', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({
      rrule: 'FREQ=WEEKLY;COUNT=4', title: 'Untouched',
    })))
    const occurrenceInstant = event.startsAt.toISOString()

    for (const scope of ['this', 'following'] as const) {
      await expect(
        db.transaction((tx) => updateEvent(tx, principal(OWNER), event.id, {
          version: 1, recurrenceScope: scope, recurrenceId: occurrenceInstant, patch: { title: `Renamed by ${scope}` },
        })),
      ).rejects.toMatchObject({ code: 'not_implemented' })
    }

    // The refusal has to leave the row alone. A `not_implemented` thrown *after* the write would
    // be the same silent series rewrite with a better error message.
    const [row] = await db.select({ title: calendarEvents.title }).from(calendarEvents).where(eq(calendarEvents.id, event.id))
    expect(row?.title).toBe('Untouched')
  })

  it('an invitation-sourced event cannot be rescheduled through the ordinary edit path', async () => {
    const times = nextSlot()
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput(times)))
    // Stamp the source pair directly — the booking flow that normally sets it lands in Phase 5.
    await db.update(calendarEvents)
      .set({ sourceType: 'scheduling_invitation', sourceId: 'inv-1' })
      .where(eq(calendarEvents.id, event.id))

    await expect(
      db.transaction((tx) => updateEvent(tx, principal(OWNER), event.id, {
        version: 1, patch: { startsAt: new Date(times.startsAt.getTime() + 3600_000), endsAt: new Date(times.endsAt.getTime() + 3600_000) },
      })),
    ).rejects.toMatchObject({ code: 'state_changed' })
  })
})

describe('status transitions, cancel, and delete', () => {
  it('follows the appointment state machine and rejects an illegal jump', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput()))
    const confirmed = await db.transaction((tx) => transitionEventStatus(tx, principal(OWNER), event.id, 1, 'confirmed'))
    expect(confirmed.status).toBe('confirmed')

    await expect(
      db.transaction((tx) => transitionEventStatus(tx, principal(OWNER), event.id, 2, 'completed')),
    ).rejects.toMatchObject({ code: 'invalid_state_transition' })
  })

  it('cancel keeps the row, stamps cancelledAt, and cancels pending reminders', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({
      reminders: [{ channel: 'email', offsetMinutes: 60 }],
    })))
    const cancelled = await db.transaction((tx) => cancelEvent(tx, principal(OWNER), event.id, 1))
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelledAt).not.toBeNull()

    const reminders = await db.transaction((tx) => listRemindersForEvent(tx, ORG, event.id))
    expect(reminders.every((r) => r.state === 'cancelled')).toBe(true)
    // The event itself is still readable — cancel is not delete.
    expect(await db.transaction((tx) => getEvent(tx, principal(OWNER), event.id))).not.toBeNull()
  })

  it('delete removes the row entirely', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput()))
    await db.transaction((tx) => deleteEvent(tx, principal(OWNER), event.id, { version: 1 }))
    expect(await db.transaction((tx) => getEvent(tx, principal(OWNER), event.id))).toBeNull()
  })

  it('a participant cannot cancel or delete', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({
      participants: [{ userId: PARTICIPANT, role: 'attendee' }],
    })))
    await expect(db.transaction((tx) => cancelEvent(tx, principal(PARTICIPANT), event.id, 1))).rejects.toMatchObject({ code: 'forbidden' })
    await expect(db.transaction((tx) => deleteEvent(tx, principal(PARTICIPANT), event.id, { version: 1 }))).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('delete refuses a stale version', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput()))
    await expect(db.transaction((tx) => deleteEvent(tx, principal(OWNER), event.id, { version: 99 }))).rejects.toMatchObject({ code: 'event_changed' })
  })
})

/**
 * spec.md: "Editing/deleting a recurring occurrence always asks for `this occurrence`, `this and
 * following`, or `entire series`."
 *
 * The DELETE route accepted no scope at all until the Phase 12 e2e asked for one, so these are the
 * first assertions that the three outcomes differ. They read the rows rather than the returned
 * `kind`, for the reason spelled out above the edit-scope tests.
 */
describe('recurrence-scoped delete', () => {
  const RECURRING = { rrule: 'FREQ=WEEKLY;COUNT=4' } as const

  it('refuses a recurring delete with no scope', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput(RECURRING)))
    await expect(
      db.transaction((tx) => deleteEvent(tx, principal(OWNER), event.id, { version: 1 })),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    // Refused means untouched: the series is still readable.
    expect(await db.transaction((tx) => getEvent(tx, principal(OWNER), event.id))).not.toBeNull()
  })

  it('a non-recurring delete needs no scope', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput()))
    const result = await db.transaction((tx) => deleteEvent(tx, principal(OWNER), event.id, { version: 1 }))
    expect(result.kind).toBe('tombstoned')
    expect(await db.transaction((tx) => getEvent(tx, principal(OWNER), event.id))).toBeNull()
  })

  it("'this' records an exception and leaves the series standing", async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput(RECURRING)))
    const instant = event.startsAt.toISOString()

    const result = await db.transaction((tx) => deleteEvent(tx, principal(OWNER), event.id, {
      version: 1, recurrenceScope: 'this', recurrenceId: instant,
    }))
    expect(result).toEqual({ kind: 'occurrence_removed', eventId: event.id, recurrenceId: instant })

    // The exception row is the durable part — the occurrence cache is rebuilt every worker pass.
    const exceptions = await db.transaction((tx) => listEventExceptions(tx, ORG, event.id))
    expect(exceptions.map((exception) => exception.recurrenceId)).toEqual([instant])

    // And the event itself survives, because only one occurrence was removed.
    expect(await db.transaction((tx) => getEvent(tx, principal(OWNER), event.id))).not.toBeNull()
  })

  it("'this' twice is the same exception, not two", async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput(RECURRING)))
    const instant = event.startsAt.toISOString()
    for (let i = 0; i < 2; i++) {
      await db.transaction((tx) => deleteEvent(tx, principal(OWNER), event.id, {
        version: 1, recurrenceScope: 'this', recurrenceId: instant,
      }))
    }
    const exceptions = await db.transaction((tx) => listEventExceptions(tx, ORG, event.id))
    // A retried request is the same fact. Two rows would make the worker deduplicate instants it
    // should be able to pass straight through.
    expect(exceptions).toHaveLength(1)
  })

  it("'following' truncates the rule to just before the named occurrence", async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput(RECURRING)))
    const secondWeek = new Date(event.startsAt.getTime() + 7 * 24 * 60 * 60_000)

    const result = await db.transaction((tx) => deleteEvent(tx, principal(OWNER), event.id, {
      version: 1, recurrenceScope: 'following', recurrenceId: secondWeek.toISOString(),
    }))
    expect(result.kind).toBe('series_truncated')

    const [row] = await db.select({ recurrenceUntil: calendarEvents.recurrenceUntil })
      .from(calendarEvents).where(eq(calendarEvents.id, event.id))
    // Strictly before the occurrence, so `UNTIL` excludes the one the user removed. Equal would
    // keep it — an off-by-one that silently ignores the request.
    expect(row?.recurrenceUntil?.getTime()).toBe(secondWeek.getTime() - 1)
    expect(row?.recurrenceUntil!.getTime()).toBeLessThan(secondWeek.getTime())
  })

  it("'following' from the first occurrence is refused as a disguised series delete", async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput(RECURRING)))
    await expect(
      db.transaction((tx) => deleteEvent(tx, principal(OWNER), event.id, {
        version: 1, recurrenceScope: 'following', recurrenceId: event.startsAt.toISOString(),
      })),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    // Otherwise the result is a recurring event with no occurrences that still appears in lists.
    expect(await db.transaction((tx) => getEvent(tx, principal(OWNER), event.id))).not.toBeNull()
  })

  it("'series' removes the event outright", async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput(RECURRING)))
    const result = await db.transaction((tx) => deleteEvent(tx, principal(OWNER), event.id, {
      version: 1, recurrenceScope: 'series',
    }))
    expect(result.kind).toBe('tombstoned')
    expect(await db.transaction((tx) => getEvent(tx, principal(OWNER), event.id))).toBeNull()
  })

  it("'this' and 'following' require a recurrenceId", async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput(RECURRING)))
    for (const scope of ['this', 'following'] as const) {
      await expect(
        db.transaction((tx) => deleteEvent(tx, principal(OWNER), event.id, { version: 1, recurrenceScope: scope })),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('a participant cannot delete one occurrence either', async () => {
    const { event } = await db.transaction((tx) => createEvent(tx, principal(OWNER), eventInput({
      ...RECURRING, participants: [{ userId: PARTICIPANT, role: 'attendee' }],
    })))
    await expect(
      db.transaction((tx) => deleteEvent(tx, principal(PARTICIPANT), event.id, {
        version: 1, recurrenceScope: 'this', recurrenceId: event.startsAt.toISOString(),
      })),
    ).rejects.toMatchObject({ code: 'forbidden' })
    // Removing one occurrence is still an edit, so it must not be a hole in `calendar:mutate`.
    expect(await db.transaction((tx) => listEventExceptions(tx, ORG, event.id))).toHaveLength(0)
  })
})

describe('ICS identity', () => {
  it('the UID is stable across versions and unique per event', () => {
    const a = icsUidForEvent('event-a')
    expect(icsUidForEvent('event-a')).toBe(a)
    expect(icsUidForEvent('event-b')).not.toBe(a)
    expect(a.endsWith('@builderhunt.dev')).toBe(true)
  })

  it('SEQUENCE increases monotonically with the event version', () => {
    expect(icsSequenceForEvent(1)).toBe(0)
    expect(icsSequenceForEvent(2)).toBe(1)
    expect(icsSequenceForEvent(10)).toBeGreaterThan(icsSequenceForEvent(9))
  })
})
