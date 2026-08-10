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

/**
 * `GET /api/beta-mode` — what a signed-in member may know, and what they may not.
 *
 * The admin write path is covered by `admin.spec.ts`'s authorization table, which probes every
 * `/api/admin/*` file by method. This spec exists for the **member-facing** endpoint, whose whole design
 * is its omissions: say whether beta mode is on, and reveal nothing about who turned it on, when, or what
 * any organization is entitled to.
 */
interface Harness {
  workerIndex: number
  databaseName: string
  sql: Sql
  member: Principal
  anonymous: APIRequestContext
}

let harness: Harness

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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}betamode` }
    const owner = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock: fixedClockFromEnv() })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      sql,
      member: owner.principal,
      anonymous: await playwrightRequest.newContext({ baseURL: server.baseURL }),
    }
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerRedisNamespace(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  const h = harness
  if (!h) return
  await h.anonymous.dispose().catch(() => undefined)
  await disposePrincipal(h.member).catch(() => undefined)
  await h.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(h.workerIndex)
  await dropWorkerRedisNamespace(h.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(h.workerIndex, h.databaseName).catch(() => undefined)
})

test.describe('GET /api/beta-mode', () => {
  test('refuses an anonymous caller', async () => {
    // Not because the answer is a secret, but because a badge is a signed-in surface and an anonymous
    // caller has no business enumerating platform state.
    const response = await harness.anonymous.get('/api/beta-mode')
    expect([401, 403], `answered ${response.status()}`).toContain(response.status())
  })

  test('answers a signed-in member with exactly two fields', async () => {
    const response = await harness.member.api!.get('/api/beta-mode')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as Record<string, unknown>

    // Seeded disabled by migration 0167, and nothing in this suite enables it.
    expect(body.enabled).toBe(false)
    expect(typeof body.revision).toBe('number')

    /**
     * The omissions are the contract, so they are asserted rather than assumed.
     *
     * `updatedBy` would name the operator who last changed a platform-wide setting and `updatedAt` would
     * date it. Both are operational history and both stay behind `/api/admin/billing/beta-mode`, which
     * requires platform admin. A member reading a badge needs neither, and an endpoint that returns them
     * "because they were already on the row" is how a badge becomes an information leak.
     */
    expect(Object.keys(body).sort()).toEqual(['enabled', 'revision'])
  })

  test('answers 405 with an Allow header for every other method', async () => {
    for (const method of ['post', 'put', 'delete', 'patch'] as const) {
      const response = await harness.member.api![method]('/api/beta-mode', { data: {} })
      expect(response.status(), `${method} answered ${response.status()}`).toBe(405)
      // `Allow` is what makes a 405 actionable rather than merely a refusal.
      expect(response.headers()['allow']).toBe('GET')
    }
  })
})
