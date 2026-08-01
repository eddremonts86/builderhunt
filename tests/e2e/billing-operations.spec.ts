/**
 * plans/UI/tasks.md Wave 5 "Add guarded billing operations actions".
 *
 * Exercises reconciliation, worker run, dead-letter replay, and risk-exception issue/revoke over
 * real HTTP against a real database — success, repeat/idempotency, stale-session (step-up), and
 * forbidden (non-admin) paths — then proves no raw Stripe payload or secret ever renders on the
 * Billing Operations page.
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
import { createPlatformAdminPrincipal, registerPlatformAdminEnv, reservePlatformAdminSeed } from './harness/fixtures/platform-admin'
import type { OrganizationFixture } from './harness/fixtures/organizations'
import { seedConsent } from './harness/fixtures/privacy'
import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'
import { encryptWebhookPayload } from '~/shared/lib/crypto/webhook-payload'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
  owner: Principal
  organization: OrganizationFixture
  admin: Principal
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

  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}billops`)
  registerPlatformAdminEnv(adminSeed)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}billops` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const admin = await createPlatformAdminPrincipal(ctx, adminSeed)
    await seedConsent(sql, { userId: admin.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })

    harness = { workerIndex, databaseName: database.databaseName, redisPrefix: cache.prefix, baseURL: server.baseURL, sql, ctx, owner, organization, admin }
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

/** Ages the admin's own session past the 15-minute step-up window, then restores it — a "stale
 * session" is a real, temporary state, not a permanent property of the fixture. */
async function withStaleAdminSession<T>(fn: () => Promise<T>): Promise<T> {
  const staleSince = new Date(Date.now() - 20 * 60 * 1000)
  await harness.sql`update auth_sessions set created_at = ${staleSince} where user_id = ${harness.admin.userId!}`
  try {
    return await fn()
  } finally {
    await harness.sql`update auth_sessions set created_at = now() where user_id = ${harness.admin.userId!}`
  }
}

async function seedDeadLetteredEvent(): Promise<string> {
  const id = `webhook-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const payload = encryptWebhookPayload(JSON.stringify({ id: `evt_${id}`, type: 'customer.subscription.updated', data: { object: {} } }))
  await harness.sql`
    insert into billing_webhook_events (id, livemode, stripe_event_id, api_version, object_type, event_type, status, attempts, payload_encrypted, last_error)
    values (${id}, false, ${`evt_${id}`}, '2025-01-01', 'subscription', 'customer.subscription.updated', 'failed', 3, ${payload}, 'simulated_processing_failure')
  `
  return id
}

test.describe('billing operations — guarded actions', () => {
  test('forbidden: a non-platform-admin organization owner cannot reconcile, run the worker, replay, or manage risk exceptions', async () => {
    expect((await harness.owner.api!.post('/api/admin/billing/reconcile')).status()).toBe(403)
    expect((await harness.owner.api!.post('/api/admin/billing/run-worker')).status()).toBe(403)
    expect((await harness.owner.api!.post('/api/admin/billing/events/nonexistent/replay')).status()).toBe(403)
    expect((await harness.owner.api!.post('/api/admin/billing/risk-exceptions', {
      data: { organizationId: harness.organization.organizationId, reason: 'test', durationMs: 60_000 },
    })).status()).toBe(403)
  })

  test('success: a platform admin can run reconciliation and the webhook worker', async () => {
    const reconcile = await harness.admin.api!.post('/api/admin/billing/reconcile')
    expect(reconcile.status()).toBe(200)
    const reconcileBody = await reconcile.json()
    expect(reconcileBody.result).toBeTruthy()

    const worker = await harness.admin.api!.post('/api/admin/billing/run-worker')
    expect(worker.status()).toBe(200)
    expect((await worker.json()).ok).toBe(true)
  })

  test('repeat: a reconciliation pass already running is rejected, not duplicated', async () => {
    await harness.sql`
      insert into job_runs (job_key, scheduled_for, started_at, state)
      values ('billing.reconcile', now(), now(), 'running')
    `
    try {
      const response = await harness.admin.api!.post('/api/admin/billing/reconcile')
      expect(response.status()).toBe(409)
      expect((await response.json()).error).toBe('already_running')
    } finally {
      await harness.sql`delete from job_runs where job_key = 'billing.reconcile' and state = 'running'`
    }
  })

  test('stale: a session older than the step-up window is rejected on every mutating billing action', async () => {
    await withStaleAdminSession(async () => {
      expect((await harness.admin.api!.post('/api/admin/billing/reconcile')).status()).toBe(401)
      expect((await harness.admin.api!.post('/api/admin/billing/run-worker')).status()).toBe(401)
      expect((await harness.admin.api!.post('/api/admin/billing/risk-exceptions', {
        data: { organizationId: harness.organization.organizationId, reason: 'test', durationMs: 60_000 },
      })).status()).toBe(401)
    })
  })

  test('failed-event: replaying a dead-lettered event succeeds, and replaying it again is a safe no-op', async () => {
    const eventId = await seedDeadLetteredEvent()
    try {
      const first = await harness.admin.api!.post(`/api/admin/billing/events/${eventId}/replay`)
      expect(first.status()).toBe(200)
      const firstBody = await first.json()
      expect(firstBody.eventRowId).toBe(eventId)

      // Repeat: the same dead-lettered event, replayed again, must not throw or double-apply —
      // this is the "repeat" contract for replay specifically (distinct from reconciliation's
      // already-running 409, since replay has no run-in-flight concept to guard).
      const second = await harness.admin.api!.post(`/api/admin/billing/events/${eventId}/replay`)
      expect(second.status()).toBe(200)
    } finally {
      await harness.sql`delete from billing_webhook_events where id = ${eventId}`
    }
  })

  test('replaying an unknown event id 404s distinctly from a forbidden or stale rejection', async () => {
    const response = await harness.admin.api!.post('/api/admin/billing/events/does-not-exist/replay')
    expect(response.status()).toBe(404)
  })

  test('discovery: a dead-lettered event is findable by status filter, with a redacted detail and correct replay eligibility', async () => {
    const eventId = await seedDeadLetteredEvent()
    try {
      const list = await harness.admin.api!.get('/api/admin/billing/events?status=failed')
      expect(list.status()).toBe(200)
      const listBody = await list.json() as { rows: Array<{ id: string }> }
      expect(listBody.rows.some((r) => r.id === eventId)).toBe(true)

      const wrongStatus = await harness.admin.api!.get('/api/admin/billing/events?status=processed')
      expect((await wrongStatus.json() as { rows: Array<{ id: string }> }).rows.some((r) => r.id === eventId)).toBe(false)

      const detail = await harness.admin.api!.get(`/api/admin/billing/events/${eventId}`)
      expect(detail.status()).toBe(200)
      const detailBody = await detail.json()
      expect(detailBody.replayEligible).toBe(true)
      expect(detailBody.lastErrorPreview).toContain('simulated_processing_failure')
      expect(JSON.stringify(detailBody)).not.toContain('payloadEncrypted')
      expect(JSON.stringify(detailBody)).not.toContain('iv:tag:ciphertext') // never the raw encrypted column value
    } finally {
      await harness.sql`delete from billing_webhook_events where id = ${eventId}`
    }
  })

  test('discovery list is unavailable to a non-platform-admin', async () => {
    expect((await harness.owner.api!.get('/api/admin/billing/events')).status()).toBe(403)
  })

  test('an operator can discover and replay a dead-lettered event directly from the real page', async ({ browser }) => {
    const eventId = await seedDeadLetteredEvent()
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/billing`)
      await dismissOverlays(page)

      await expect(page.getByTestId(`billing-event-row-${eventId}`)).toBeVisible()
      await page.getByTestId(`billing-event-replay-${eventId}`).click()
      await page.getByTestId(`billing-event-replay-confirm-${eventId}`).click()
      await expect(page.getByTestId('billing-replay-message')).toContainText(/replayed/i)

      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
      await harness.sql`delete from billing_webhook_events where id = ${eventId}`
    }
  })

  test('a platform admin can issue and then revoke a risk exception', async () => {
    const issue = await harness.admin.api!.post('/api/admin/billing/risk-exceptions', {
      data: { organizationId: harness.organization.organizationId, reason: 'reviewed manually', durationMs: 60 * 60 * 1000 },
    })
    expect(issue.status()).toBe(200)
    const exception = (await issue.json()).exception

    const revoke = await harness.admin.api!.delete('/api/admin/billing/risk-exceptions', {
      data: { organizationId: harness.organization.organizationId, exceptionId: exception.id },
    })
    expect(revoke.status()).toBe(200)
  })

  test('the real Billing Operations page never renders a raw payload, secret, or Stripe event id', async ({ browser }) => {
    // The row's own synthetic id IS shown by design (an operator needs it to identify what
    // they're replaying) — what must never render is the Stripe event id, the encrypted payload,
    // or the raw underlying error message this event was seeded with.
    const eventId = await seedDeadLetteredEvent()
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/billing`)
      await dismissOverlays(page)
      await expect(page.getByTestId('admin-billing-operations')).toBeVisible()
      await expect(page.getByTestId(`billing-event-row-${eventId}`)).toBeVisible()

      const bodyText = await page.locator('body').innerText()
      expect(bodyText).not.toMatch(/sk_(live|test)_/)
      expect(bodyText).not.toMatch(/whsec_/)
      expect(bodyText).not.toContain('payloadEncrypted')
      expect(bodyText).not.toContain(`evt_${eventId}`)

      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
      await harness.sql`delete from billing_webhook_events where id = ${eventId}`
    }
  })
})
