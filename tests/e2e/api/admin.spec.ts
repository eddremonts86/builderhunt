/**
 * The platform-admin authorization boundary, over every admin route (plan 53, task 2 —
 * `plans/phase-1/53-exhaustive-local-e2e-design/tasks.md`).
 *
 * `/api/admin/*` is the largest concentration of privilege in the product: it revokes claims, replays billing
 * events, runs workers, edits public content, and reads cross-tenant metrics. Membership of that set is not
 * a role in any organization — it is an env allowlist (`ADMIN_USER_IDS`), which means a paying customer with a
 * perfectly valid owner session is, correctly, a stranger here.
 *
 * ## Why this is a table and not seventy hand-written tests
 *
 * The property is uniform: no session and no admin session must both be refused, on **every** method of
 * **every** route. Written by hand, the file would be seventy near-copies and the one route someone forgot to
 * add would be invisible. Written as a table, adding a route to the list is one line, and the count itself is
 * an assertion — `ROUTES` is checked against the number of files under `src/routes/api/admin/`, so a new admin
 * route that nobody probes fails this spec rather than shipping unprobed.
 *
 * ## Why the admin-positive probe is GET-only
 *
 * A `POST /api/admin/billing/events/:id/replay` from a real platform admin would *replay a billing event*.
 * The negative cases are safe to fire at every method because they are refused before anything happens; the
 * positive case is not. So the admin session probes reads only, and mutating methods are covered for
 * authorization here and for behaviour in the specs that own them.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from 'playwright/test'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
import {
  createPlatformAdminPrincipal,
  registerPlatformAdminEnv,
  reservePlatformAdminSeed,
} from '../harness/fixtures/platform-admin'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  admin: Principal
  /** A legitimate paying customer — and, here, a stranger. */
  tenant: Principal
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

  // The allowlist is read from the environment by the app process, so the id has to be reserved and
  // registered *before* the server is spawned. Minting the principal afterwards is too late.
  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}-adminapi`)
  registerPlatformAdminEnv(adminSeed)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}adminapi` }
    const clock = fixedClockFromEnv()

    const admin = await createPlatformAdminPrincipal(ctx, adminSeed)
    const tenant = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      admin,
      tenant: tenant.principal,
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
  await disposePrincipal(h.admin).catch(() => undefined)
  await disposePrincipal(h.tenant).catch(() => undefined)
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

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/**
 * Every method of every route under `src/routes/api/admin/`.
 *
 * Path parameters are filled with an id that cannot exist. That is deliberate: authorization must be decided
 * *before* the resource is looked up, so a refusal for a stranger must not depend on the id being real — and
 * an admin probing a fabricated id gets a 404, which is a perfectly good "not an authorization refusal".
 */
const ROUTES: Array<{ file: string; method: Method; path: string }> = [
  { file: 'abuse/clusters.ts', method: 'GET', path: '/api/admin/abuse/clusters' },
  { file: 'abuse/index.ts', method: 'GET', path: '/api/admin/abuse' },
  { file: 'abuse/index.ts', method: 'POST', path: '/api/admin/abuse' },
  { file: 'activity/run-retention.ts', method: 'POST', path: '/api/admin/activity/run-retention' },
  { file: 'alerts/run-worker.ts', method: 'POST', path: '/api/admin/alerts/run-worker' },
  { file: 'analytics/run-retention.ts', method: 'POST', path: '/api/admin/analytics/run-retention' },
  { file: 'billing/accounting-export.ts', method: 'GET', path: '/api/admin/billing/accounting-export' },
  { file: 'billing/configuration.ts', method: 'GET', path: '/api/admin/billing/configuration' },
  { file: 'billing/configuration.ts', method: 'PUT', path: '/api/admin/billing/configuration' },
  { file: 'billing/disputes.ts', method: 'GET', path: '/api/admin/billing/disputes' },
  { file: 'billing/events/$eventId.ts', method: 'GET', path: '/api/admin/billing/events/absent-id' },
  { file: 'billing/events/$eventId/replay.ts', method: 'POST', path: '/api/admin/billing/events/absent-id/replay' },
  { file: 'billing/events/index.ts', method: 'GET', path: '/api/admin/billing/events' },
  { file: 'billing/metrics.ts', method: 'GET', path: '/api/admin/billing/metrics' },
  { file: 'billing/reconcile.ts', method: 'POST', path: '/api/admin/billing/reconcile' },
  { file: 'billing/refunds.ts', method: 'GET', path: '/api/admin/billing/refunds' },
  { file: 'billing/refunds.ts', method: 'PUT', path: '/api/admin/billing/refunds' },
  { file: 'billing/risk-exceptions.ts', method: 'GET', path: '/api/admin/billing/risk-exceptions' },
  { file: 'billing/risk-exceptions.ts', method: 'POST', path: '/api/admin/billing/risk-exceptions' },
  { file: 'billing/risk-exceptions.ts', method: 'DELETE', path: '/api/admin/billing/risk-exceptions' },
  { file: 'billing/run-worker.ts', method: 'POST', path: '/api/admin/billing/run-worker' },
  { file: 'builder-claims/$claimId/revoke.ts', method: 'POST', path: '/api/admin/builder-claims/absent-id/revoke' },
  { file: 'builder-claims/index.ts', method: 'GET', path: '/api/admin/builder-claims' },
  { file: 'calendar/run-reminders.ts', method: 'POST', path: '/api/admin/calendar/run-reminders' },
  { file: 'calendar/run-worker.ts', method: 'POST', path: '/api/admin/calendar/run-worker' },
  { file: 'changelog/$id.ts', method: 'PATCH', path: '/api/admin/changelog/absent-id' },
  { file: 'changelog/$id.ts', method: 'DELETE', path: '/api/admin/changelog/absent-id' },
  { file: 'changelog/index.ts', method: 'GET', path: '/api/admin/changelog' },
  { file: 'changelog/index.ts', method: 'POST', path: '/api/admin/changelog' },
  { file: 'devpost/run-worker.ts', method: 'POST', path: '/api/admin/devpost/run-worker' },
  { file: 'discovery/run-worker.ts', method: 'POST', path: '/api/admin/discovery/run-worker' },
  { file: 'documents/run-web-imports.ts', method: 'POST', path: '/api/admin/documents/run-web-imports' },
  { file: 'documents/run-worker.ts', method: 'POST', path: '/api/admin/documents/run-worker' },
  { file: 'embeddings/run-worker.ts', method: 'POST', path: '/api/admin/embeddings/run-worker' },
  { file: 'enrichment/run-worker.ts', method: 'POST', path: '/api/admin/enrichment/run-worker' },
  { file: 'human-links/index.ts', method: 'GET', path: '/api/admin/human-links' },
  { file: 'human-links/index.ts', method: 'POST', path: '/api/admin/human-links' },
  { file: 'incidents/$id.ts', method: 'PATCH', path: '/api/admin/incidents/absent-id' },
  { file: 'incidents/index.ts', method: 'GET', path: '/api/admin/incidents' },
  { file: 'incidents/index.ts', method: 'POST', path: '/api/admin/incidents' },
  { file: 'integrations/index.ts', method: 'GET', path: '/api/admin/integrations' },
  { file: 'interviews/run-retention.ts', method: 'POST', path: '/api/admin/interviews/run-retention' },
  { file: 'legal/run-worker.ts', method: 'POST', path: '/api/admin/legal/run-worker' },
  { file: 'metrics/conversion.ts', method: 'GET', path: '/api/admin/metrics/conversion' },
  { file: 'metrics/index.ts', method: 'GET', path: '/api/admin/metrics' },
  { file: 'metrics/trust.ts', method: 'GET', path: '/api/admin/metrics/trust' },
  { file: 'operations/$jobKey.ts', method: 'PATCH', path: '/api/admin/operations/absent-job' },
  { file: 'operations/$jobKey/run.ts', method: 'POST', path: '/api/admin/operations/absent-job/run' },
  { file: 'operations/index.ts', method: 'GET', path: '/api/admin/operations' },
  { file: 'operations/sync-schedules.ts', method: 'GET', path: '/api/admin/operations/sync-schedules' },
  { file: 'operations/sync-schedules.ts', method: 'POST', path: '/api/admin/operations/sync-schedules' },
  { file: 'plan-requests/index.ts', method: 'GET', path: '/api/admin/plan-requests' },
  { file: 'plan-requests/index.ts', method: 'POST', path: '/api/admin/plan-requests' },
  { file: 'roadmap/$id.ts', method: 'PATCH', path: '/api/admin/roadmap/absent-id' },
  { file: 'roadmap/$id.ts', method: 'DELETE', path: '/api/admin/roadmap/absent-id' },
  { file: 'roadmap/index.ts', method: 'GET', path: '/api/admin/roadmap' },
  { file: 'roadmap/index.ts', method: 'POST', path: '/api/admin/roadmap' },
  { file: 'search-sources.ts', method: 'GET', path: '/api/admin/search-sources' },
  { file: 'search-sources.ts', method: 'POST', path: '/api/admin/search-sources' },
  { file: 'seo/index.ts', method: 'GET', path: '/api/admin/seo' },
  { file: 'seo/index.ts', method: 'PATCH', path: '/api/admin/seo' },
  { file: 'solutions/gold-briefs.ts', method: 'GET', path: '/api/admin/solutions/gold-briefs' },
  { file: 'solutions/gold-briefs.ts', method: 'POST', path: '/api/admin/solutions/gold-briefs' },
  { file: 'solutions/gold-briefs.ts', method: 'DELETE', path: '/api/admin/solutions/gold-briefs' },
  { file: 'solutions/sources.ts', method: 'GET', path: '/api/admin/solutions/sources' },
  { file: 'solutions/sources.ts', method: 'POST', path: '/api/admin/solutions/sources' },
  { file: 'sprints/run-worker.ts', method: 'POST', path: '/api/admin/sprints/run-worker' },
  { file: 'status/snapshot.ts', method: 'POST', path: '/api/admin/status/snapshot' },
  { file: 'users/$userId.ts', method: 'PATCH', path: '/api/admin/users/absent-id' },
  { file: 'users/index.ts', method: 'GET', path: '/api/admin/users' },

  /**
   * POST-only triggers that now reject GET explicitly. Listed so all three probes cover them: a GET
   * must be refused for a stranger by the *guard* (not a bare 405, which would confirm the route exists) and
   * answered 405 for a real admin.
   */
  { file: 'activity/run-retention.ts', method: 'GET', path: '/api/admin/activity/run-retention' },
  { file: 'alerts/run-worker.ts', method: 'GET', path: '/api/admin/alerts/run-worker' },
  { file: 'analytics/run-retention.ts', method: 'GET', path: '/api/admin/analytics/run-retention' },
  { file: 'billing/run-worker.ts', method: 'GET', path: '/api/admin/billing/run-worker' },
  { file: 'calendar/run-reminders.ts', method: 'GET', path: '/api/admin/calendar/run-reminders' },
  { file: 'calendar/run-worker.ts', method: 'GET', path: '/api/admin/calendar/run-worker' },
  { file: 'devpost/run-worker.ts', method: 'GET', path: '/api/admin/devpost/run-worker' },
  { file: 'discovery/run-worker.ts', method: 'GET', path: '/api/admin/discovery/run-worker' },
  { file: 'documents/run-web-imports.ts', method: 'GET', path: '/api/admin/documents/run-web-imports' },
  { file: 'documents/run-worker.ts', method: 'GET', path: '/api/admin/documents/run-worker' },
  { file: 'embeddings/run-worker.ts', method: 'GET', path: '/api/admin/embeddings/run-worker' },
  { file: 'enrichment/run-worker.ts', method: 'GET', path: '/api/admin/enrichment/run-worker' },
  { file: 'interviews/run-retention.ts', method: 'GET', path: '/api/admin/interviews/run-retention' },
  { file: 'legal/run-worker.ts', method: 'GET', path: '/api/admin/legal/run-worker' },
  { file: 'sprints/run-worker.ts', method: 'GET', path: '/api/admin/sprints/run-worker' },
  { file: 'status/snapshot.ts', method: 'GET', path: '/api/admin/status/snapshot' },
]

const ADMIN_ROUTE_DIR = 'src/routes/api/admin'

function listRouteFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return listRouteFiles(full, `${prefix}${entry}/`)
    return entry.endsWith('.ts') ? [`${prefix}${entry}`] : []
  })
}

async function probe(api: APIRequestContext, method: Method, path: string) {
  const response = await api.fetch(path, {
    method,
    ...(method === 'GET' || method === 'DELETE' ? {} : { data: {} }),
  })
  return { status: response.status(), text: await response.text() }
}

test('every admin route file appears in the table', () => {
  /**
   * The assertion that keeps this file honest as the surface grows.
   *
   * Without it, a new `/api/admin/*` route ships with no authorization probe at all and nothing complains —
   * the table would simply not mention it. Comparing against the filesystem means the omission fails here,
   * where someone is already looking at authorization.
   */
  const onDisk = listRouteFiles(ADMIN_ROUTE_DIR).sort()
  const inTable = [...new Set(ROUTES.map((route) => route.file))].sort()
  expect(inTable, `admin route files not covered by this spec: ${onDisk.filter((f) => !inTable.includes(f)).join(', ')}`)
    .toEqual(onDisk)
})

test.describe('no session', () => {
  for (const route of ROUTES) {
    test(`${route.method} ${route.path} is refused`, async () => {
      const { status } = await probe(harness.anonymous, route.method, route.path)
      expect([401, 403], `answered ${status}`).toContain(status)
    })
  }
})

test.describe('a valid tenant session that is not a platform admin', () => {
  for (const route of ROUTES) {
    test(`${route.method} ${route.path} is refused`, async () => {
      /**
       * The boundary that actually matters. An anonymous caller is refused by the session check every route
       * in the app has; a *signed-in paying customer* reaching an admin route is refused only by the
       * allowlist, and that is the check a refactor can drop without any other test noticing.
       */
      const { status, text } = await probe(harness.tenant.api!, route.method, route.path)
      expect([401, 403], `answered ${status}: ${text.slice(0, 120)}`).toContain(status)
    })
  }
})

test.describe('a platform admin', () => {
  // Reads only — see the file header. A positive probe of `POST .../replay` would replay a billing event.
  for (const route of ROUTES.filter((candidate) => candidate.method === 'GET')) {
    test(`${route.method} ${route.path} is not an authorization refusal`, async () => {
      /**
       * Not "returns 200": several of these are `absent-id` lookups that correctly 404, and some depend on
       * data this fixture has no reason to hold. The property under test is narrower and exactly right —
       * the allowlist lets this session through, so whatever comes back is not 401 or 403.
       */
      const { status, text } = await probe(harness.admin.api!, route.method, route.path)
      expect([401, 403], `admin was refused with ${status}: ${text.slice(0, 120)}`).not.toContain(status)
    })
  }
})
