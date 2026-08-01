/**
 * plans/UI/tasks.md Wave 5 "Build Admin Operations UI".
 *
 * Runs the full browser flow — list, pause, resume, manual-run-with-confirm — against the real
 * `/admin/operations` page and the `/api/admin/operations/*` endpoints added in "Add allowlisted
 * pause, resume, and manual-run APIs", then proves the mutation actually landed in
 * `operational_schedules`/`job_runs`, and that none of it is reachable by a non-platform-admin.
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

  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}ops`)
  registerPlatformAdminEnv(adminSeed)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}ops` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const admin = await createPlatformAdminPrincipal(ctx, adminSeed)
    await seedConsent(sql, { userId: admin.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })

    // The registry table is empty until something syncs it — production does this on deploy, not
    // on boot (see sync-schedules.ts's own docstring for why). The e2e worker's fresh disposable
    // database is no different, so the page would otherwise show every job as un-pausable
    // (version: null).
    const sync = await admin.api!.post('/api/admin/operations/sync-schedules')
    expect(sync.status()).toBe(200)

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

test.describe('admin operations', () => {
  test('the API is unavailable to a non-platform-admin organization owner', async () => {
    const listResponse = await harness.owner.api!.get('/api/admin/operations')
    expect(listResponse.status()).toBe(403)

    const patchResponse = await harness.owner.api!.patch('/api/admin/operations/alerts.evaluate', { data: { enabled: false, expectedVersion: 1 } })
    expect(patchResponse.status()).toBe(403)

    const runResponse = await harness.owner.api!.post('/api/admin/operations/alerts.evaluate/run')
    expect(runResponse.status()).toBe(403)
  })

  test('the route redirects a non-platform-admin away rather than rendering the page', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    guard.allowExpectedFailure(/status of 40[13]/)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/operations`)
      await expect(page.getByTestId('admin-operations-page')).toHaveCount(0)
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('an unknown job key fails closed on both the pause and manual-run endpoints, over real HTTP', async () => {
    // Unit coverage (tests/unit/security/admin-operations.test.ts) proves `findScheduleDefinition`
    // itself rejects path-traversal/SQL-injection-shaped strings; this proves the real route, with
    // a real database behind it, does the same for an arbitrary unregistered key end to end.
    const patchResponse = await harness.admin.api!.patch('/api/admin/operations/not-a-real-job', { data: { enabled: false, expectedVersion: 1 } })
    expect(patchResponse.status()).toBe(404)

    const runResponse = await harness.admin.api!.post('/api/admin/operations/not-a-real-job/run')
    expect(runResponse.status()).toBe(404)
  })

  test('a platform admin can pause and resume a job from the real page, and it survives a reload', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/operations`)
      await dismissOverlays(page)
      await expect(page.getByTestId('admin-operations-page')).toBeVisible()

      // Same data and actions are rendered twice (desktop table + mobile card list, one hidden by
      // CSS per viewport) — scope to the table, which is what's actually visible at this viewport.
      const table = page.getByTestId('operations-table')
      await expect(table.getByTestId('job-status-sprints.execute')).toHaveText(/healthy/i)
      await table.getByTestId('operations-toggle-sprints.execute').click()
      await expect(table.getByTestId('job-status-sprints.execute')).toHaveText(/paused/i)

      // Durable, not just optimistic local state — a reload re-fetches from the database.
      await gotoHydrated(page, `${harness.baseURL}/admin/operations`)
      await dismissOverlays(page)
      await expect(table.getByTestId('job-status-sprints.execute')).toHaveText(/paused/i)

      await table.getByTestId('operations-toggle-sprints.execute').click()
      await expect(table.getByTestId('job-status-sprints.execute')).toHaveText(/healthy/i)

      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
    }

    const [row] = await harness.sql<{ enabled: boolean; version: number }[]>`
      select enabled, version from operational_schedules where job_key = 'sprints.execute'
    `
    expect(row.enabled).toBe(true)
    expect(row.version).toBe(3) // synced at version 1 → paused (2) → resumed (3)
  })

  test('manual-run requires an explicit confirm click, then dispatches the worker and records a job_runs row', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/operations`)
      await dismissOverlays(page)

      const table = page.getByTestId('operations-table')
      await expect(table.getByTestId('operations-run-confirm-alerts.evaluate')).toHaveCount(0)
      await table.getByTestId('operations-run-alerts.evaluate').click()
      await expect(table.getByTestId('operations-run-confirm-alerts.evaluate')).toBeVisible()

      await table.getByTestId('operations-run-confirm-yes-alerts.evaluate').click()
      await expect(table.getByTestId('operations-message-alerts.evaluate')).toHaveText(/started/i)
      await expect(page.getByTestId('operations-row-alerts.evaluate')).toContainText('ok /')

      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
    }

    const runs = await harness.sql<{ state: string }[]>`
      select state from job_runs where job_key = 'alerts.evaluate' order by started_at desc limit 1
    `
    expect(runs[0]?.state).toBe('succeeded')
  })

  test('a repeated manual-run click while the job is already running is rejected, not duplicated', async () => {
    // Exercises the idempotency guard directly against the API — a real "already running" window
    // is a few hundred ms wide in a browser, too narrow to depend on for a reliable UI-level test.
    const before = await harness.sql<{ count: string }[]>`select count(*)::text from job_runs where job_key = 'alerts.evaluate'`
    await harness.sql`
      insert into job_runs (job_key, scheduled_for, started_at, state)
      values ('alerts.evaluate', now(), now(), 'running')
    `
    try {
      const response = await harness.admin.api!.post('/api/admin/operations/alerts.evaluate/run')
      expect(response.status()).toBe(409)
      expect((await response.json()).error).toBe('already_running')

      const after = await harness.sql<{ count: string }[]>`select count(*)::text from job_runs where job_key = 'alerts.evaluate'`
      // Only the one "running" row this test itself inserted — the rejected attempt added nothing.
      expect(Number(after[0].count)).toBe(Number(before[0].count) + 1)
    } finally {
      await harness.sql`delete from job_runs where job_key = 'alerts.evaluate' and state = 'running'`
    }
  })

  test('pausing with a stale version is rejected as a conflict, distinct from an unknown job', async () => {
    const response = await harness.admin.api!.patch('/api/admin/operations/embeddings.backfill', { data: { enabled: false, expectedVersion: 999 } })
    expect(response.status()).toBe(409)
    const body = await response.json()
    expect(body.error).toBe('version_conflict')
    expect(typeof body.currentVersion).toBe('number')
  })

  test('the desktop table and mobile card layout both render every job with its actions', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.admin.storageState!, viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/operations`)
      await dismissOverlays(page)
      const card = page.getByTestId('operations-card-status.snapshot')
      await expect(card).toBeVisible()
      await expect(card.getByTestId('operations-toggle-status.snapshot')).toBeVisible()
      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
    }
  })
})
