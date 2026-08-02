/**
 * The organization core routes over real HTTP (plan 53, task 1 —
 * `plans/phase-1/53-exhaustive-local-e2e-design/tasks.md`).
 *
 * `cross-tenant.spec.ts` probes the *tenant-scoped resource* routes for an enumeration oracle. This file
 * covers the routes that manage the organization itself — list, create, switch, read the team, schedule and
 * cancel deletion — where the interesting failures are different in kind:
 *
 * - **Create and list are account-scoped, not tenant-scoped.** They key off the session user, not an active
 *   organization, so the boundary they must hold is "A never sees B's organization in a list" rather than
 *   "A is refused B's id".
 * - **Switch is the one route that changes what every later request means.** A test that only asserts its 200
 *   proves nothing: the assertion that matters is that the *next* tenant-scoped read comes from the new active
 *   organization. That is asserted here against `GET /api/organizations/team`.
 * - **Delete is deliberately not addressable.** It schedules the caller's *own* active organization; there is
 *   no id in the request. That is a design property worth a test, because the obvious "improvement" — accepting
 *   an id — would turn a safe route into a cross-tenant one.
 *
 * Two owners of two organizations, plus an anonymous context, all against one disposable database.
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
import type { OrganizationFixture } from '../harness/fixtures/organizations'

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
  /** No cookies at all — the 401 baseline every route below is measured against. */
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}orgapi` }
    const clock = fixedClockFromEnv()

    const a = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const b = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      a: { principal: a.principal, organization: a.organization },
      b: { principal: b.principal, organization: b.organization },
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
  await disposePrincipal(h.a.principal).catch(() => undefined)
  await disposePrincipal(h.b.principal).catch(() => undefined)
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

/**
 * Every route in this file, with a body the schema would *accept*.
 *
 * A valid body matters: an anonymous probe carrying `{}` proves only that the validator runs, and would pass
 * against a route with no authentication at all. The question here is whether a well-formed request from a
 * caller with no session is refused, so the body must be one the handler would otherwise act on.
 */
const ROUTES = [
  { method: 'GET', path: '/api/organizations', data: undefined },
  { method: 'POST', path: '/api/organizations', data: { name: 'Anonymous Attempt' } },
  { method: 'DELETE', path: '/api/organizations', data: undefined },
  { method: 'POST', path: '/api/organizations/switch', data: { organizationId: 'org-anonymous-attempt' } },
  { method: 'GET', path: '/api/organizations/team', data: undefined },
  { method: 'DELETE', path: '/api/organizations/deletion', data: undefined },
] as const

/** What `getTeamSnapshot` returns, narrowed to the fields asserted here. */
interface TeamSnapshot {
  organization: { id: string; name: string }
  viewerRole: string
  members: Array<Record<string, unknown>>
}

test.describe('anonymous access', () => {
  for (const route of ROUTES) {
    test(`${route.method} ${route.path} refuses a request with no session`, async () => {
      /**
       * Asserted per route rather than once for the group, because each of these reaches authentication by a
       * different path — `auth.api.getSession` directly in the index handlers, `requireTenantPrincipal` in the
       * others, and the lifecycle service for create. A single spot-check would leave the others unproven.
       */
      const response = await harness.anonymous.fetch(route.path, {
        method: route.method,
        ...(route.data ? { data: route.data } : {}),
      })
      expect(
        [401, 403],
        `${route.method} ${route.path} answered ${response.status()} to an anonymous caller`,
      ).toContain(response.status())
      // Nothing about the tenant may leak in the refusal body.
      const body = await response.text()
      expect(body).not.toContain(harness.a.organization.organizationId)
    })
  }

  test('POST /api/organizations authenticates before it validates', async () => {
    /**
     * Order matters here for a reason that is not obvious. With validation first, an anonymous caller gets 400
     * for `{}` and 401 for `{ name: "x" }` — so the request schema is readable from status codes alone by
     * someone with no session. Authentication was never bypassed; the leak was the *difference*.
     *
     * Found by this matrix and fixed in `src/routes/api/organizations/index.ts`.
     */
    const response = await harness.anonymous.post('/api/organizations', { data: {} })
    expect(response.status(), 'an empty body must be refused as unauthenticated, not as invalid').toBe(401)
  })
})

test.describe('GET /api/organizations', () => {
  test("lists the caller's own organizations and never another account's", async () => {
    const response = await harness.a.principal.api!.get('/api/organizations')
    expect(response.status(), await response.text()).toBe(200)
    const organizations = await response.json() as Array<Record<string, unknown>>

    expect(Array.isArray(organizations)).toBe(true)
    expect(organizations.map((row) => row.id)).toContain(harness.a.organization.organizationId)
    // The boundary this route actually has to hold: B's organization exists and is invisible.
    expect(organizations.map((row) => row.id)).not.toContain(harness.b.organization.organizationId)
  })

  test('returns a summary shape, not the raw row', async () => {
    // A DTO exists so that internal columns cannot reach a client by accident. Asserting the *absence* of
    // the fields is the half that catches a future `select *`.
    const response = await harness.a.principal.api!.get('/api/organizations')
    const [organization] = await response.json() as Array<Record<string, unknown>>
    expect(organization).toBeTruthy()
    expect(organization).toHaveProperty('id')
    expect(organization).toHaveProperty('name')
    expect(Object.keys(organization)).not.toContain('stripeCustomerId')
    expect(Object.keys(organization)).not.toContain('deletionRequestedAt')
  })
})

test.describe('POST /api/organizations', () => {
  test('creates an organization and returns its id, name and slug', async () => {
    const response = await harness.a.principal.api!.post('/api/organizations', {
      data: { name: 'E2E Created Org' },
    })
    expect(response.status(), await response.text()).toBe(200)
    const created = await response.json() as { id: string; name: string; slug: string }
    expect(created.id).toBeTruthy()
    expect(created.name).toBe('E2E Created Org')
    // The slug is derived, never accepted from the caller — a client-chosen slug is a squatting vector.
    expect(created.slug).toMatch(/^[a-z0-9-]+$/)

    const [row] = await harness.sql<{ id: string }[]>`
      select id from organizations where id = ${created.id}
    `
    expect(row?.id, 'the row really exists, not just the response').toBe(created.id)
  })

  test.describe('invalid bodies', () => {
    const CASES = [
      { label: 'missing name', data: {} },
      { label: 'name too short', data: { name: 'a' } },
      { label: 'name too long', data: { name: 'x'.repeat(81) } },
      { label: 'wrong type', data: { name: 42 } },
      { label: 'whitespace only', data: { name: '   ' } },
    ] as const

    for (const testCase of CASES) {
      test(`${testCase.label} is refused with 400`, async () => {
        const response = await harness.a.principal.api!.post('/api/organizations', { data: testCase.data })
        expect(response.status(), await response.text()).toBe(400)
      })
    }
  })

  test('ignores a caller-supplied slug and id rather than trusting them', async () => {
    /**
     * The schema is `z.object({ name })` with no passthrough, so extra keys are dropped rather than rejected.
     * That is a deliberate choice — but it only stays safe if the dropped keys really are dropped, which is
     * what this asserts. An id or slug honoured from the body would let a caller collide with another
     * organization's identifiers.
     */
    const squatted = 'org-squatted-by-client'
    const response = await harness.a.principal.api!.post('/api/organizations', {
      data: { name: 'E2E Extra Keys', id: squatted, slug: squatted, tier: 'enterprise' },
    })
    expect(response.status(), await response.text()).toBe(200)
    const created = await response.json() as { id: string; slug: string }
    expect(created.id).not.toBe(squatted)
    expect(created.slug).not.toBe(squatted)
  })
})

test.describe('POST /api/organizations/switch', () => {
  test('changes which organization the next tenant-scoped read answers for', async () => {
    /**
     * The whole point of the route. Asserting its 200 would prove nothing — what matters is that the *next*
     * request resolves a different active organization, because every tenant-scoped handler in the app depends
     * on that resolution.
     */
    const before = await harness.a.principal.api!.get('/api/organizations/team')
    expect(before.status(), await before.text()).toBe(200)
    const beforeTeam = await before.json() as TeamSnapshot
    expect(beforeTeam.organization.id).toBe(harness.a.organization.organizationId)

    const created = await harness.a.principal.api!.post('/api/organizations', {
      data: { name: 'E2E Switch Target' },
    })
    expect(created.status(), await created.text()).toBe(200)
    const target = await created.json() as { id: string }

    const switched = await harness.a.principal.api!.post('/api/organizations/switch', {
      data: { organizationId: target.id },
    })
    expect(switched.status(), await switched.text()).toBeLessThan(400)

    const after = await harness.a.principal.api!.get('/api/organizations/team')
    expect(after.status(), await after.text()).toBe(200)
    const afterTeam = await after.json() as TeamSnapshot
    expect(afterTeam.organization.id, 'the team snapshot follows the switch').toBe(target.id)
    expect(afterTeam.organization.id).not.toBe(beforeTeam.organization.id)

    // Put A back, so the ordering of the tests below does not depend on this one.
    const restored = await harness.a.principal.api!.post('/api/organizations/switch', {
      data: { organizationId: harness.a.organization.organizationId },
    })
    expect(restored.status(), await restored.text()).toBeLessThan(400)
  })

  test("refuses to switch into another account's organization", async () => {
    // Membership, not existence, is what authorizes a switch. A route that switched on existence alone would
    // hand any authenticated user a seat in every organization whose id they could guess.
    const response = await harness.a.principal.api!.post('/api/organizations/switch', {
      data: { organizationId: harness.b.organization.organizationId },
    })
    expect(response.status(), await response.text()).toBeGreaterThanOrEqual(400)

    const team = await harness.a.principal.api!.get('/api/organizations/team')
    const body = await team.text()
    expect(body, "B's organization must not become A's active one").not.toContain(
      harness.b.organization.organizationId,
    )
  })

  test('refuses a body with no organization id', async () => {
    const response = await harness.a.principal.api!.post('/api/organizations/switch', { data: {} })
    expect(response.status(), await response.text()).toBe(400)
  })
})

test.describe('GET /api/organizations/team', () => {
  test("answers for the caller's active organization only", async () => {
    const response = await harness.a.principal.api!.get('/api/organizations/team')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.text()
    expect(body).not.toContain(harness.b.organization.organizationId)
    expect(body).not.toContain(harness.b.principal.userId!)
  })

  test('never exposes a member password hash or session token', async () => {
    // The team snapshot joins users. Anything that reaches a client from that join is worth naming.
    const response = await harness.a.principal.api!.get('/api/organizations/team')
    const body = (await response.text()).toLowerCase()
    for (const forbidden of ['password', 'passwordhash', 'sessiontoken', 'twofactorsecret']) {
      expect(body, `the team payload leaks "${forbidden}"`).not.toContain(forbidden)
    }
  })
})

test.describe('DELETE /api/organizations', () => {
  test('schedules the caller’s own organization and is not addressable by id', async () => {
    /**
     * Deliberately id-less: the handler reads the active organization from the principal. This test pins that
     * design, because accepting an id here is the single most obvious "improvement" someone could make to this
     * route and it would convert it into a cross-tenant delete.
     *
     * Run against a throwaway organization rather than A's, so the rest of the file keeps a live tenant.
     */
    const created = await harness.a.principal.api!.post('/api/organizations', {
      data: { name: 'E2E Deletion Subject' },
    })
    const target = await created.json() as { id: string }
    const switched = await harness.a.principal.api!.post('/api/organizations/switch', {
      data: { organizationId: target.id },
    })
    expect(switched.status(), await switched.text()).toBeLessThan(400)

    // A body naming B's organization must have no effect whatsoever — the id is not read.
    const scheduled = await harness.a.principal.api!.fetch('/api/organizations', {
      method: 'DELETE',
      data: { organizationId: harness.b.organization.organizationId },
    })
    expect(scheduled.status(), await scheduled.text()).toBe(200)
    const result = await scheduled.json() as { ok: boolean; id: string; gracePeriodEndsAt: string }
    expect(result.ok).toBe(true)
    // `id` is the deletion *request* row, not the organization — asserted so a future reader does not repeat
    // the mistake this test made on its first run and read it as an organization id.
    expect(result.id).toBeTruthy()
    expect(result.id).not.toBe(harness.b.organization.organizationId)
    expect(Number.isNaN(Date.parse(result.gracePeriodEndsAt))).toBe(false)

    /**
     * Which organization got scheduled is a database question, and it is the one that matters.
     *
     * The schedule is a row in `organization_deletion_requests`, not a column on `organizations` — a soft
     * delete kept as its own record so the grace period, who asked, and the cancellation are all auditable.
     */
    const [scheduledRow] = await harness.sql<{ status: string }[]>`
      select status from organization_deletion_requests where organization_id = ${target.id}
    `
    expect(scheduledRow?.status, 'the active organization is the one that got scheduled').toBe('pending')

    const victim = await harness.sql<{ status: string }[]>`
      select status from organization_deletion_requests
      where organization_id = ${harness.b.organization.organizationId} and status = 'pending'
    `
    expect(victim.length, 'the id in the body had no effect on B').toBe(0)

    // Cancel, and prove the cancel really cleared the schedule.
    const cancelled = await harness.a.principal.api!.delete('/api/organizations/deletion')
    expect(cancelled.status(), await cancelled.text()).toBeLessThan(400)
    const pending = await harness.sql<{ status: string }[]>`
      select status from organization_deletion_requests
      where organization_id = ${target.id} and status = 'pending'
    `
    expect(pending.length, 'cancelling really clears the schedule').toBe(0)

    const restored = await harness.a.principal.api!.post('/api/organizations/switch', {
      data: { organizationId: harness.a.organization.organizationId },
    })
    expect(restored.status(), await restored.text()).toBeLessThan(400)
  })
})
