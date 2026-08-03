/**
 * `GET` / `PATCH /api/calendar/notifications` (plan 53, task 10 — the last API route without an e2e spec).
 *
 * The feed is scoped to `principal.userId` inside the service, with no admin override anywhere in the path, and the
 * route's own doc names the two properties worth proving:
 *
 * - **"An id the caller does not own simply comes back unmarked — the response never distinguishes 'not yours' from
 *   'does not exist'."** So a foreign delivery id and a fabricated one must produce identical responses, and the
 *   foreign row must still be unread afterwards. `{ ok: … }` over a completed write would look the same from outside.
 * - **The cursor is opaque but deliberately not encrypted**, because "a forged cursor can move the caller's own
 *   window around and nothing else — the query still filters on their user id". That is a claim about what a forged
 *   cursor *cannot* do, and the only way to check it is to forge one from another user's row and see nothing of
 *   theirs come back.
 *
 * A delivery cannot be seeded alone: `calendar_notification_deliveries_anchor_check` requires every row to hang off
 * an event or an invitation. The event is created through the real `POST /api/calendar/events` rather than by
 * inserting `calendars` + `calendar_events` by hand — fewer schema facts to get right, and the anchor is then a row
 * the product itself produced.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { randomUUID } from 'node:crypto'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../harness/cache'
import { startWorkerServer, stopWorkerServer } from '../harness/server'
import { e2eEnv } from '../harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from '../harness/clock'
import { createOwnerPrincipal, type FixtureContext, type Principal } from '../harness/fixtures/principals'
import type { OrganizationFixture } from '../harness/fixtures/organizations'
import { seedConsent } from '../harness/fixtures/privacy'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'

interface Tenant {
  principal: Principal
  organization: OrganizationFixture
}

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  a: Tenant
  b: Tenant
  anonymous: APIRequestContext
}

let harness: Harness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  expect(e2eEnv().E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}calnotif` }
    const clock = fixedClockFromEnv()

    const tenants: Tenant[] = []
    for (let index = 0; index < 2; index += 1) {
      const { principal, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
      await seedConsent(sql, { userId: principal.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })
      tenants.push({ principal, organization })
    }

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      a: tenants[0]!,
      b: tenants[1]!,
      anonymous: await playwrightRequest.newContext({ baseURL: server.baseURL }),
    }
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  await harness?.anonymous.dispose().catch(() => undefined)
  await harness?.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(harness.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(harness.workerIndex, harness.databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(harness.redisPrefix).catch(() => undefined)
})

/**
 * Creates a real event through the product's own route, so the delivery below has a legitimate anchor.
 *
 * Each call gets its own hour: the route answers `409 overlap_warning` for an event that overlaps an existing one, so
 * a fixed time slot means the second event in a file fails and takes the test with it — which is how the first draft
 * of this spec failed, on event creation rather than on anything it meant to assert.
 */
let eventHourCursor = 0
async function createEvent(tenant: Tenant, title: string): Promise<string> {
  const hour = eventHourCursor
  eventHourCursor += 1
  const base = Date.UTC(2026, 8, 1 + Math.floor(hour / 12), 8 + (hour % 12))
  const startsAt = new Date(base).toISOString()
  const endsAt = new Date(base + 30 * 60 * 1000).toISOString()
  const response = await tenant.principal.api!.post('/api/calendar/events', {
    data: {
      type: 'personal',
      title,
      startsAt,
      endsAt,
      timezone: 'Europe/Madrid',
      allDay: false,
      busy: true,
      reminders: [],
      participants: [],
    },
  })
  expect(response.status(), await response.text()).toBe(201)
  const body = await response.json() as { event: { id: string } }
  return body.event.id
}

/** Inserts one delivery for `tenant`'s own user, anchored to a real event. */
async function seedDelivery(tenant: Tenant, label: string, readAt: Date | null = null): Promise<string> {
  const eventId = await createEvent(tenant, `e2e notif ${label}`)
  const deliveryId = randomUUID()
  await harness.sql`
    insert into calendar_notification_deliveries
      (id, organization_id, event_id, kind, recipient_user_id, idempotency_key, state, delivered_at, read_at)
    values (${deliveryId}, ${tenant.organization.organizationId}, ${eventId}, 'reminder',
            ${tenant.principal.userId!}, ${`e2e-notif-${randomUUID()}`}, 'sent', now(), ${readAt})
  `
  return deliveryId
}

interface Delivery {
  id: string
  kind: string
  readAt: string | null
}

test.describe('GET /api/calendar/notifications', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.get('/api/calendar/notifications')
    expect(response.status()).toBe(401)
  })

  test('lists the caller\'s own deliveries and not the other tenant\'s', async () => {
    const mine = await seedDelivery(harness.a, 'mine')
    const theirs = await seedDelivery(harness.b, 'theirs')

    const response = await harness.a.principal.api!.get('/api/calendar/notifications')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as { deliveries: Delivery[]; nextCursor: string | null }
    const ids = body.deliveries.map((row) => row.id)

    expect(ids).toContain(mine)
    expect(ids).not.toContain(theirs)
  })

  test('rejects a malformed cursor with 400 rather than silently ignoring it', async () => {
    // A cursor that cannot be decoded is a client bug; answering the first page instead would hide it and make a
    // paginating client loop over page one forever.
    const response = await harness.a.principal.api!.get('/api/calendar/notifications?cursor=not-a-cursor')
    expect(response.status(), await response.text()).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_input' })
  })

  test('a cursor forged from another user\'s row still returns nothing of theirs', async () => {
    /**
     * The claim the opaque-but-unencrypted cursor rests on: "a forged cursor can move the caller's own window around
     * and nothing else, because the query still filters on their user id".
     *
     * So a cursor is built by hand in the documented `<epoch-millis>.<uuid>` format out of B's own delivery row —
     * exactly what an attacker who guessed the format would do — and A must still see only A's rows.
     */
    const theirs = await seedDelivery(harness.b, 'forged-target')
    const [row] = await harness.sql`
      select created_at from calendar_notification_deliveries where id = ${theirs}
    `
    const forged = `${new Date(row.created_at).getTime()}.${theirs}`

    const response = await harness.a.principal.api!.get(
      `/api/calendar/notifications?cursor=${encodeURIComponent(forged)}`,
    )
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as { deliveries: Delivery[] }
    expect(body.deliveries.map((entry) => entry.id), 'a forged cursor must not widen the scope').not.toContain(theirs)
  })
})

test.describe('PATCH /api/calendar/notifications', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.fetch('/api/calendar/notifications', {
      method: 'PATCH',
      data: { deliveryIds: [randomUUID()] },
    })
    expect(response.status()).toBe(401)
  })

  test('refuses an empty id list — there is no "mark everything" switch', async () => {
    // Documented on the route: mark-read takes an explicit id list rather than a blanket flag, so an empty list is a
    // client mistake and not an instruction to clear the whole feed.
    const response = await harness.a.principal.api!.fetch('/api/calendar/notifications', {
      method: 'PATCH',
      data: { deliveryIds: [] },
    })
    expect(response.status(), await response.text()).toBe(400)
  })

  test('marks the caller\'s own delivery read', async () => {
    const mine = await seedDelivery(harness.a, `readable-${randomUUID().slice(0, 6)}`)
    const response = await harness.a.principal.api!.fetch('/api/calendar/notifications', {
      method: 'PATCH',
      data: { deliveryIds: [mine] },
    })
    expect(response.status(), await response.text()).toBe(200)

    const [row] = await harness.sql`select read_at from calendar_notification_deliveries where id = ${mine}`
    expect(row.read_at, 'the row must actually be marked, not just reported as marked').not.toBeNull()
  })

  test('a foreign id is indistinguishable from a fabricated one, and stays unread', async () => {
    /**
     * The route's own words: "an id the caller does not own simply comes back unmarked — the response never
     * distinguishes 'not yours' from 'does not exist'". Compared as whole responses, since a differing status would
     * separate the two cases just as effectively as a differing body, and then checked against the database because a
     * response saying "unmarked" over a completed write would look identical from outside.
     */
    const theirs = await seedDelivery(harness.b, `foreign-${randomUUID().slice(0, 6)}`)
    const fabricated = randomUUID()

    const [foreign, absent] = await Promise.all([
      harness.a.principal.api!.fetch('/api/calendar/notifications', { method: 'PATCH', data: { deliveryIds: [theirs] } }),
      harness.a.principal.api!.fetch('/api/calendar/notifications', { method: 'PATCH', data: { deliveryIds: [fabricated] } }),
    ])

    expect(foreign.status()).toBe(absent.status())
    expect(await foreign.json()).toEqual(await absent.json())

    const [row] = await harness.sql`select read_at from calendar_notification_deliveries where id = ${theirs}`
    expect(row.read_at, 'B\'s notification must still be unread after A tried to mark it').toBeNull()
  })
})
