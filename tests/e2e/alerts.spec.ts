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
