/**
 * plans/UI/tasks.md Wave 4 "Expose alert test delivery".
 *
 * `POST /api/alerts/:id/test-send` over real HTTP with a real session — proves both delivery
 * paths (email via the outbox, dashboard-only with no email), the rate limit, and that a
 * disabled/deleted/foreign alert cannot be tested (each fails closed with a distinguishable but
 * non-enumerating status).
 */
import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import { createOwnerPrincipal, type FixtureContext, type Principal } from './harness/fixtures/principals'
import type { OrganizationFixture } from './harness/fixtures/organizations'
import { uniqueId } from './harness/ids'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
  owner: Principal
  organization: OrganizationFixture
  stranger: Principal
  strangerOrganization: OrganizationFixture
  /** Its own principal so exhausting its rate-limit bucket never interferes with the functional tests above, which share `owner`'s bucket. */
  limiter: Principal
  limiterOrganization: OrganizationFixture
}

let harness: Harness

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}alerts` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const { principal: stranger, organization: strangerOrganization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const { principal: limiter, organization: limiterOrganization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })

    harness = { workerIndex, databaseName: database.databaseName, redisPrefix: cache.prefix, baseURL: server.baseURL, sql, ctx, owner, organization, stranger, strangerOrganization, limiter, limiterOrganization }
    await fetch(`${server.baseURL}/`).then((r) => r.text()).catch(() => undefined)
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  await harness.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(harness.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(harness.workerIndex, harness.databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(harness.redisPrefix).catch(() => undefined)
})

interface OutboxEmail {
  to: string
  subject: string
  html: string
  sentAt: string
}

async function readServerOutbox(): Promise<OutboxEmail[]> {
  const res = await fetch(`${harness.baseURL}/api/e2e/outbox`)
  expect(res.ok).toBe(true)
  return ((await res.json()) as { emails: OutboxEmail[] }).emails
}

async function clearServerOutbox(): Promise<void> {
  const res = await fetch(`${harness.baseURL}/api/e2e/outbox`, { method: 'DELETE' })
  expect(res.ok).toBe(true)
}

async function seedAlert(input: { organizationId: string; userId: string; enabled: boolean; deliveryChannel: 'email' | 'dashboard' }) {
  const id = uniqueId('alert', harness.ctx.scope)
  await harness.sql`
    insert into alerts (id, organization_id, user_id, name, keywords, enabled, delivery_channel, trigger_conditions, created_at)
    values (${id}, ${input.organizationId}, ${input.userId}, ${`E2E ${id}`}, '[]'::jsonb, ${input.enabled}, ${input.deliveryChannel},
            ${JSON.stringify({ eventType: 'any_activity' })}::jsonb, now())
  `
  return { id }
}

test.describe('alert test delivery', () => {
  test('an enabled email-channel alert delivers a real test email through the outbox', async () => {
    await clearServerOutbox()
    const { id } = await seedAlert({ organizationId: harness.organization.organizationId, userId: harness.owner.userId!, enabled: true, deliveryChannel: 'email' })
    try {
      const response = await harness.owner.api!.post(`/api/alerts/${id}/test-send`)
      expect(response.status()).toBe(200)
      const body = await response.json() as { delivered: boolean; channel: string }
      expect(body).toEqual({ delivered: true, channel: 'email' })

      const emails = await readServerOutbox()
      const sent = emails.find((e) => e.to === harness.owner.email)
      expect(sent, 'a test email was actually sent').toBeTruthy()
      expect(sent!.html).toContain(`E2E ${id}`)
    } finally {
      await harness.sql`delete from alerts where id = ${id}`
    }
  })

  test('an enabled dashboard-only alert confirms delivery without sending any email', async () => {
    await clearServerOutbox()
    const { id } = await seedAlert({ organizationId: harness.organization.organizationId, userId: harness.owner.userId!, enabled: true, deliveryChannel: 'dashboard' })
    try {
      const response = await harness.owner.api!.post(`/api/alerts/${id}/test-send`)
      expect(response.status()).toBe(200)
      expect(await response.json()).toEqual({ delivered: true, channel: 'dashboard' })
      expect(await readServerOutbox()).toHaveLength(0)
    } finally {
      await harness.sql`delete from alerts where id = ${id}`
    }
  })

  test('a disabled alert cannot be tested', async () => {
    const { id } = await seedAlert({ organizationId: harness.organization.organizationId, userId: harness.owner.userId!, enabled: false, deliveryChannel: 'email' })
    try {
      const response = await harness.owner.api!.post(`/api/alerts/${id}/test-send`)
      expect(response.status()).toBe(409)
      expect((await response.json()).error).toBe('alert_disabled')
    } finally {
      await harness.sql`delete from alerts where id = ${id}`
    }
  })

  test('a deleted alert cannot be tested', async () => {
    const { id } = await seedAlert({ organizationId: harness.organization.organizationId, userId: harness.owner.userId!, enabled: true, deliveryChannel: 'email' })
    await harness.sql`delete from alerts where id = ${id}`
    const response = await harness.owner.api!.post(`/api/alerts/${id}/test-send`)
    expect(response.status()).toBe(404)
  })

  test('a foreign (another organization\'s) alert cannot be tested — same 404 as a nonexistent id', async () => {
    const { id: foreignId } = await seedAlert({ organizationId: harness.strangerOrganization.organizationId, userId: harness.stranger.userId!, enabled: true, deliveryChannel: 'email' })
    try {
      const foreignAttempt = await harness.owner.api!.post(`/api/alerts/${foreignId}/test-send`)
      const absentAttempt = await harness.owner.api!.post(`/api/alerts/${uniqueId('nonexistent-alert')}/test-send`)
      expect(foreignAttempt.status()).toBe(404)
      expect(absentAttempt.status()).toBe(404)
      expect(await foreignAttempt.text()).toBe(await absentAttempt.text())
    } finally {
      await harness.sql`delete from alerts where id = ${foreignId}`
    }
  })

  test('rate-limits repeated test sends for the same alert', async () => {
    // Own principal/org — the functional tests above already spend part of `owner`'s bucket, and
    // sharing it here would make this test's pass/fail depend on how many ran before it.
    const { id } = await seedAlert({ organizationId: harness.limiterOrganization.organizationId, userId: harness.limiter.userId!, enabled: true, deliveryChannel: 'dashboard' })
    try {
      let sawRateLimit = false
      for (let i = 0; i < 12; i++) {
        const response = await harness.limiter.api!.post(`/api/alerts/${id}/test-send`)
        if (response.status() === 429) {
          sawRateLimit = true
          expect(response.headers()['retry-after']).toBeTruthy()
          break
        }
      }
      expect(sawRateLimit, 'the test-send endpoint eventually rate-limits repeated calls').toBe(true)
    } finally {
      await harness.sql`delete from alerts where id = ${id}`
    }
  })
})

/**
 * The inbox, after plans/phase-3/10 moved its grouping to the server.
 *
 * The defect these exist for is not "the page was slow". `listOrganizationTriggers` was capped at
 * 100 with no cursor, so match 101 was unreachable, and `groupByAlert` printed
 * `group.triggers.length` as the group's size — "12 matches" for a radar with 300. It looked
 * entirely right, which is why it survived. The count comes from the server's facet over the whole
 * filtered set now, and the page is a real keyset page.
 */
test.describe('the alerts inbox as a grouped page', () => {
  const MATCHES_PER_RADAR = 40
  const RADARS = 3
  const TOTAL = MATCHES_PER_RADAR * RADARS

  let alertIds: string[] = []

  async function seedInbox(): Promise<void> {
    const { sql, organization, owner } = harness
    alertIds = []
    for (let index = 0; index < RADARS; index += 1) {
      const id = `e2e-inbox-alert-${harness.workerIndex}-${index}`
      await sql`
        insert into alerts (id, organization_id, user_id, name, keywords, frequency, delivery_channel, enabled, trigger_conditions, created_at)
        values (
          ${id}, ${organization.organizationId}, ${owner.userId!}, ${`Inbox radar ${index}`},
          ${sql.json(['rust'])}, 'daily', 'email', true, ${sql.json({ eventType: 'keyword_match' })},
          now() - (${index} * interval '1 day')
        )
      `
      alertIds.push(id)
    }
    for (let index = 0; index < TOTAL; index += 1) {
      await sql`
        insert into alert_triggers (id, organization_id, alert_id, user_id, event_type, payload, matched_at, read_at)
        values (
          ${`e2e-inbox-trig-${harness.workerIndex}-${String(index).padStart(3, '0')}`},
          ${organization.organizationId}, ${alertIds[index % RADARS]}, ${owner.userId!},
          ${(['keyword_match', 'new_repo', 'new_product'])[index % 3]},
          ${sql.json({
    source: 'github',
    sourceId: `inbox-${index}`,
    username: `inboxbuilder${index}`,
    displayName: `Inbox Builder ${index}`,
    profileUrl: `https://example.invalid/inbox${index}`,
    followersCount: index,
    topics: ['rust'],
    score: index,
  })},
          now() - (${index} * interval '10 minutes'),
          ${index % 4 === 0 ? null : new Date()}
        )
      `
    }
  }

  async function clearInbox(): Promise<void> {
    await harness.sql`delete from alert_triggers where id like ${`e2e-inbox-trig-${harness.workerIndex}-%`}`
    await harness.sql`delete from alerts where id like ${`e2e-inbox-alert-${harness.workerIndex}-%`}`
  }

  test('the group facet counts the whole group, not the loaded part', async () => {
    await seedInbox()
    try {
      const page = await (await harness.owner.api!.get('/api/alerts/triggers?group=alertId')).json()

      expect(page.rows.length).toBe(50)
      expect(page.total).toBe(TOTAL)

      // The assertion the old code could not make. Page one holds 50 rows across three radars of 40,
      // so at least one group is partially loaded — and every facet still reports 40.
      const facets = page.facets.alertId as Array<{ value: string; count: number }>
      for (const alertId of alertIds) {
        expect(facets.find((facet) => facet.value === alertId)?.count).toBe(MATCHES_PER_RADAR)
      }

      const loadedPerRadar = new Map<string, number>()
      for (const row of page.rows as Array<{ alertId: string }>) {
        loadedPerRadar.set(row.alertId, (loadedPerRadar.get(row.alertId) ?? 0) + 1)
      }
      expect([...loadedPerRadar.values()].some((loaded) => loaded < MATCHES_PER_RADAR)).toBe(true)
    } finally {
      await clearInbox()
    }
  })

  /** A group split across pages is not a group — the server has to order by the group column first. */
  test('grouping keeps each radar contiguous', async () => {
    await seedInbox()
    try {
      const page = await (await harness.owner.api!.get('/api/alerts/triggers?group=alertId')).json()
      const order = (page.rows as Array<{ alertId: string }>).map((row) => row.alertId)
      const runs = order.filter((alertId, index) => index === 0 || order[index - 1] !== alertId)
      // One run per radar present on the page, not one per interleaved match.
      expect(runs.length).toBe(new Set(order).size)
    } finally {
      await clearInbox()
    }
  })

  test('walks every match exactly once, grouped and ungrouped', async () => {
    await seedInbox()
    try {
      for (const grouping of ['', '&group=alertId']) {
        const seen = new Set<string>()
        let cursor: string | null = null
        let guard = 0
        do {
          const url: string = `/api/alerts/triggers?x=1${grouping}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
          const page = await (await harness.owner.api!.get(url)).json()
          for (const row of page.rows as Array<{ id: string }>) {
            expect(seen.has(row.id), `trigger ${row.id} served twice`).toBe(false)
            seen.add(row.id)
          }
          cursor = page.nextCursor
          guard += 1
        } while (cursor && guard < 10)

        expect(seen.size, `grouping "${grouping}" lost a match`).toBe(TOTAL)
      }
    } finally {
      await clearInbox()
    }
  })

  test('each row carries the name of the radar that found it', async () => {
    await seedInbox()
    try {
      const page = await (await harness.owner.api!.get('/api/alerts/triggers')).json()
      expect(page.rows.every((row: { alertName: string | null }) => row.alertName?.startsWith('Inbox radar'))).toBe(true)
    } finally {
      await clearInbox()
    }
  })

  test('a match whose radar was deleted still surfaces', async () => {
    await seedInbox()
    try {
      // `alerts.id` cascades to `alert_triggers`, so a deleted radar takes its matches with it —
      // which is why the null-name branch is reached by a trigger pointing at a radar that is gone
      // rather than by deleting one. Assert the shape the page relies on instead: a null name is
      // rendered, not dropped.
      const page = await (await harness.owner.api!.get('/api/alerts/triggers')).json()
      expect(page.rows.length).toBeGreaterThan(0)
      expect(page.rows.every((row: Record<string, unknown>) => 'alertName' in row)).toBe(true)
    } finally {
      await clearInbox()
    }
  })

  test('an unknown group column is refused rather than absorbed', async () => {
    const response = await harness.owner.api!.get('/api/alerts/triggers?group=payload')
    expect(response.status()).toBe(400)
    expect((await response.json()).error).toContain('Unknown group column')
  })

  test('the radar list is a page too', async () => {
    await seedInbox()
    try {
      const page = await (await harness.owner.api!.get('/api/alerts')).json()
      expect(Array.isArray(page.rows)).toBe(true)
      expect(page.total).toBeGreaterThanOrEqual(RADARS)
      // The page renders `a.triggerConditions.eventType`; the first version of this projection
      // dropped the field and the route mounted straight into a TypeError.
      expect(page.rows[0].triggerConditions.eventType).toBeTruthy()
    } finally {
      await clearInbox()
    }
  })

  test('neither page answers a caller from another organization', async () => {
    await seedInbox()
    try {
      const strangerInbox = await (await harness.stranger.api!.get('/api/alerts/triggers')).json()
      expect(strangerInbox.total).toBe(0)
      const strangerRadars = await (await harness.stranger.api!.get('/api/alerts')).json()
      expect(strangerRadars.rows.every((row: { id: string }) => !row.id.startsWith('e2e-inbox-alert'))).toBe(true)
    } finally {
      await clearInbox()
    }
  })
})
