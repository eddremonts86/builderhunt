import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  authUsers,
  calendarEventReminders,
  calendarEvents,
  calendarNotificationDeliveries,
  eventParticipants,
  jobRuns,
  organizations,
} from '~/shared/lib/db/schema'
import type { SendResult } from '~/shared/lib/email'
import { insertCalendar, insertEvent, insertParticipants, insertReminders } from '~/shared/lib/repositories/calendar'
import { MAX_REMINDER_ATTEMPTS, REMINDER_JOB_KEY, runReminderWorker } from '~/lib/calendar/reminder-worker'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG_A = 'rmw-org-a'
const ORG_B = 'rmw-org-b'
const OWNER = 'rmw-owner'
const ATTENDEE = 'rmw-attendee'
const NOW = new Date('2027-06-10T09:00:00.000Z')

let calendarA: string
let calendarB: string

interface CapturedEmail {
  to: string
  title: string
  icsContent: string
}

let captured: CapturedEmail[] = []
let sendOutcome: SendResult = { ok: true, id: 'provider-ref-1' }

function capturingSend(): NonNullable<Parameters<typeof runReminderWorker>[0]>['send'] {
  return async (to, details) => {
    captured.push({ to, title: details.title, icsContent: details.icsContent })
    return sendOutcome
  }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('calendar_reminder_worker')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([
    { id: ORG_A, name: 'A', slug: 'rmw-org-a' },
    { id: ORG_B, name: 'B', slug: 'rmw-org-b' },
  ])
  await db.insert(authUsers).values([
    { id: OWNER, name: 'Owner', email: 'rmw-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: ATTENDEE, name: 'Attendee', email: 'rmw-attendee@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  calendarA = (await db.transaction((tx) => insertCalendar(tx, { organizationId: ORG_A, ownerUserId: OWNER, name: 'A', timezone: 'Europe/Copenhagen', isDefault: true }))).id
  calendarB = (await db.transaction((tx) => insertCalendar(tx, { organizationId: ORG_B, ownerUserId: OWNER, name: 'B', timezone: 'UTC', isDefault: true }))).id
}, 60_000)

afterAll(async () => {
  await drop()
})

beforeEach(() => {
  captured = []
  sendOutcome = { ok: true, id: 'provider-ref-1' }
})

async function seedEvent(options: {
  organizationId?: string
  calendarId?: string
  title?: string
  startsAt?: Date
  status?: string
} = {}) {
  const organizationId = options.organizationId ?? ORG_A
  const startsAt = options.startsAt ?? new Date('2027-06-10T09:15:00.000Z')
  return db.transaction((tx) => insertEvent(tx, {
    organizationId,
    calendarId: options.calendarId ?? (organizationId === ORG_A ? calendarA : calendarB),
    ownerUserId: OWNER,
    type: 'personal',
    status: options.status ?? 'scheduled',
    title: options.title ?? 'Standup',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    timezone: 'Europe/Copenhagen',
    allDay: false,
    busy: true,
  }))
}

/** Arms a reminder that is already due at NOW, mirroring what `createEvent` writes. */
async function armReminder(options: {
  organizationId?: string
  eventId: string
  startsAt: Date
  offsetMinutes?: number
  channel?: string
  participantId?: string | null
}) {
  const organizationId = options.organizationId ?? ORG_A
  const offsetMinutes = options.offsetMinutes ?? 15
  const [row] = await db.transaction((tx) => insertReminders(tx, [{
    organizationId,
    eventId: options.eventId,
    participantId: options.participantId ?? null,
    channel: options.channel ?? 'email',
    offsetMinutes,
    nextFireAt: new Date(options.startsAt.getTime() - offsetMinutes * 60_000),
  }]))
  return row
}

function run(now: Date = NOW) {
  // The worker uses the WORKER role in production; the disposable DB runs as owner, so we inject
  // it directly. Tenant scoping is still exercised: withWorkerOrganization sets app.organization_id
  // and every query re-filters on organizationId.
  return runReminderWorker({ now, db, send: capturingSend() })
}

async function reminderRow(reminderId: string) {
  const [row] = await db.select().from(calendarEventReminders).where(eq(calendarEventReminders.id, reminderId))
  return row
}

async function deliveriesFor(eventId: string) {
  return db.select().from(calendarNotificationDeliveries).where(eq(calendarNotificationDeliveries.eventId, eventId))
}

describe('runReminderWorker — delivery', () => {
  it('delivers an owner reminder to the owner and marks it sent exactly once', async () => {
    const event = await seedEvent({ title: 'Owner reminder' })
    const reminder = await armReminder({ eventId: event.id, startsAt: event.startsAt })

    const result = await run()

    expect(result.delivered).toBe(1)
    expect(captured).toHaveLength(1)
    expect(captured[0].to).toBe('rmw-owner@test.invalid')
    expect(captured[0].title).toBe('Owner reminder')
    expect((await reminderRow(reminder.id)).state).toBe('sent')

    const deliveries = await deliveriesFor(event.id)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].state).toBe('sent')
    expect(deliveries[0].providerReference).toBe('provider-ref-1')
    expect(deliveries[0].recipientUserId).toBe(OWNER)
  })

  it('delivers a participant reminder to the participant, not the owner', async () => {
    const event = await seedEvent({ title: 'Participant reminder' })
    const [participant] = await db.transaction((tx) => insertParticipants(tx, [{
      organizationId: ORG_A,
      eventId: event.id,
      eventOwnerUserId: OWNER,
      userId: ATTENDEE,
      role: 'attendee',
      accessGranted: true,
    }]))
    await armReminder({ eventId: event.id, startsAt: event.startsAt, participantId: participant.id })

    await run()

    expect(captured.map((email) => email.to)).toEqual(['rmw-attendee@test.invalid'])
  })

  it('delivers to an external participant at their own address', async () => {
    const event = await seedEvent({ title: 'External reminder' })
    const [participant] = await db.transaction((tx) => insertParticipants(tx, [{
      organizationId: ORG_A,
      eventId: event.id,
      eventOwnerUserId: OWNER,
      externalEmail: 'outsider@test.invalid',
      role: 'attendee',
      accessGranted: false,
    }]))
    await armReminder({ eventId: event.id, startsAt: event.startsAt, participantId: participant.id })

    await run()

    expect(captured.map((email) => email.to)).toEqual(['outsider@test.invalid'])
    const [delivery] = await deliveriesFor(event.id)
    // The check constraint allows exactly one of the two recipient columns to be set.
    expect(delivery.recipientUserId).toBeNull()
    expect(delivery.externalRecipientHash).toBe('outsider@test.invalid')
  })

  it.each([0, 5, 10, 15, 30, 60, 1440, 10080])('delivers at the %i-minute allowed offset', async (offsetMinutes) => {
    const startsAt = new Date(NOW.getTime() + offsetMinutes * 60_000)
    const event = await seedEvent({ title: `Offset ${offsetMinutes}`, startsAt })
    const reminder = await armReminder({ eventId: event.id, startsAt, offsetMinutes })

    await run()

    expect((await reminderRow(reminder.id)).state).toBe('sent')
  })

  it.each(['email', 'in_app'])('delivers over the %s channel', async (channel) => {
    const event = await seedEvent({ title: `Channel ${channel}` })
    const reminder = await armReminder({ eventId: event.id, startsAt: event.startsAt, channel })

    await run()

    expect((await reminderRow(reminder.id)).state).toBe('sent')
  })

  it('attaches an ICS REQUEST with a stable UID and the event version as SEQUENCE', async () => {
    const event = await seedEvent({ title: 'ICS check' })
    await armReminder({ eventId: event.id, startsAt: event.startsAt })

    await run()

    const ics = captured[0].icsContent
    expect(ics).toContain('METHOD:REQUEST')
    expect(ics).toContain('SEQUENCE:0')
    expect(ics).toContain('SUMMARY:ICS check')
    // A stable UID is what makes a later CANCEL match this REQUEST instead of creating a new entry.
    const uid = /UID:(.+)/.exec(ics)?.[1]?.trim()
    expect(uid).toMatch(/^[0-9a-f]{32}@builderhunt\.dev$/)
  })
})

describe('runReminderWorker — exactly-once', () => {
  it('does not resend on a later sweep, because a sent reminder is terminal', async () => {
    const event = await seedEvent({ title: 'Twice' })
    await armReminder({ eventId: event.id, startsAt: event.startsAt })

    await run()
    await run()

    expect(captured).toHaveLength(1)
    expect(await deliveriesFor(event.id)).toHaveLength(1)
  })

  it('sends once when a second worker reads the reminder before the first commits', async () => {
    const event = await seedEvent({ title: 'Race' })
    await armReminder({ eventId: event.id, startsAt: event.startsAt })

    // A sequential double-run proves nothing about concurrency: the second sweep simply sees
    // `state = 'sent'` and skips. The only way to exercise the unique index on idempotency_key is
    // to hold the first transaction open, uncommitted, while the second one reads a still-pending
    // reminder and attempts its own claim on the same key.
    let releaseFirst: () => void = () => {}
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstReachedSend: () => void = () => {}
    const firstAtSend = new Promise<void>((resolve) => { firstReachedSend = resolve })

    const firstRun = runReminderWorker({
      now: NOW,
      db,
      send: async (to, details) => {
        captured.push({ to, title: details.title, icsContent: details.icsContent })
        firstReachedSend()
        await firstHeld
        return { ok: true, id: 'provider-ref-first' }
      },
    })

    await firstAtSend
    const secondRun = runReminderWorker({ now: NOW, db, send: capturingSend() })
    // Long enough for the second sweep to issue its read and block on the conflicting insert.
    await new Promise((resolve) => setTimeout(resolve, 150))
    releaseFirst()

    await Promise.all([firstRun, secondRun])

    expect(captured).toHaveLength(1)
    expect(await deliveriesFor(event.id)).toHaveLength(1)
  })
})

describe('runReminderWorker — suppression', () => {
  it('never sends for a cancelled event', async () => {
    const event = await seedEvent({ title: 'Cancelled' })
    const reminder = await armReminder({ eventId: event.id, startsAt: event.startsAt })
    await db.update(calendarEvents).set({ status: 'cancelled', cancelledAt: NOW }).where(eq(calendarEvents.id, event.id))

    const result = await run()

    expect(captured).toHaveLength(0)
    expect(result.suppressed).toBe(1)
    const row = await reminderRow(reminder.id)
    expect(row.state).toBe('cancelled')
    expect(row.lastErrorCode).toBe('event_cancelled')
  })

  it('never sends to a participant who has been removed', async () => {
    const event = await seedEvent({ title: 'Removed participant' })
    const [participant] = await db.transaction((tx) => insertParticipants(tx, [{
      organizationId: ORG_A,
      eventId: event.id,
      eventOwnerUserId: OWNER,
      externalEmail: 'gone@test.invalid',
      role: 'attendee',
      accessGranted: false,
    }]))
    const reminder = await armReminder({ eventId: event.id, startsAt: event.startsAt, participantId: participant.id })
    await db.delete(eventParticipants).where(eq(eventParticipants.id, participant.id))

    const result = await run()

    expect(captured).toHaveLength(0)
    expect(result.delivered).toBe(0)
    // The schema, not the worker, is what guarantees this: the reminder's composite FK to the
    // participant is ON DELETE CASCADE, so removing the attendee removes their reminders in the
    // same statement. The worker's `participant_removed` branch is a second line of defence for a
    // dangling link the FK cannot currently produce.
    expect(await reminderRow(reminder.id)).toBeUndefined()
  })

  it('never sends to a participant who declined', async () => {
    const event = await seedEvent({ title: 'Declined' })
    const [participant] = await db.transaction((tx) => insertParticipants(tx, [{
      organizationId: ORG_A,
      eventId: event.id,
      eventOwnerUserId: OWNER,
      userId: ATTENDEE,
      role: 'attendee',
      accessGranted: true,
    }]))
    await db.update(eventParticipants).set({ response: 'declined' }).where(eq(eventParticipants.id, participant.id))
    const reminder = await armReminder({ eventId: event.id, startsAt: event.startsAt, participantId: participant.id })

    await run()

    expect(captured).toHaveLength(0)
    expect((await reminderRow(reminder.id)).lastErrorCode).toBe('participant_declined')
  })

  it('never fires a reminder armed against a schedule the event has since left', async () => {
    const event = await seedEvent({ title: 'Moved' })
    const reminder = await armReminder({ eventId: event.id, startsAt: event.startsAt })
    // Move the event without re-arming — the exact out-of-band write the check exists for.
    await db.update(calendarEvents)
      .set({ startsAt: new Date('2027-06-11T09:15:00.000Z'), endsAt: new Date('2027-06-11T09:45:00.000Z') })
      .where(eq(calendarEvents.id, event.id))

    const result = await run()

    expect(captured).toHaveLength(0)
    expect(result.suppressed).toBe(1)
    expect((await reminderRow(reminder.id)).lastErrorCode).toBe('stale_schedule')
  })

  it('leaves a not-yet-due reminder untouched', async () => {
    const startsAt = new Date(NOW.getTime() + 6 * 60 * 60_000)
    const event = await seedEvent({ title: 'Future', startsAt })
    const reminder = await armReminder({ eventId: event.id, startsAt, offsetMinutes: 15 })

    await run()

    expect(captured).toHaveLength(0)
    expect((await reminderRow(reminder.id)).state).toBe('pending')
  })
})

describe('runReminderWorker — retry', () => {
  it('leaves a reminder pending after a transient failure, then delivers on the next sweep', async () => {
    const event = await seedEvent({ title: 'Transient' })
    const reminder = await armReminder({ eventId: event.id, startsAt: event.startsAt })

    sendOutcome = { ok: false, error: 'provider unavailable' }
    const failedRun = await run()

    expect(failedRun.failed).toBe(1)
    expect(failedRun.exhausted).toBe(0)
    const afterFailure = await reminderRow(reminder.id)
    expect(afterFailure.state).toBe('pending')
    expect(afterFailure.attempts).toBe(1)
    expect(afterFailure.lastErrorCode).toBe('send_failed')
    // The failed delivery row is retained so the retry recognises it as its own to redo.
    expect((await deliveriesFor(event.id))[0].state).toBe('failed')

    sendOutcome = { ok: true, id: 'provider-ref-2' }
    await run()

    expect((await reminderRow(reminder.id)).state).toBe('sent')
    const deliveries = await deliveriesFor(event.id)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].state).toBe('sent')
  })

  it('stops retrying at the attempt cap', async () => {
    const event = await seedEvent({ title: 'Exhausted' })
    const reminder = await armReminder({ eventId: event.id, startsAt: event.startsAt })
    sendOutcome = { ok: false, error: 'provider unavailable' }

    for (let attempt = 0; attempt < MAX_REMINDER_ATTEMPTS; attempt += 1) await run()

    const row = await reminderRow(reminder.id)
    expect(row.state).toBe('failed')
    expect(row.attempts).toBe(MAX_REMINDER_ATTEMPTS)

    // A run after the cap must not produce another send.
    const sendsBefore = captured.length
    await run()
    expect(captured).toHaveLength(sendsBefore)
  })

  it('records a redacted error code, never the provider message', async () => {
    const event = await seedEvent({ title: 'Redacted' })
    await armReminder({ eventId: event.id, startsAt: event.startsAt })
    sendOutcome = { ok: false, error: 'smtp://user:hunter2@mail.internal refused connection' }

    await run()

    const [delivery] = await deliveriesFor(event.id)
    expect(delivery.errorCode).toBe('send_failed')
    expect(JSON.stringify(delivery)).not.toContain('hunter2')
  })
})

describe('runReminderWorker — isolation and bookkeeping', () => {
  it('processes each tenant in its own transaction and never crosses them', async () => {
    const eventA = await seedEvent({ organizationId: ORG_A, title: 'Tenant A' })
    const eventB = await seedEvent({ organizationId: ORG_B, title: 'Tenant B' })
    await armReminder({ organizationId: ORG_A, eventId: eventA.id, startsAt: eventA.startsAt })
    await armReminder({ organizationId: ORG_B, eventId: eventB.id, startsAt: eventB.startsAt })

    await run()

    const deliveriesA = await deliveriesFor(eventA.id)
    const deliveriesB = await deliveriesFor(eventB.id)
    expect(deliveriesA).toHaveLength(1)
    expect(deliveriesB).toHaveLength(1)
    expect(deliveriesA[0].organizationId).toBe(ORG_A)
    expect(deliveriesB[0].organizationId).toBe(ORG_B)
  })

  it('opens and closes a job run for every sweep', async () => {
    const before = (await db.select().from(jobRuns).where(eq(jobRuns.jobKey, REMINDER_JOB_KEY))).length

    await run()

    const runs = await db.select().from(jobRuns).where(eq(jobRuns.jobKey, REMINDER_JOB_KEY))
    expect(runs.length).toBe(before + 1)
    // Every row is closed, including the ones the retry tests above deliberately failed — a
    // half-open `running` row is the failure this assertion exists to catch.
    for (const row of runs) {
      expect(['succeeded', 'failed']).toContain(row.state)
      expect(row.finishedAt).not.toBeNull()
      expect(row.durationMs).not.toBeNull()
    }
    // This sweep itself had nothing to deliver and nothing to fail.
    const latest = runs.sort((a, b) => b.scheduledFor.getTime() - a.scheduledFor.getTime())[0]
    expect(latest.state).toBe('succeeded')
  })
})
