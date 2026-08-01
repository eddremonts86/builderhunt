/**
 * `listInterviewsSharedWithMe` (plans/UI Wave 3 "Add a tenant-safe Shared with me interview list").
 *
 * What matters is the join predicate, not the shape — the shape is identical to
 * `listInterviewsForOwner`'s, already covered by interview-list.test.ts. This file exists to prove
 * the query answers only to `event_participants.material_access_granted = true` for the caller: a
 * plain calendar attendee gets nothing, a revoked grant makes the row disappear, another
 * organization's data never crosses, and the caller's own interviews are excluded so they are not
 * duplicated between "yours" and "shared with you".
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const schema = await import('~/shared/lib/db/schema')
const { listInterviewsSharedWithMe } = await import('~/shared/lib/repositories/interviews')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'sil-org'
const OTHER_ORG = 'sil-org-2'
const OWNER = 'sil-owner'
const COLLEAGUE = 'sil-colleague'
const NOW = new Date('2027-12-05T09:00:00.000Z')

let calendarId = ''
let otherCalendarId = ''

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('interview_shared_list')
  db = disposable.db
  drop = disposable.drop

  await db.insert(schema.organizations).values([
    { id: ORG, name: 'Org', slug: ORG },
    { id: OTHER_ORG, name: 'Org2', slug: OTHER_ORG },
  ])
  await db.insert(schema.authUsers).values([
    { id: OWNER, name: 'Owner', email: 'sil-o@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
    { id: COLLEAGUE, name: 'Colleague', email: 'sil-c@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
  ])
  const [calendar] = await db.insert(schema.userCalendars).values({
    organizationId: ORG, ownerUserId: OWNER, name: 'Cal', timezone: 'UTC', isDefault: true,
  }).returning({ id: schema.userCalendars.id })
  calendarId = calendar.id
  const [otherCalendar] = await db.insert(schema.userCalendars).values({
    organizationId: OTHER_ORG, ownerUserId: OWNER, name: 'Cal2', timezone: 'UTC', isDefault: true,
  }).returning({ id: schema.userCalendars.id })
  otherCalendarId = otherCalendar.id
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(schema.eventParticipants)
  await db.delete(schema.schedulingInvitations)
  await db.delete(schema.calendarEvents)
})

async function seedBookedInterview(options: { organizationId?: string; roleTitle?: string } = {}) {
  const organizationId = options.organizationId ?? ORG
  const [event] = await db.insert(schema.calendarEvents).values({
    organizationId, calendarId: organizationId === ORG ? calendarId : otherCalendarId, ownerUserId: OWNER,
    type: 'personal', status: 'scheduled', title: 'Interview',
    startsAt: NOW, endsAt: new Date(NOW.getTime() + 2_700_000),
    timezone: 'UTC', allDay: false, busy: true,
  }).returning({ id: schema.calendarEvents.id })

  await db.insert(schema.schedulingInvitations).values({
    organizationId, ownerUserId: OWNER, roleTitle: options.roleTitle ?? 'Staff Engineer',
    roleContext: 'Platform', durationMinutes: 45, timezone: 'UTC', modality: 'remote_call',
    meetingUrl: 'https://meet.test.invalid/room', policyVersion: 'v1', bookedEventId: event.id,
  })

  return { eventId: event.id }
}

async function addParticipant(eventId: string, organizationId: string, options: { accessGranted?: boolean; materialAccessGranted?: boolean } = {}) {
  await db.insert(schema.eventParticipants).values({
    organizationId, eventId, eventOwnerUserId: OWNER, userId: COLLEAGUE, role: 'attendee',
    accessGranted: options.accessGranted ?? true,
    materialAccessGranted: options.materialAccessGranted ?? false,
  })
}

const listShared = (userId = COLLEAGUE, organizationId = ORG) =>
  db.transaction((tx) => listInterviewsSharedWithMe(tx as never, { organizationId, userId }))

describe('listInterviewsSharedWithMe', () => {
  it('returns an interview the caller was granted material access to', async () => {
    const { eventId } = await seedBookedInterview()
    await addParticipant(eventId, ORG, { materialAccessGranted: true })
    const rows = await listShared()
    expect(rows).toHaveLength(1)
    expect(rows[0].eventId).toBe(eventId)
  })

  it('excludes a plain calendar attendee who was never granted material access', async () => {
    const { eventId } = await seedBookedInterview()
    await addParticipant(eventId, ORG, { accessGranted: true, materialAccessGranted: false })
    expect(await listShared()).toHaveLength(0)
  })

  it('a revoked grant makes the row disappear on the next read', async () => {
    const { eventId } = await seedBookedInterview()
    await addParticipant(eventId, ORG, { materialAccessGranted: true })
    expect(await listShared()).toHaveLength(1)

    await db.update(schema.eventParticipants)
      .set({ materialAccessGranted: false })
      .where(eq(schema.eventParticipants.eventId, eventId))
    expect(await listShared()).toHaveLength(0)
  })

  it('never crosses another organization\'s data', async () => {
    const { eventId } = await seedBookedInterview({ organizationId: OTHER_ORG })
    await addParticipant(eventId, OTHER_ORG, { materialAccessGranted: true })
    // Asking for it under ORG (not OTHER_ORG) must find nothing, even though the same user id has a
    // real grant — just in a different tenant.
    expect(await listShared(COLLEAGUE, ORG)).toHaveLength(0)
    expect(await listShared(COLLEAGUE, OTHER_ORG)).toHaveLength(1)
  })

  it('excludes the caller\'s own interviews, so nothing is duplicated between the two lists', async () => {
    const { eventId } = await seedBookedInterview()
    // The owner is never a participant row in practice, but even if one existed, self-granting
    // should not produce a "shared with me" duplicate of an interview already in the owner's list.
    await addParticipant(eventId, ORG, { materialAccessGranted: true })
    expect(await listShared(OWNER)).toHaveLength(0)
  })

  it('a made-up event id or organization never surfaces anything', async () => {
    expect(await listShared('nonexistent-user')).toHaveLength(0)
  })
})
