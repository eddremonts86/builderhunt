import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations } from '~/shared/lib/db/schema'
import { insertCalendar, insertDeliveryIfAbsent, insertEvent } from '~/shared/lib/repositories/calendar'
import { countOwnUnreadNotifications, listOwnNotifications, markOwnNotificationsRead } from '~/lib/calendar/service'

/**
 * Notification-feed behaviour (plan: calendar-scheduling-interview-intelligence, Phase 3).
 *
 * The two things worth proving here are that the feed pages without losing or repeating rows, and
 * that neither reading nor marking can reach another user's deliveries — including for an org
 * admin, who has no override path by design.
 */

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'ntf-org'
const OTHER_ORG = 'ntf-other-org'
const ALICE = 'ntf-alice'
const BOB = 'ntf-bob'
const ADMIN = 'ntf-admin'
let eventId: string
let otherOrgEventId: string

function principal(userId: string, role: TenantPrincipal['role'] = 'member', organizationId = ORG): TenantPrincipal {
  return { userId, organizationId, role, requestId: 'req-test' }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('calendar_notifications')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([
    { id: ORG, name: 'Ntf', slug: 'ntf-org' },
    { id: OTHER_ORG, name: 'Other', slug: 'ntf-other-org' },
  ])
  await db.insert(authUsers).values([
    { id: ALICE, name: 'Alice', email: 'ntf-alice@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: BOB, name: 'Bob', email: 'ntf-bob@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: ADMIN, name: 'Admin', email: 'ntf-admin@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])

  const calendar = await db.transaction((tx) => insertCalendar(tx, { organizationId: ORG, ownerUserId: ALICE, name: 'Cal', timezone: 'UTC', isDefault: true }))
  const event = await db.transaction((tx) => insertEvent(tx, {
    organizationId: ORG, calendarId: calendar.id, ownerUserId: ALICE, type: 'personal', status: 'scheduled',
    title: 'Anchor', startsAt: new Date('2027-08-01T09:00:00.000Z'), endsAt: new Date('2027-08-01T09:30:00.000Z'),
    timezone: 'UTC', allDay: false, busy: true,
  }))
  eventId = event.id

  const otherCalendar = await db.transaction((tx) => insertCalendar(tx, { organizationId: OTHER_ORG, ownerUserId: ALICE, name: 'Other cal', timezone: 'UTC', isDefault: true }))
  const otherEvent = await db.transaction((tx) => insertEvent(tx, {
    organizationId: OTHER_ORG, calendarId: otherCalendar.id, ownerUserId: ALICE, type: 'personal', status: 'scheduled',
    title: 'Other tenant', startsAt: new Date('2027-08-01T09:00:00.000Z'), endsAt: new Date('2027-08-01T09:30:00.000Z'),
    timezone: 'UTC', allDay: false, busy: true,
  }))
  otherOrgEventId = otherEvent.id
}, 60_000)

afterAll(async () => {
  await drop()
})

async function seedDelivery(recipientUserId: string, key: string, options: { organizationId?: string } = {}) {
  const organizationId = options.organizationId ?? ORG
  const row = await db.transaction((tx) => insertDeliveryIfAbsent(tx, {
    organizationId,
    eventId: organizationId === ORG ? eventId : otherOrgEventId,
    kind: 'reminder',
    recipientUserId,
    idempotencyKey: key,
  }))
  if (!row) throw new Error(`delivery ${key} was not created`)
  return row
}

describe('listOwnNotifications', () => {
  it('pages newest-first without losing or repeating a row', async () => {
    const created = []
    for (let index = 0; index < 5; index += 1) created.push(await seedDelivery(ALICE, `page-${index}`))

    const firstPage = await db.transaction((tx) => listOwnNotifications(tx, principal(ALICE), { limit: 2 }))
    expect(firstPage.deliveries).toHaveLength(2)
    expect(firstPage.nextCursor).not.toBeNull()

    const secondPage = await db.transaction((tx) => listOwnNotifications(tx, principal(ALICE), { limit: 2, cursor: firstPage.nextCursor }))
    const thirdPage = await db.transaction((tx) => listOwnNotifications(tx, principal(ALICE), { limit: 2, cursor: secondPage.nextCursor }))

    const seen = [...firstPage.deliveries, ...secondPage.deliveries, ...thirdPage.deliveries].map((row) => row.id)
    // Every seeded delivery appears exactly once across the three pages.
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(5)
    expect(new Set(seen)).toEqual(new Set(created.map((row) => row.id)))
    expect(thirdPage.nextCursor).toBeNull()
  })

  it('does not skip a row when two deliveries share a timestamp', async () => {
    // The `id` tiebreak in the keyset exists for exactly this: a bare timestamp cursor would
    // place both rows at the same boundary and drop one of them.
    const a = await seedDelivery(BOB, 'tie-a')
    const b = await seedDelivery(BOB, 'tie-b')
    await db.execute(
      `update calendar_notification_deliveries set created_at = '2027-09-09 10:00:00+00' where id in ('${a.id}', '${b.id}')`,
    )

    const first = await db.transaction((tx) => listOwnNotifications(tx, principal(BOB), { limit: 1 }))
    const second = await db.transaction((tx) => listOwnNotifications(tx, principal(BOB), { limit: 1, cursor: first.nextCursor }))

    expect([...first.deliveries, ...second.deliveries].map((row) => row.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('never returns another user\'s deliveries, not even to an org admin', async () => {
    await seedDelivery(ALICE, 'private-to-alice')

    const asAdmin = await db.transaction((tx) => listOwnNotifications(tx, principal(ADMIN, 'admin'), { limit: 100 }))

    // The admin has no elevation path here on purpose — a delivery has exactly one recipient.
    expect(asAdmin.deliveries).toHaveLength(0)
  })

  it('never crosses tenants for the same user', async () => {
    const foreign = await seedDelivery(ALICE, 'other-tenant', { organizationId: OTHER_ORG })

    const inOrg = await db.transaction((tx) => listOwnNotifications(tx, principal(ALICE), { limit: 100 }))

    expect(inOrg.deliveries.map((row) => row.id)).not.toContain(foreign.id)
  })
})

describe('markOwnNotificationsRead', () => {
  it('marks the caller\'s own deliveries and lowers the unread count', async () => {
    const delivery = await seedDelivery(ALICE, 'mark-mine')

    const before = await db.transaction((tx) => countOwnUnreadNotifications(tx, principal(ALICE)))
    const result = await db.transaction((tx) => markOwnNotificationsRead(tx, principal(ALICE), [delivery.id]))
    const after = await db.transaction((tx) => countOwnUnreadNotifications(tx, principal(ALICE)))

    expect(result.markedIds).toEqual([delivery.id])
    expect(after).toBe(before - 1)
  })

  it('silently leaves another user\'s delivery unmarked rather than reporting it exists', async () => {
    const bobs = await seedDelivery(BOB, 'mark-bobs')

    const result = await db.transaction((tx) => markOwnNotificationsRead(tx, principal(ALICE), [bobs.id]))

    // Not an error and not a "forbidden" — an id the caller does not own is indistinguishable from
    // one that was never issued, so a prober learns nothing from the response.
    expect(result.markedIds).toEqual([])
    const bobUnread = await db.transaction((tx) => countOwnUnreadNotifications(tx, principal(BOB)))
    expect(bobUnread).toBeGreaterThan(0)
  })

  it('marks only the ids the caller listed, never everything', async () => {
    const keep = await seedDelivery(ALICE, 'keep-unread')
    const mark = await seedDelivery(ALICE, 'mark-this-one')

    const result = await db.transaction((tx) => markOwnNotificationsRead(tx, principal(ALICE), [mark.id]))

    expect(result.markedIds).toEqual([mark.id])
    const feed = await db.transaction((tx) => listOwnNotifications(tx, principal(ALICE), { limit: 100 }))
    expect(feed.deliveries.find((row) => row.id === keep.id)?.readAt).toBeNull()
  })
})
