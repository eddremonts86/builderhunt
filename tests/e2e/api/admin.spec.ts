/**
 * The platform-admin authorization boundary, over every admin route (plan 53, task 2 —
 * `plans/implemented/53-exhaustive-local-e2e-design/tasks.md`).
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
  { file: 'access-requests/index.ts', method: 'GET', path: '/api/admin/access-requests' },
  { file: 'access-requests/index.ts', method: 'POST', path: '/api/admin/access-requests' },
  { file: 'activity/run-retention.ts', method: 'POST', path: '/api/admin/activity/run-retention' },
  { file: 'alerts/run-worker.ts', method: 'POST', path: '/api/admin/alerts/run-worker' },
  { file: 'analytics/run-retention.ts', method: 'POST', path: '/api/admin/analytics/run-retention' },
  { file: 'billing/accounting-export.ts', method: 'GET', path: '/api/admin/billing/accounting-export' },
  { file: 'billing/beta-mode.ts', method: 'GET', path: '/api/admin/billing/beta-mode' },
  { file: 'billing/beta-mode.ts', method: 'PUT', path: '/api/admin/billing/beta-mode' },
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
  // The split sections (plan 57). `sections.ts` is probed with a valid section, because an invalid one is
  // a 400 for *everybody* and would pass this table without ever reaching the authorization guard.
  { file: 'metrics/overview.ts', method: 'GET', path: '/api/admin/metrics/overview' },
  { file: 'preferences.ts', method: 'GET', path: '/api/admin/preferences' },
  { file: 'preferences.ts', method: 'PUT', path: '/api/admin/preferences' },
  { file: 'metrics/run-retention.ts', method: 'POST', path: '/api/admin/metrics/run-retention' },
  { file: 'metrics/sections.ts', method: 'GET', path: '/api/admin/metrics/sections?section=runtime' },
  { file: 'metrics/trust.ts', method: 'GET', path: '/api/admin/metrics/trust' },
  { file: 'operations/$jobKey.ts', method: 'PATCH', path: '/api/admin/operations/absent-job' },
  { file: 'operations/$jobKey/run.ts', method: 'POST', path: '/api/admin/operations/absent-job/run' },
  { file: 'operations/index.ts', method: 'GET', path: '/api/admin/operations' },
  { file: 'operations/sync-schedules.ts', method: 'GET', path: '/api/admin/operations/sync-schedules' },
  { file: 'operations/sync-schedules.ts', method: 'POST', path: '/api/admin/operations/sync-schedules' },
  // `plan-requests/index.ts` was here and is gone (2026-08-03) with the legacy self-service upgrade queue —
  // every request was refused while billing was enabled, so the screen reviewed an empty list by construction.
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
   * POST-only triggers, whose seal runs the cron-or-admin guard before refusing the method. Listed so all three
   * probes cover them: a `GET` is refused by the *guard* for a stranger and answered 405 for a real admin.
   *
   * The guard-first ordering is about a **consistent** refusal, not about hiding the route: a stranger gets the
   * same 401 for `GET` as for `POST`, rather than a 405 that reads as "your credentials were fine, your verb was
   * not". It does not conceal that the route exists, and an earlier version of this comment claiming otherwise
   * was wrong — `platformAdminErrorResponse` answers 401/403 and never 404, so `POST` already distinguishes a
   * real admin route from an absent one.
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
  { file: 'metrics/run-retention.ts', method: 'GET', path: '/api/admin/metrics/run-retention' },
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

  /**
   * plans/ui-dashboard, Admin track "`/admin/metrics` optimization".
   *
   * The unit guard for this mocks the composer, which proves the route does not *call* it. This one
   * crosses the whole boundary against a real database, so it also proves the billing figures are
   * still reachable — the risk of removing a sweep is not that it stays gone, it is that it stays
   * gone everywhere.
   */
  test('the metrics page endpoint carries no billing sweep, and the billing endpoint carries the alerts', async () => {
    const metrics = await harness.admin.api!.fetch('/api/admin/metrics')
    expect(metrics.status()).toBe(200)
    const metricsBody = await metrics.json()
    expect(metricsBody).not.toHaveProperty('billing')
    // Removed rather than nulled — see the route comment on why they are not made real.
    expect(metricsBody.db).not.toHaveProperty('totalBuilders')
    expect(metricsBody.db).not.toHaveProperty('totalNotes')
    expect(metricsBody.db).not.toHaveProperty('totalSavedQueries')

    const billing = await harness.admin.api!.fetch('/api/admin/billing/metrics')
    expect(billing.status()).toBe(200)
    const billingBody = await billing.json()
    expect(Array.isArray(billingBody.alerts), 'alerts must be a list, so empty can mean "checked"').toBe(true)
    expect(billingBody).toHaveProperty('organizationsScanned')
  })
  test('the split metrics sections answer per section, and refuse a bad request rather than defaulting', async () => {
    /**
     * Plan 57, Admin track — the per-section split.
     *
     * Four properties, and the first two are the ones the monolith could not have. A section with no
     * backing store answers `unavailable` with a code instead of zeroes, because "0 pending" reads as an
     * empty queue rather than a shut door. And a caller mistake is a 400, not an `unavailable` envelope —
     * telling a typo it was a service outage sends somebody to look at the wrong thing.
     */
    const overview = await harness.admin.api!.fetch('/api/admin/metrics/overview')
    expect(overview.status()).toBe(200)
    const overviewBody = await overview.json()
    expect(overviewBody.section).toBe('overview')
    expect(overviewBody.schemaVersion).toBe(1)
    expect(overviewBody.payload.status).toBe('ready')
    // Freshness and a window are mandatory on anything carrying data: an aggregate without a time is a
    // claim about *now*, and one without a timezone does not say which day "yesterday" was.
    expect(typeof overviewBody.payload.generatedAt).toBe('string')
    expect(typeof overviewBody.payload.window.timezone).toBe('string')
    for (const value of overviewBody.payload.data.values) {
      expect(value, `${value.key} must carry a unit`).toHaveProperty('unit')
      expect(value, `${value.key} must carry a scope`).toHaveProperty('scope')
    }

    /**
     * The runtime section, and the scope rule the contract exists for.
     *
     * `metrics.get()` counters are per-instance and zero at boot. Every value here must say so and must
     * carry the process it came from — the shape that would let one instance's counter be read as the
     * platform's number is refused by the schema, and this asserts the wire actually looks like that.
     */
    const runtime = await harness.admin.api!.fetch('/api/admin/metrics/sections?section=runtime')
    expect(runtime.status()).toBe(200)
    const runtimeBody = await runtime.json()
    expect(runtimeBody.payload.status).toBe('ready')
    for (const value of runtimeBody.payload.data.values) {
      expect(value.scope, `${value.key} is an in-process counter`).toBe('process')
      expect(value.platformTotal, `${value.key} must not claim the platform`).toBeUndefined()
      expect(value.processIdentity?.pid, `${value.key} must name its process`).toBeGreaterThan(0)
    }

    /**
     * Traffic, which now has a store behind it — so this asserts the *rule*, not one of its two outcomes.
     *
     * `service_metric_buckets` is written by a thirty-second flush that deliberately leaves the minute in
     * progress behind, so whether a spec run has rows yet depends on how long the run has been going. An
     * assertion pinned to `unavailable` would have passed on a fresh database and started failing once the
     * suite got slower, for no product reason. What must hold either way is that the section never invents
     * a zero: it is `unavailable: insufficient_history` with no data at all, or it is real numbers that say
     * they came from the database and are platform totals.
     */
    const traffic = await harness.admin.api!.fetch('/api/admin/metrics/sections?section=traffic')
    expect(traffic.status()).toBe(200)
    const trafficBody = await traffic.json()
    if (trafficBody.payload.status === 'unavailable') {
      expect(trafficBody.payload.code).toBe('insufficient_history')
      expect(trafficBody.payload.data).toBeUndefined()
    } else {
      expect(trafficBody.payload.status).toBe('ready')
      for (const value of trafficBody.payload.data.values) {
        expect(value.scope, `${value.key} is read from the buckets table`).toBe('database')
        // The claim the per-instance rows plus the summing query earn, and the runtime section cannot make.
        expect(value.platformTotal, `${value.key} sums every instance`).toBe(true)
        expect(value.processIdentity, `${value.key} is not one process's counter`).toBeUndefined()
      }
      // Fourteen families, ten rows: the ranking is capped in the payload, not trimmed by the client.
      expect((trafficBody.payload.data.ranked ?? []).length).toBeLessThanOrEqual(10)
    }

    /**
     * The conversion endpoint's range validation (plan 57, "Optimize and render Conversion metrics").
     *
     * Three refusals, each for a stated reason. A reversed range is refused rather than swapped, because
     * swapping answers a question the caller did not ask and a reversed range is far more likely a bug in their
     * tooling than a typo they want corrected. An oversized one is refused because raw events are deleted after
     * thirty days, so a longer window is a scan over a range that provably holds nothing — and it would return
     * a table of zeros that reads as a collapse in conversion rather than as retention having done its job. A
     * bad variant is refused because there are exactly two arms.
     */
    const validRange = await harness.admin.api!.fetch('/api/admin/metrics/conversion?start=2026-08-01&end=2026-08-10')
    expect(validRange.status()).toBe(200)
    expect((await validRange.json()).start).toBe('2026-08-01')

    for (const query of [
      'start=2026-08-10&end=2026-08-01',
      'start=2020-01-01&end=2026-08-01',
      'variant=control',
      'start=08-01-2026',
    ]) {
      const bad = await harness.admin.api!.fetch(`/api/admin/metrics/conversion?${query}`)
      expect(bad.status(), query).toBe(400)
    }

    /**
     * Platform-admin console preferences (plan 57, "Persist isolated platform-admin preferences").
     *
     * Four properties, and the isolation is the one that needs a real database rather than a unit test.
     */
    const prefsBefore = await harness.admin.api!.fetch('/api/admin/preferences')
    expect(prefsBefore.status()).toBe(200)
    expect((await prefsBefore.json()).landing.section).toBe('overview')

    const saved = await harness.admin.api!.fetch('/api/admin/preferences', {
      method: 'PUT',
      data: { section: 'traffic', range: '7d', variant: 'latency' },
    })
    expect(saved.status()).toBe(200)
    expect((await saved.json()).landing).toMatchObject({ section: 'traffic', range: '7d', variant: 'latency' })
    // Persisted, not echoed: a fresh read returns it.
    expect((await (await harness.admin.api!.fetch('/api/admin/preferences')).json()).landing.section).toBe('traffic')

    /**
     * A required widget cannot be hidden, and the refusal is a 422 rather than a silent filter.
     *
     * The action queue is the panel that says a webhook is dead-lettered or a removal request is past its legal
     * date, and it is *already* absent whenever it has nothing to say — so a control to hide it would only ever be
     * used on a day it had a row. Silently dropping the id would report success and then not honour it, and the
     * next read would disagree with what the control showed.
     */
    const refused = await harness.admin.api!.fetch('/api/admin/preferences', {
      method: 'PUT',
      data: { hiddenWidgetIds: ['action_queue'] },
    })
    expect(refused.status()).toBe(422)
    expect((await refused.json()).error).toBe('required_widget_hidden')

    // An unknown section falls back rather than 400ing: a preference naming a section a later build removed is
    // expected, not exceptional.
    const normalized = await harness.admin.api!.fetch('/api/admin/preferences', {
      method: 'PUT',
      data: { section: 'surveillance' },
    })
    expect(normalized.status()).toBe(200)
    expect((await normalized.json()).landing.section).toBe('overview')

    // A body with an unknown key is refused outright — `.strict()`, so a typo is not silently ignored.
    const strict = await harness.admin.api!.fetch('/api/admin/preferences', {
      method: 'PUT',
      data: { landingSection: 'traffic' },
    })
    expect(strict.status()).toBe(400)

    /**
     * The legacy compatibility endpoint's key set, asserted so it cannot quietly re-monolith.
     *
     * `/api/admin/metrics` is what the page read on a fifteen-second timer to render everything at once. Three
     * widgets still read it — the interview capability grid, the discovery worker's current-run state, and the
     * process diagnostics — because those are booleans and strings the numeric section contract cannot carry.
     * What must not happen is a fourth thing being added here instead of to a section: the endpoint's whole
     * problem was that it grew. Pinning the top-level keys makes an addition fail a gate.
     */
    const legacy = await harness.admin.api!.fetch('/api/admin/metrics')
    expect(legacy.status()).toBe(200)
    const legacyBody = await legacy.json()
    expect(Object.keys(legacyBody).sort()).toEqual(
      // `removals` is conditional on `PROFILE_REMOVAL_ENABLED`, so it is allowed to be absent but not extra.
      Object.keys(legacyBody).includes('removals')
        ? ['db', 'discovery', 'generatedAt', 'interviews', 'inProcess', 'removals', 'server'].sort()
        : ['db', 'discovery', 'generatedAt', 'interviews', 'inProcess', 'server'].sort(),
    )
    // And nothing in it is a collection whose length is decided by how much data exists.
    for (const [key, value] of Object.entries(legacyBody)) {
      expect(Array.isArray(value), `${key} must not be a row collection`).toBe(false)
    }

    /**
     * `?fields=` bounds the *work*, not just the shape (plan 57, Admin track).
     *
     * The key set above was already fixed; what every request still did was compute all of it — two platform
     * aggregates, a discovery read, and a removal read when that feature is on. The three section widgets each
     * read exactly one field, and `server` and `interviews` need no database at all, so opening the Runtime
     * disclosure ran two platform aggregates to report a Node version.
     *
     * Asserted as *absence of the other keys* rather than by timing a query count: the response is the observable
     * contract, and a key that is not there could not have been computed.
     */
    const serverOnly = await harness.admin.api!.fetch('/api/admin/metrics?fields=server')
    expect(serverOnly.status()).toBe(200)
    const serverBody = await serverOnly.json()
    expect(Object.keys(serverBody).sort()).toEqual(['generatedAt', 'server'])
    // The field it asked for is real, not an empty stub.
    expect(serverBody.server).toHaveProperty('nodeVersion')

    const twoFields = await harness.admin.api!.fetch('/api/admin/metrics?fields=discovery,interviews')
    expect(twoFields.status()).toBe(200)
    expect(Object.keys(await twoFields.json()).sort()).toEqual(['discovery', 'generatedAt', 'interviews'])

    /**
     * An unknown field is a 400, and a typo is the case that matters.
     *
     * Dropping it silently would answer 200 without the key, and the caller would wait for something it was
     * never told was refused — the same reason `sections.ts` refuses an unknown section rather than defaulting.
     */
    const typo = await harness.admin.api!.fetch('/api/admin/metrics?fields=sever')
    expect(typo.status()).toBe(400)
    const typoBody = await typo.json()
    expect(typoBody.error).toBe('invalid_request')
    expect(typoBody.unknownFields).toEqual(['sever'])

    // Empty is a request for nothing, which is a caller bug rather than an instruction.
    const empty = await harness.admin.api!.fetch('/api/admin/metrics?fields=')
    expect(empty.status()).toBe(400)

    /**
     * The comparison, which doubles the section's cost when asked for.
     *
     * `compare` is refused rather than coerced for a reason specific to it: defaulting a typo to "on" doubles
     * the query cost of a page that refreshes on a timer, and defaulting it to "off" returns numbers with no
     * comparison while the caller's URL says there is one.
     */
    const compared = await harness.admin.api!.fetch('/api/admin/metrics/sections?section=traffic&compare=true')
    expect(compared.status()).toBe(200)
    const badCompare = await harness.admin.api!.fetch('/api/admin/metrics/sections?section=traffic&compare=yes')
    expect(badCompare.status()).toBe(400)
    expect((await badCompare.json()).error).toBe('invalid_request')

    // Caller mistakes: unknown section, unknown range, and a variant that belongs to another section.
    for (const query of ['section=surveillance', 'section=traffic&range=18mo', 'section=search&variant=latency']) {
      const bad = await harness.admin.api!.fetch(`/api/admin/metrics/sections?${query}`)
      expect(bad.status(), query).toBe(400)
      expect((await bad.json()).error, query).toBe('invalid_request')
    }

    /**
     * The retention pass, which is the only path to a DELETE on the buckets.
     *
     * `builderhunt_app` writes the minutes and is not granted DELETE; `builderhunt_worker` is. So a 200 here
     * is the evidence that the worker role's grant is actually in place — a unit test cannot produce it,
     * because unit tests connect as a superuser and would succeed with no grant at all.
     */
    const retention = await harness.admin.api!.fetch('/api/admin/metrics/run-retention', { method: 'POST' })
    expect(retention.status()).toBe(200)
    const retentionBody = await retention.json()
    expect(retentionBody.retainDays).toBe(30)
    expect(typeof retentionBody.deletedCount).toBe('number')
    // Nothing in a fresh window is old enough to remove, and the pass must say so rather than fail.
    expect(retentionBody.deletedCount).toBeGreaterThanOrEqual(0)

    // And the guard is on all three routes, which is the failure eight copies of it would have hidden.
    for (const path of ['/api/admin/metrics/overview', '/api/admin/metrics/sections?section=runtime']) {
      const asTenant = await harness.tenant.api!.fetch(path)
      expect([401, 403], `${path} must refuse a tenant`).toContain(asTenant.status())
      const anonymous = await harness.anonymous.fetch(path)
      expect([401, 403], `${path} must refuse an anonymous caller`).toContain(anonymous.status())
    }
    // The retention trigger refuses the same callers, by POST — the method that actually deletes.
    const tenantRetention = await harness.tenant.api!.fetch('/api/admin/metrics/run-retention', { method: 'POST' })
    expect([401, 403]).toContain(tenantRetention.status())
    const anonRetention = await harness.anonymous.fetch('/api/admin/metrics/run-retention', { method: 'POST' })
    expect([401, 403]).toContain(anonRetention.status())
  })
})
