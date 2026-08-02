/**
 * The data-export routes over real HTTP (plan 53, task 1 —
 * `plans/phase-1/53-exhaustive-local-e2e-design/tasks.md`).
 *
 * A data export is a GDPR right and, at the same time, the single most concentrated pile of one person's data
 * the product ever produces. Three properties carry it, and each fails differently:
 *
 * - **Redaction.** The export serializes the caller's own rows. A password hash, a session token or a 2FA
 *   secret reaching that payload turns a subject-access request into a credential dump the user can be
 *   phished for. Asserted against the real serialized body, not against a list of fields someone remembered.
 * - **404, not 403, for another user's export.** These are keyed by user, not by organization, so the axis is
 *   between people. Answering 403 for a real id and 404 for a fabricated one would confirm that an export
 *   exists — which is itself information about someone else's activity.
 * - **The 24-hour throttle returns the existing id.** Not a bare 429: a user who clicks twice must be handed
 *   the export they already have rather than told to come back tomorrow with nothing.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../harness/cache'
import { startWorkerServer, stopWorkerServer } from '../harness/server'
import { e2eEnv } from '../harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from '../harness/clock'
import {
  createOwnerPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from '../harness/fixtures/principals'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  a: Principal
  b: Principal
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}privapi` }
    const clock = fixedClockFromEnv()

    const a = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const b = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      a: a.principal,
      b: b.principal,
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
  const h = harness
  if (!h) return
  await h.anonymous.dispose().catch(() => undefined)
  await disposePrincipal(h.a).catch(() => undefined)
  await disposePrincipal(h.b).catch(() => undefined)
  await h.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(h.workerIndex)
  const admin = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${h.databaseName} and pid <> pg_backend_pid()
    `
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined)
  }
  await dropWorkerDatabase(h.workerIndex, h.databaseName)
  await dropWorkerRedisNamespace(h.redisPrefix)
})

/** Requested once per file: the throttle below is the point, so a second request is not free. */
let exportIdA: string | null = null

async function requestExport(principal: Principal) {
  const response = await principal.api!.post('/api/me/data-export', { data: {} })
  return { status: response.status(), body: await response.text() }
}

test.describe('anonymous access', () => {
  const ROUTES = [
    { method: 'POST' as const, path: '/api/me/data-export' },
    { method: 'GET' as const, path: '/api/me/data-export' },
    { method: 'GET' as const, path: '/api/me/data-export/does-not-exist' },
  ]

  for (const route of ROUTES) {
    test(`${route.method} ${route.path} refuses a request with no session`, async () => {
      const response = await harness.anonymous.fetch(route.path, {
        method: route.method,
        ...(route.method === 'POST' ? { data: {} } : {}),
      })
      expect(
        [401, 403],
        `${route.method} ${route.path} answered ${response.status()} to an anonymous caller`,
      ).toContain(response.status())
    })
  }
})

test.describe('POST /api/me/data-export', () => {
  test('produces an export for the caller', async () => {
    const first = await requestExport(harness.a)
    expect([200, 201], first.body).toContain(first.status)
    const created = JSON.parse(first.body) as { id?: string }
    expect(created.id).toBeTruthy()
    exportIdA = created.id!

    const [row] = await harness.sql<{ user_id: string }[]>`
      select user_id from data_export_requests where id = ${exportIdA}
    `
    expect(row?.user_id, 'the export belongs to the caller').toBe(harness.a.userId!)
  })

  test('a second request inside 24h is throttled, and hands back the export already made', async () => {
    /**
     * The `existingId` is the whole difference between a throttle and a dead end. A user who clicks twice —
     * or reloads — must reach the export they already have; telling them "try again in 24h" while an export
     * sits ready is a data-subject right denied by a rate limiter.
     */
    const second = await requestExport(harness.a)
    expect(second.status, second.body).toBe(429)
    const body = JSON.parse(second.body) as { error?: string; existingId?: string }
    expect(body.existingId, 'the throttle points at the export that already exists').toBe(exportIdA)
  })

  test("the throttle is per user, so B is not blocked by A's export", async () => {
    // A shared bucket here would let any user deny the export right to every other user by exercising it once.
    const mine = await requestExport(harness.b)
    expect([200, 201], mine.body).toContain(mine.status)
  })
})

test.describe('GET /api/me/data-export/$id', () => {
  test('returns the caller’s own export', async () => {
    const response = await harness.a.api!.get(`/api/me/data-export/${exportIdA}`)
    expect([200, 410], await response.text()).toContain(response.status())
  })

  test("another user's export is 404, exactly like one that never existed", async () => {
    /**
     * 404 for both, deliberately. A 403 on a real id and a 404 on a fabricated one would confirm that a given
     * export exists — and an export id existing says that a specific person exercised a specific right at a
     * specific time.
     */
    const real = await harness.b.api!.get(`/api/me/data-export/${exportIdA}`)
    const fabricated = await harness.b.api!.get(
      `/api/me/data-export/${'0'.repeat(String(exportIdA).length)}`,
    )

    expect(real.status(), "B reading A's export").toBe(404)
    expect(real.status(), 'a real id must be indistinguishable from an absent one').toBe(fabricated.status())
    expect(await real.text()).toBe(await fabricated.text())
  })

  test('the export payload carries no credential material', async () => {
    /**
     * Asserted against the serialized body rather than a remembered field list, because the danger is a
     * *future* column joining the export by accident. Substring matching over the whole payload is blunt on
     * purpose: it catches a nested field nobody thought to name.
     */
    const response = await harness.a.api!.get(`/api/me/data-export/${exportIdA}`)
    const body = (await response.text()).toLowerCase()
    for (const forbidden of [
      'passwordhash',
      'password_hash',
      'sessiontoken',
      'session_token',
      'twofactorsecret',
      'two_factor_secret',
      'verificationtoken',
    ]) {
      expect(body, `the export payload contains "${forbidden}"`).not.toContain(forbidden)
    }
  })
})

test.describe('GET /api/me/data-export', () => {
  test('lists only the caller’s own export requests', async () => {
    const response = await harness.b.api!.get('/api/me/data-export')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.text()
    expect(body, "A's export id must not appear in B's list").not.toContain(String(exportIdA))
  })
})
