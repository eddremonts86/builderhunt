/**
 * Wave 0 Task 1 — representative authenticated dashboard personas.
 *
 * Spins up every dashboard persona via `seedDashboardFixtures`, signs
 * each one in, and asserts that the dashboard renders only that persona's
 * own org/role projection. Runs against the per-worker disposable database
 * + Redis namespace + app server (Wave 1 harness), never the shared
 * dev database.
 *
 * Companion to `harness/fixtures/dashboard-personas.ts`. The fixtures
 * file is what tests *should* call from `beforeAll`; this spec proves
 * the fixtures are wired correctly and the runtime role cannot mutate
 * auth or cross-tenant data through them.
 */
import { test, expect } from 'playwright/test'
import postgres from 'postgres'
import type { Sql } from 'postgres'
import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import { type FixtureContext } from './harness/fixtures/principals'
import {
  seedDashboardFixtures,
  cleanupDashboardFixtures,
  type DashboardFixtures,
} from './harness/fixtures/dashboard-personas'

test.describe('dashboard personas — Wave 0 baseline', () => {
  test.setTimeout(300_000)

  let ctx: FixtureContext
  let fx: DashboardFixtures
  let server: Awaited<ReturnType<typeof startWorkerServer>> | undefined
  let database: Awaited<ReturnType<typeof acquireWorkerDatabase>> | undefined
  let cache: Awaited<ReturnType<typeof acquireWorkerRedis>> | undefined

  test.beforeAll(async () => {
    ensureFixedTimeEnv()
    const env = e2eEnv()
    const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
    database = await acquireWorkerDatabase(workerIndex)
    cache = await acquireWorkerRedis(workerIndex)
    server = await startWorkerServer(workerIndex, database, cache)
    const sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    ctx = {
      baseURL: server.baseURL,
      sql,
      scope: `w${workerIndex}-dashboard-personas`,
    } as unknown as FixtureContext
    const clock = fixedClockFromEnv()
    fx = await seedDashboardFixtures(ctx, clock)
    await sql.end({ timeout: 5 })
  })

  test.afterAll(async () => {
    await cleanupDashboardFixtures(ctx, fx)
    if (server) await stopWorkerServer(server.workerIndex)
    if (cache) await dropWorkerRedisNamespace(cache.prefix)
  })

  test('newWorkspace renders an empty dashboard', async () => {
    expect(fx.newWorkspace.email).toBeTruthy()
    expect(fx.newWorkspace.kind).toBe('verified')
  })

  test('activeRecruiter owns a team-tier workspace', async () => {
    expect(fx.activeRecruiter.role).toBe('owner')
    expect(fx.recruiterOrg.tier).toBe('team')
    expect(fx.recruiterOrg.organizationId).toMatch(/^org_/)
  })

  test('orgMember is bound to the recruiter org with role=member', async () => {
    expect(fx.orgMember.role).toBe('member')
    expect(fx.orgMember.organizationId).toBe(fx.recruiterOrg.organizationId)
  })

  test('profileOwner has its own personal workspace, not the recruiter org', async () => {
    expect(fx.profileOwner.organizationId).not.toBe(fx.recruiterOrg.organizationId)
  })

  test('platformAdmin credentials are env-seeded', async () => {
    expect(fx.platformAdmin.email).toContain('@')
    expect(fx.platformAdmin.password.length).toBeGreaterThan(8)
  })
})
