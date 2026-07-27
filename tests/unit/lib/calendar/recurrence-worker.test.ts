import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, calendarEventOccurrences, calendarEvents, jobRuns, organizations } from '~/shared/lib/db/schema'
import { insertCalendar, insertEvent } from '~/shared/lib/repositories/calendar'
import { RECURRENCE_JOB_KEY, runRecurrenceWorker } from '~/lib/calendar/recurrence-worker'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG_A = 'rw-org-a'
const ORG_B = 'rw-org-b'
const OWNER = 'rw-owner'
const NOW = new Date('2027-03-01T00:00:00.000Z')

let calendarA: string
let calendarB: string

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('calendar_recurrence_worker')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([
    { id: ORG_A, name: 'A', slug: 'rw-org-a' },
    { id: ORG_B, name: 'B', slug: 'rw-org-b' },
  ])
  await db.insert(authUsers).values({
    id: OWNER, name: 'Owner', email: 'rw-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
  calendarA = (await db.transaction((tx) => insertCalendar(tx, { organizationId: ORG_A, ownerUserId: OWNER, name: 'A', timezone: 'Europe/Copenhagen', isDefault: true }))).id
  calendarB = (await db.transaction((tx) => insertCalendar(tx, { organizationId: ORG_B, ownerUserId: OWNER, name: 'B', timezone: 'UTC', isDefault: true }))).id
}, 60_000)

afterAll(async () => {
  await drop()
})

async function seedRecurring(organizationId: string, calendarId: string, rrule: string, title: string, startsAt: Date) {
  return db.transaction((tx) => insertEvent(tx, {
    organizationId,
    calendarId,
    ownerUserId: OWNER,
    type: 'personal',
    status: 'scheduled',
    title,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    timezone: organizationId === ORG_A ? 'Europe/Copenhagen' : 'UTC',
    allDay: false,
    busy: true,
    rrule,
  }))
}

function run() {
  // The worker uses the WORKER role in production; the disposable DB runs as owner, so we inject
  // it directly. Tenant scoping is still exercised: withWorkerOrganization sets app.organization_id
  // and every query re-filters on organizationId.
  return runRecurrenceWorker({ now: NOW, db, pastDays: 7, futureDays: 60 })
}

async function occurrencesFor(eventId: string) {
  return db.select().from(calendarEventOccurrences).where(eq(calendarEventOccurrences.eventId, eventId))
}

describe('runRecurrenceWorker', () => {
  it('expands a weekly rule into concrete occurrences within the horizon', async () => {
    const event = await seedRecurring(ORG_A, calendarA, 'FREQ=WEEKLY;BYDAY=MO', 'Weekly', new Date('2027-03-01T08:00:00.000Z'))
    await run()

    const rows = await occurrencesFor(event.id)
    expect(rows.length).toBeGreaterThan(4)
    for (const row of rows) {
      expect(row.startsAt.getTime()).toBeGreaterThanOrEqual(new Date('2027-02-22T00:00:00.000Z').getTime())
      expect(row.startsAt.getTime()).toBeLessThanOrEqual(new Date('2027-05-01T00:00:00.000Z').getTime())
      expect(row.status).toBe('active')
    }
  })

  it('is idempotent — a second run converges on the identical occurrence set', async () => {
    const event = await seedRecurring(ORG_A, calendarA, 'FREQ=DAILY;COUNT=5', 'Daily', new Date('2027-03-02T08:00:00.000Z'))
    await run()
    const first = (await occurrencesFor(event.id)).map((r) => r.recurrenceId).sort()

    await run()
    const second = (await occurrencesFor(event.id)).map((r) => r.recurrenceId).sort()

    expect(second).toEqual(first)
    expect(second.length).toBe(5)
  })

  it('concurrent runs still converge without duplicating rows', async () => {
    const event = await seedRecurring(ORG_A, calendarA, 'FREQ=DAILY;COUNT=4', 'Concurrent', new Date('2027-03-03T08:00:00.000Z'))
    await Promise.all([run(), run()])

    const ids = (await occurrencesFor(event.id)).map((r) => r.recurrenceId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(4)
  })

  it('prunes future occurrences the current rule no longer produces', async () => {
    const event = await seedRecurring(ORG_A, calendarA, 'FREQ=DAILY;COUNT=10', 'Shrinking', new Date('2027-03-04T08:00:00.000Z'))
    await run()
    expect(await occurrencesFor(event.id)).toHaveLength(10)

    // The organizer shortens the series; the next sweep must drop the extra tail.
    await db.update(calendarEvents).set({ rrule: 'FREQ=DAILY;COUNT=3' }).where(eq(calendarEvents.id, event.id))
    await run()
    expect(await occurrencesFor(event.id)).toHaveLength(3)
  })

  it('never prunes an occurrence in the past, even when the rule shrinks', async () => {
    const event = await seedRecurring(ORG_A, calendarA, 'FREQ=DAILY;COUNT=10', 'Historic', new Date('2027-02-24T08:00:00.000Z'))
    await run()
    const before = await occurrencesFor(event.id)
    const past = before.filter((r) => r.startsAt < NOW)
    expect(past.length).toBeGreaterThan(0)

    // Remove the rule entirely — every future occurrence goes, history stays.
    await db.update(calendarEvents).set({ rrule: 'FREQ=DAILY;COUNT=1' }).where(eq(calendarEvents.id, event.id))
    await run()

    const after = await occurrencesFor(event.id)
    const survivingPast = after.filter((r) => r.startsAt < NOW).map((r) => r.recurrenceId).sort()
    expect(survivingPast).toEqual(past.map((r) => r.recurrenceId).sort())
  })

  it('drops the whole materialization once an event is cancelled', async () => {
    const event = await seedRecurring(ORG_A, calendarA, 'FREQ=DAILY;COUNT=6', 'To Cancel', new Date('2027-03-05T08:00:00.000Z'))
    await run()
    expect((await occurrencesFor(event.id)).length).toBeGreaterThan(0)

    await db.update(calendarEvents).set({ status: 'cancelled', cancelledAt: new Date() }).where(eq(calendarEvents.id, event.id))
    await run()
    expect(await occurrencesFor(event.id)).toHaveLength(0)
  })

  it('respects recurrenceUntil as a narrower bound than the horizon', async () => {
    const event = await seedRecurring(ORG_A, calendarA, 'FREQ=DAILY', 'Bounded', new Date('2027-03-06T08:00:00.000Z'))
    await db.update(calendarEvents).set({ recurrenceUntil: new Date('2027-03-09T00:00:00.000Z') }).where(eq(calendarEvents.id, event.id))
    await run()

    const rows = await occurrencesFor(event.id)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.startsAt.getTime()).toBeLessThan(new Date('2027-03-09T00:00:00.000Z').getTime())
    }
  })

  it('ignores non-recurring events entirely', async () => {
    const oneOff = await db.transaction((tx) => insertEvent(tx, {
      organizationId: ORG_A, calendarId: calendarA, ownerUserId: OWNER, type: 'personal', status: 'scheduled',
      title: 'One Off', startsAt: new Date('2027-03-10T08:00:00.000Z'), endsAt: new Date('2027-03-10T09:00:00.000Z'),
      timezone: 'Europe/Copenhagen', allDay: false, busy: true,
    }))
    await run()
    expect(await occurrencesFor(oneOff.id)).toHaveLength(0)
  })

  it('keeps tenants isolated — each event materializes only under its own organization', async () => {
    const a = await seedRecurring(ORG_A, calendarA, 'FREQ=DAILY;COUNT=3', 'Tenant A', new Date('2027-03-11T08:00:00.000Z'))
    const b = await seedRecurring(ORG_B, calendarB, 'FREQ=DAILY;COUNT=3', 'Tenant B', new Date('2027-03-11T08:00:00.000Z'))
    await run()

    const aRows = await occurrencesFor(a.id)
    const bRows = await occurrencesFor(b.id)
    expect(aRows.every((r) => r.organizationId === ORG_A)).toBe(true)
    expect(bRows.every((r) => r.organizationId === ORG_B)).toBe(true)
  })

  it('records a job run with counters and no leaked error detail', async () => {
    const result = await run()
    expect(result.organizationsProcessed).toBeGreaterThanOrEqual(2)

    const runs = await db.select().from(jobRuns).where(eq(jobRuns.jobKey, RECURRENCE_JOB_KEY))
    expect(runs.length).toBeGreaterThan(0)
    const latest = runs[runs.length - 1]
    expect(['succeeded', 'failed']).toContain(latest.state)
    expect(latest.finishedAt).not.toBeNull()
    expect(latest.durationMs).toBeGreaterThanOrEqual(0)
    // Whatever happened, the persisted code is a short slug, never a message or stack.
    if (latest.errorCode) expect(latest.errorCode.length).toBeLessThan(64)
  })

  it('preserves the local wall-clock time across a DST transition', async () => {
    // Europe/Copenhagen springs forward on 2027-03-28. A 09:00-local daily event must stay
    // 09:00 local, so its UTC instant shifts from 08:00Z to 07:00Z.
    const event = await seedRecurring(ORG_A, calendarA, 'FREQ=DAILY', 'DST', new Date('2027-03-26T08:00:00.000Z'))
    await runRecurrenceWorker({ now: new Date('2027-03-26T00:00:00.000Z'), db, pastDays: 1, futureDays: 7 })

    const rows = await occurrencesFor(event.id)
    const before = rows.find((r) => r.recurrenceId.startsWith('2027-03-27'))
    const after = rows.find((r) => r.recurrenceId.startsWith('2027-03-29'))
    expect(before?.startsAt.toISOString()).toBe('2027-03-27T08:00:00.000Z')
    expect(after?.startsAt.toISOString()).toBe('2027-03-29T07:00:00.000Z')
  })
})
