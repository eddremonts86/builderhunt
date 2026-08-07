/**
 * The four dashboard API routes, over HTTP, against real roles.
 *
 * `scripts/check-e2e-route-coverage.mjs` reported `/api/dashboard/overview`,
 * `/api/dashboard/preferences`, `/api/dashboard/stats` and `/api/recommendations`
 * as having no spec at all. They were shipped with unit coverage
 * (`tests/unit/security/dashboard-overview-gates.test.ts`) that calls the handlers
 * directly, which proves the branch but not the wiring: the method table, the
 * session-to-tenant resolution and the status codes only exist once a request has
 * actually travelled through the router.
 *
 * `dashboard-and-navigation.spec.ts` seeds the same personas but asserts only on
 * the fixture objects, so it never issues a request to any of these paths. This
 * file is the part that was missing.
 *
 * Each route is checked on four axes: who may call it, which methods it answers,
 * what it does with input it should refuse, and whether one tenant's call can
 * observe another's. Runs on the per-worker disposable database + Redis namespace
 * + app server, never the shared dev database.
 */
import { test, expect } from 'playwright/test'
import postgres from 'postgres'
import { acquireWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { newApiContext } from './harness/auth'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import { type FixtureContext } from './harness/fixtures/principals'
import {
  seedDashboardFixtures,
  cleanupDashboardFixtures,
  type DashboardFixtures,
} from './harness/fixtures/dashboard-personas'

test.describe('dashboard API routes', () => {
  test.setTimeout(300_000)

  let ctx: FixtureContext
  let fx: DashboardFixtures
  let server: Awaited<ReturnType<typeof startWorkerServer>> | undefined
  let database: Awaited<ReturnType<typeof acquireWorkerDatabase>> | undefined
  let cache: Awaited<ReturnType<typeof acquireWorkerRedis>> | undefined
  /** Signed out, for every "who may call this" assertion below. */
  let anonymous: Awaited<ReturnType<typeof newApiContext>>

  test.beforeAll(async () => {
    ensureFixedTimeEnv()
    e2eEnv()
    const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
    database = await acquireWorkerDatabase(workerIndex)
    cache = await acquireWorkerRedis(workerIndex)
    server = await startWorkerServer(workerIndex, database, cache)
    const sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    ctx = {
      baseURL: server.baseURL,
      sql,
      scope: `w${workerIndex}-dashboard-api`,
    } as unknown as FixtureContext
    fx = await seedDashboardFixtures(ctx, fixedClockFromEnv())
    anonymous = await newApiContext(server.baseURL)
    await sql.end({ timeout: 5 })
  })

  test.afterAll(async () => {
    await anonymous?.dispose()
    await cleanupDashboardFixtures(ctx, fx)
    if (server) await stopWorkerServer(server.workerIndex)
    if (cache) await dropWorkerRedisNamespace(cache.prefix)
    // The worker database is deliberately left standing, as in `dashboard-and-navigation.spec.ts`:
    // `acquireWorkerDatabase` caches it per worker, and dropping it here would make the next spec
    // in this worker pay for a fresh migration run.
  })

  test('/api/dashboard/overview answers the owner and refuses the signed-out caller', async () => {
    const refused = await anonymous.get('/api/dashboard/overview')
    expect(refused.status(), await refused.text()).toBe(401)

    const response = await fx.activeRecruiter.api!.get('/api/dashboard/overview')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as { organizationId: string; range: string; sections: Record<string, unknown> }
    // The client asserts this against the session's active organization before painting, so a
    // response that omitted it or named another tenant would be rendered under the wrong heading.
    expect(body.organizationId).toBe(fx.recruiterOrg.organizationId)
    // No `range` parameter means the documented default, not whatever the last caller asked for.
    expect(body.range).toBe('7d')
    expect(Object.keys(body.sections).length).toBeGreaterThan(0)
  })

  test('/api/dashboard/overview refuses a range it does not define rather than falling back', async () => {
    // The fallback is the failure mode worth pinning: numbers for a window the caller did not ask
    // for are read as the answer to the question they did ask.
    const refused = await fx.activeRecruiter.api!.get('/api/dashboard/overview?range=90d')
    expect(refused.status(), await refused.text()).toBe(400)

    const accepted = await fx.activeRecruiter.api!.get('/api/dashboard/overview?range=24h')
    expect(accepted.status(), await accepted.text()).toBe(200)
    // Echoed back, so the widget cannot label 24h figures as 7d ones.
    expect((await accepted.json() as { range: string }).range).toBe('24h')
  })

  test('/api/dashboard/overview scopes to the caller, not to a supplied organizationId', async () => {
    // `profileOwner` has its own personal workspace. Asking as them, while naming the recruiter org
    // every way a client could, must still describe their own tenant.
    const foreign = fx.recruiterOrg.organizationId
    const attempts = [
      `/api/dashboard/overview?organizationId=${foreign}`,
      `/api/dashboard/overview?organization_id=${foreign}`,
    ]
    for (const path of attempts) {
      const response = await fx.profileOwner.api!.get(path)
      expect(response.status(), await response.text()).toBe(200)
      const body = await response.json() as { organizationId: string }
      expect(body.organizationId, `${path} must not honour a client-supplied tenant`).not.toBe(foreign)
      expect(body.organizationId).toBe(fx.profileOwner.organizationId)
    }
  })

  test('/api/dashboard/stats answers GET, refuses the signed-out caller, and answers 405 elsewhere', async () => {
    const refused = await anonymous.get('/api/dashboard/stats')
    expect(refused.status(), await refused.text()).toBe(401)

    const response = await fx.activeRecruiter.api!.get('/api/dashboard/stats')
    expect(response.status(), await response.text()).toBe(200)
    expect(await response.json()).toBeTruthy()

    // The route declares `ANY: methodNotAllowed(['GET'])`. Without this, an unimplemented method
    // renders the SPA's HTML shell with a 200, which a caller reads as success.
    const posted = await fx.activeRecruiter.api!.post('/api/dashboard/stats', { data: {} })
    expect(posted.status(), await posted.text()).toBe(405)
    expect(posted.headers()['allow']).toContain('GET')
  })

  test('/api/dashboard/preferences serves defaults to a caller with no tenant but refuses their write', async () => {
    // Deliberate asymmetry, documented on the route: the read carries no tenant data — a density
    // string and three empty lists — and refusing it logs a console error on every dashboard mount
    // that races the active-organization lookup. The write refuses, because it has nowhere to go.
    const read = await anonymous.get('/api/dashboard/preferences')
    expect(read.status(), await read.text()).toBe(200)
    const defaults = await read.json() as { density: string; hiddenWidgetIds: string[] }
    expect(defaults.density).toBe('bento')
    expect(defaults.hiddenWidgetIds).toEqual([])

    const write = await anonymous.put('/api/dashboard/preferences', {
      data: { revision: 0, density: 'sections', hiddenWidgetIds: [], pinnedWidgetIds: [], orderedWidgetIds: [] },
    })
    expect(write.status(), await write.text()).toBe(401)
  })

  test('/api/dashboard/preferences round-trips a write and refuses a stale revision with the winner', async () => {
    const created = await fx.orgMember.api!.put('/api/dashboard/preferences', {
      data: {
        revision: 0,
        density: 'sections',
        hiddenWidgetIds: ['action-queue'],
        pinnedWidgetIds: [],
        orderedWidgetIds: ['action-queue', 'summary'],
      },
    })
    expect(created.status(), await created.text()).toBe(200)
    expect((await created.json() as { density: string }).density).toBe('sections')

    const readBack = await fx.orgMember.api!.get('/api/dashboard/preferences')
    expect(readBack.status(), await readBack.text()).toBe(200)
    const stored = await readBack.json() as { density: string; revision: number; hiddenWidgetIds: string[] }
    expect(stored.density).toBe('sections')
    expect(stored.hiddenWidgetIds).toEqual(['action-queue'])
    // Revision moved, otherwise the conflict check below would pass for the wrong reason.
    expect(stored.revision).toBeGreaterThan(0)

    // Replaying the first write is exactly what a second tab holding a stale document sends.
    const stale = await fx.orgMember.api!.put('/api/dashboard/preferences', {
      data: { revision: 0, density: 'bento', hiddenWidgetIds: [], pinnedWidgetIds: [], orderedWidgetIds: [] },
    })
    expect(stale.status(), await stale.text()).toBe(409)
    // The conflict carries the winning document so the loser can adopt it without a refetch.
    const conflict = await stale.json() as { error: string; current?: { revision: number } }
    expect(conflict.error).toBe('Preferences changed elsewhere')
    expect(conflict.current?.revision).toBe(stored.revision)
  })

  test('/api/dashboard/preferences refuses a body that does not satisfy the write schema', async () => {
    for (const [label, data] of [
      ['unknown density', { revision: 0, density: 'compact', hiddenWidgetIds: [], pinnedWidgetIds: [], orderedWidgetIds: [] }],
      ['negative revision', { revision: -1, density: 'bento', hiddenWidgetIds: [], pinnedWidgetIds: [], orderedWidgetIds: [] }],
      ['duplicate id in an order', { revision: 0, density: 'bento', hiddenWidgetIds: [], pinnedWidgetIds: [], orderedWidgetIds: ['summary', 'summary'] }],
      ['missing lists', { revision: 0, density: 'bento' }],
    ] as const) {
      const response = await fx.profileOwner.api!.put('/api/dashboard/preferences', { data })
      expect(response.status(), `${label}: ${await response.text()}`).toBe(400)
    }

    const deleted = await fx.profileOwner.api!.delete('/api/dashboard/preferences')
    expect(deleted.status(), await deleted.text()).toBe(405)
    expect(deleted.headers()['allow']).toContain('PUT')
  })

  test('/api/recommendations names an empty result rather than returning a bare list', async () => {
    const refused = await anonymous.get('/api/recommendations')
    expect(refused.status(), await refused.text()).toBe(401)

    const response = await fx.profileOwner.api!.get('/api/recommendations')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as {
      recommendations: unknown[]
      meta: { reason?: string; basedOnSearches: number }
    }
    expect(Array.isArray(body.recommendations)).toBe(true)
    // A personal workspace has saved no searches, and the route says so instead of returning `[]`
    // with no explanation — the widget renders a different empty state for each.
    expect(body.meta.reason).toBe('no_saved_searches')
    expect(body.meta.basedOnSearches).toBe(0)

    const posted = await fx.profileOwner.api!.post('/api/recommendations', { data: {} })
    expect(posted.status(), await posted.text()).toBe(405)
  })
})
