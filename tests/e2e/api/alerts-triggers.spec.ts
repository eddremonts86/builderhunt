/**
 * The four `/api/alerts/*` trigger routes over real HTTP (plan 53, task 10 — none had an e2e spec).
 *
 * A trigger is a record that a specific builder matched a specific organization's saved alert. That makes the
 * payload organizational intelligence — who a competitor is watching and what they consider a signal — so the
 * interesting properties are all about the tenant boundary rather than the happy path.
 *
 * The one that is easy to get wrong: `PATCH /api/alerts/triggers/:id` answers **`200 { ok: false }`** for another
 * organization's trigger, not 404 or 403. Both a fabricated id and a real-but-someone-else's id produce the same
 * `ok: false`, so the response cannot be used to test whether a trigger id exists. This spec asserts that the two
 * cases are indistinguishable *and* that the other organization's row stays unread — a refusal that still wrote
 * would be worse than a leak, and `{ ok: false }` with a completed write would look identical from outside.
 *
 * `POST /api/alerts/test-trigger` is a development-only delivery probe: it returns a bare 404 when
 * `NODE_ENV === 'production'`. That refusal is asserted the only way it can be from here — by confirming the route
 * answers in a non-production worker — with the production branch left to the unit tests, since flipping NODE_ENV
 * on a running worker would change far more than this route.
 *
 * ## What the negative control showed, which is worth knowing
 *
 * Deleting the `organizationId` filter from `markOrganizationTriggerRead` does **not** break the cross-tenant test.
 * That is not a weakness in the test — it is defence in depth doing its job: the `alert_triggers_app_update` RLS
 * policy independently scopes every UPDATE to `app.organization_id`, so the repository's own filter is the second
 * lock rather than the only one. Either can be removed and the boundary still holds, which is exactly the property
 * worth having and exactly why a single-line removal cannot demonstrate it.
 *
 * The assertion is not vacuous, though, and the proof is the test above it: marking the caller's *own* trigger does
 * flip `read_at` to non-null, so the same query on a foreign row finding it still null is a real observation about
 * that row rather than a query that never runs.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { randomUUID } from 'node:crypto'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../harness/cache'
import { startWorkerServer, stopWorkerServer } from '../harness/server'
import { e2eEnv } from '../harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from '../harness/clock'
import { createOwnerPrincipal, type FixtureContext, type Principal } from '../harness/fixtures/principals'
import type { OrganizationFixture } from '../harness/fixtures/organizations'
import { seedConsent } from '../harness/fixtures/privacy'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'

interface Tenant {
  principal: Principal
  organization: OrganizationFixture
}

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  a: Tenant
  b: Tenant
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}alerts` }
    const clock = fixedClockFromEnv()

    const tenants: Tenant[] = []
    for (let index = 0; index < 2; index += 1) {
      const { principal, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
      await seedConsent(sql, { userId: principal.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })
      tenants.push({ principal, organization })
    }

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      a: tenants[0]!,
      b: tenants[1]!,
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
  await harness?.anonymous.dispose().catch(() => undefined)
  await harness?.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(harness.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(harness.workerIndex, harness.databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(harness.redisPrefix).catch(() => undefined)
})

/**
 * Seeds an alert and one matched trigger for it, directly.
 *
 * The production writer is the alerts worker; reproducing its matching logic here would test that logic twice and
 * leave these four routes still unproven. What the routes need is a row with a known organization and read state.
 */
async function seedTrigger(tenant: Tenant, label: string, readAt: Date | null = null): Promise<string> {
  const alertId = randomUUID()
  const triggerId = randomUUID()
  // `alert_triggers.builder_id` has a foreign key to `builders` — the org-scoped legacy table, not
  // `builder_identities` — so the row a trigger points at has to exist before the trigger can.
  const builderId = `e2e-alert-builder-${randomUUID().slice(0, 8)}`
  await harness.sql`
    insert into builders (id, organization_id, user_id, source, source_id, username, display_name, profile_url, created_at, updated_at)
    values (${builderId}, ${tenant.organization.organizationId}, ${tenant.principal.userId!}, 'github',
            ${builderId}, ${builderId}, ${`E2E ${label}`}, ${`https://e2e.test/github/${builderId}`}, now(), now())
  `
  await harness.sql`
    insert into alerts (id, user_id, organization_id, name, keywords, trigger_conditions, enabled)
    values (${alertId}, ${tenant.principal.userId!}, ${tenant.organization.organizationId},
            ${`e2e alert ${label}`}, ${harness.sql.json(['rust'])}, ${harness.sql.json({ minScore: 0 })}, true)
  `
  await harness.sql`
    insert into alert_triggers (id, alert_id, user_id, organization_id, builder_id, event_type, payload, matched_at, read_at)
    values (${triggerId}, ${alertId}, ${tenant.principal.userId!}, ${tenant.organization.organizationId},
            ${builderId}, 'new_match', ${harness.sql.json({ label })}, now(), ${readAt})
  `
  return triggerId
}

test.describe('GET /api/alerts/triggers', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.get('/api/alerts/triggers')
    expect(response.status()).toBe(401)
  })

  test('returns only the caller\'s organization triggers', async () => {
    const mine = await seedTrigger(harness.a, 'mine')
    const theirs = await seedTrigger(harness.b, 'theirs')

    const response = await harness.a.principal.api!.get('/api/alerts/triggers')
    expect(response.status(), await response.text()).toBe(200)
    const rows = await response.json() as Array<{ id: string }>
    const ids = rows.map((row) => row.id)

    // A trigger names a builder someone is watching, so a cross-tenant leak here is competitive intelligence, not
    // just a stray row. Both directions asserted: mine present makes theirs' absence meaningful.
    expect(ids).toContain(mine)
    expect(ids).not.toContain(theirs)
  })
})

test.describe('GET /api/alerts/triggers/unread-count', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.get('/api/alerts/triggers/unread-count')
    expect(response.status()).toBe(401)
  })

  test('counts only the caller\'s own unread triggers', async () => {
    const before = await harness.a.principal.api!.get('/api/alerts/triggers/unread-count')
    const { count: baseline } = await before.json() as { count: number }

    // One unread for A, one unread for B, one already-read for A. Only the first may move A's number.
    await seedTrigger(harness.a, `unread-${randomUUID().slice(0, 6)}`)
    await seedTrigger(harness.b, `other-unread-${randomUUID().slice(0, 6)}`)
    await seedTrigger(harness.a, `already-read-${randomUUID().slice(0, 6)}`, new Date())

    const after = await harness.a.principal.api!.get('/api/alerts/triggers/unread-count')
    expect(after.status(), await after.text()).toBe(200)
    const { count } = await after.json() as { count: number }
    expect(count, 'exactly one new unread trigger belongs to A').toBe(baseline + 1)
  })
})

test.describe('PATCH /api/alerts/triggers/$id', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.fetch(`/api/alerts/triggers/${randomUUID()}`, { method: 'PATCH' })
    expect(response.status()).toBe(401)
  })

  test('marks the caller\'s own trigger read', async () => {
    const triggerId = await seedTrigger(harness.a, `readable-${randomUUID().slice(0, 6)}`)
    const response = await harness.a.principal.api!.patch(`/api/alerts/triggers/${triggerId}`)
    expect(response.status(), await response.text()).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })

    const [row] = await harness.sql`select read_at from alert_triggers where id = ${triggerId}`
    expect(row.read_at, 'the row must actually be marked, not just reported as marked').not.toBeNull()
  })

  test('another organization\'s trigger is indistinguishable from one that never existed', async () => {
    /**
     * The anti-enumeration property of this route, and the reason it answers `{ ok: false }` rather than 404 or
     * 403: a real-but-foreign id and a fabricated one must look the same. Compared as whole responses — status and
     * body — because a differing status would separate them just as effectively as a differing body.
     */
    const theirs = await seedTrigger(harness.b, `foreign-${randomUUID().slice(0, 6)}`)

    const foreign = await harness.a.principal.api!.patch(`/api/alerts/triggers/${theirs}`)
    const fabricated = await harness.a.principal.api!.patch(`/api/alerts/triggers/${randomUUID()}`)

    expect(foreign.status()).toBe(fabricated.status())
    expect(await foreign.json()).toEqual(await fabricated.json())
    expect(foreign.status(), await foreign.text()).toBe(200)

    // And the write did not happen. `{ ok: false }` over a completed update would look identical from outside.
    const [row] = await harness.sql`select read_at from alert_triggers where id = ${theirs}`
    expect(row.read_at, 'B\'s trigger must still be unread after A tried to mark it').toBeNull()
  })
})

test.describe('POST /api/alerts/test-trigger', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.post('/api/alerts/test-trigger', { data: {} })
    // 401 from the guard, or 404 if this worker ever ran as production — both are refusals, and pinning the exact
    // one would make this assertion depend on NODE_ENV rather than on authentication.
    expect([401, 404]).toContain(response.status())
  })

  test('refuses a malformed body with 400 once the caller is known', async () => {
    const response = await harness.a.principal.api!.post('/api/alerts/test-trigger', { data: {} })
    expect(response.status(), await response.text()).toBe(400)
  })
})
