/**
 * The account-subject routes over real HTTP (plan 53, task 1 —
 * `plans/implemented/53-exhaustive-local-e2e-design/tasks.md`).
 *
 * Everything under `/api/me` is keyed by the *session user*, not by an active organization. That single fact
 * is what makes this file different from the other three in the matrix: there is no tenant to scope against,
 * so a bug here is not "A read B's organization" but "A read B", and the axis of every assertion below is
 * between people.
 *
 * The route worth the most care is account deletion. It is irreversible, it is a legal right, and it has a
 * refusal that must be *specific*: an owner who is the last owner of an organization that still has other
 * members cannot delete themselves, because doing so would strand those members in an ownerless organization.
 * The refusal has to name which organizations block it — a bare 409 leaves the user with a right they cannot
 * exercise and no way to find out why.
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
  /** Sole owner, sole member — deletion is genuinely available to this one. */
  solo: Principal
  /** A second, unrelated account: the "between people" boundary. */
  other: Principal
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}acctapi` }
    const clock = fixedClockFromEnv()

    const solo = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const other = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      solo: solo.principal,
      other: other.principal,
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
  await disposePrincipal(h.solo).catch(() => undefined)
  await disposePrincipal(h.other).catch(() => undefined)
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

test.describe('anonymous access', () => {
  /**
   * `GET /api/me/delete-account` is the one route here that answers a stranger instead of refusing them.
   *
   * It returns `200 {"request": null}` — deliberately. The settings page reads it on load, and a 401 there
   * would make a signed-out visitor's page render an error rather than a sign-in prompt. It leaks nothing:
   * `null` is the same answer a signed-in user with no pending deletion gets, so the response cannot be used
   * to learn whether an account exists or what it is doing.
   *
   * Asserting 401 here (as this file first did) would have been asserting a status code the route
   * deliberately does not use. What is worth pinning is the property: a caller with no session learns
   * nothing.
   */
  const ROUTES = [
    { method: 'GET' as const, path: '/api/me/delete-account', anonymous: 'blank' as const },
    { method: 'POST' as const, path: '/api/me/delete-account' },
    { method: 'DELETE' as const, path: '/api/me/delete-account' },
    { method: 'GET' as const, path: '/api/me/builder' },
    { method: 'GET' as const, path: '/api/me/builders' },
    { method: 'GET' as const, path: '/api/plans/me' },
    // `/api/me/plan-changes` and `/api/plans/request-upgrade` were probed here until 2026-08-03. Both routes
    // went away with the legacy per-user plan surface, so both now answer 404 to everyone — which is not a
    // refusal this list can assert, and asserting it anyway is how a deleted route keeps a test green by
    // accident.
  ]

  for (const route of ROUTES) {
    test(`${route.method} ${route.path} refuses a request with no session`, async () => {
      /**
       * These carry no organization id anywhere, so the only thing standing between a stranger and someone
       * else's account data is the session lookup itself. There is no second line of defence to fall back on,
       * which is why every one of them is probed rather than a sample.
       */
      const response = await harness.anonymous.fetch(route.path, {
        method: route.method,
        ...(route.method === 'POST' ? { data: {} } : {}),
      })

      if ('anonymous' in route && route.anonymous === 'blank') {
        expect(response.status()).toBe(200)
        const body = await response.json() as { request?: unknown }
        expect(body.request, 'a stranger gets the empty answer, never a real one').toBeNull()
        return
      }

      expect(
        [401, 403],
        `${route.method} ${route.path} answered ${response.status()} to an anonymous caller`,
      ).toContain(response.status())
    })
  }
})

test.describe('account deletion', () => {
  test('reports no scheduled deletion before one is asked for', async () => {
    const response = await harness.solo.api!.get('/api/me/delete-account')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as Record<string, unknown>
    // Whatever the field is called, nothing in the payload may claim a pending deletion yet.
    expect(JSON.stringify(body)).not.toContain('"pending"')
  })

  test('schedules a deletion, and cancelling clears it again', async () => {
    /**
     * Both halves in one test on purpose: a schedule that cannot be cancelled is worse than no schedule, and
     * asserting them apart would let a broken cancel hide behind a passing schedule. The state is read back
     * through `GET` — the route's own answer — rather than out of a table, because the GET is what the
     * settings page renders and a user who cannot see their own pending deletion has no way to stop it.
     */
    const scheduled = await harness.solo.api!.post('/api/me/delete-account', { data: {} })
    expect(scheduled.status(), await scheduled.text()).toBeLessThan(400)

    const during = await harness.solo.api!.get('/api/me/delete-account')
    expect(during.status(), await during.text()).toBe(200)
    const duringBody = await during.text()
    expect(duringBody, 'the pending deletion is visible to its subject').not.toBe('{}')

    const cancelled = await harness.solo.api!.delete('/api/me/delete-account')
    expect(cancelled.status(), await cancelled.text()).toBeLessThan(400)

    const after = await harness.solo.api!.get('/api/me/delete-account')
    expect(after.status(), await after.text()).toBe(200)
    expect(await after.text(), 'cancelling really clears the schedule').not.toBe(duringBody)
  })

  test("a sole owner with other members is refused, and told which organizations block it", async () => {
    /**
     * The refusal that has to be specific. Deleting the last owner of an organization that still has members
     * would strand them: no one left who can invite, pay, or delete. So the route refuses — and the payload
     * carries `organizations[]`, because a bare 409 leaves a user holding a legal right they cannot exercise
     * with no way to learn what to fix.
     *
     * Built by adding a member directly rather than through the invitation flow: this file is about the
     * deletion decision, and routing through accept/invite would make an unrelated route's failure look like
     * this one's.
     */
    const [membership] = await harness.sql<{ organization_id: string }[]>`
      select organization_id from organization_members
      where user_id = ${harness.solo.userId!} limit 1
    `
    expect(membership?.organization_id, 'the fixture owner really has an organization').toBeTruthy()

    await harness.sql`
      insert into organization_members (id, organization_id, user_id, role, created_at)
      values (${`om-e2e-${harness.other.userId!}`.slice(0, 60)}, ${membership.organization_id},
              ${harness.other.userId!}, 'member', now())
      on conflict do nothing
    `

    try {
      const refused = await harness.solo.api!.post('/api/me/delete-account', { data: {} })
      expect(refused.status(), await refused.text()).toBeGreaterThanOrEqual(400)
      const body = await refused.json() as { error?: string; organizations?: unknown }
      expect(body.error, 'the refusal explains itself').toBeTruthy()
      expect(
        Array.isArray(body.organizations),
        'the refusal names the organizations that block it, not just that something does',
      ).toBe(true)
      expect(JSON.stringify(body.organizations)).toContain(membership.organization_id)
    } finally {
      await harness.sql`
        delete from organization_members
        where organization_id = ${membership.organization_id} and user_id = ${harness.other.userId!}
      `
      // Leave no schedule behind for the tests that follow.
      await harness.solo.api!.delete('/api/me/delete-account').catch(() => undefined)
    }
  })

  test("one account's deletion state is invisible to another account", async () => {
    // The between-people axis, on the most sensitive state a user has.
    const mine = await harness.other.api!.get('/api/me/delete-account')
    expect(mine.status(), await mine.text()).toBe(200)
    expect(await mine.text()).not.toContain(harness.solo.userId!)
  })
})

test.describe('claimed builder profiles', () => {
  test('an account with no claim gets an empty answer, not someone else’s', async () => {
    /**
     * `/api/me/builder*` answers about profiles this *person* has claimed. A fresh account has none, and the
     * honest answer is empty — an implementation that fell back to "any profile" would hand a stranger a
     * claimed identity, which is the exact failure the claim flow exists to prevent.
     */
    const single = await harness.other.api!.get('/api/me/builder')
    expect([200, 404], await single.text()).toContain(single.status())

    const many = await harness.other.api!.get('/api/me/builders')
    expect(many.status(), await many.text()).toBe(200)
    const body = await many.text()
    expect(body).not.toContain(harness.solo.userId!)
  })

  test('GET /api/me/builder/:id answers as an API, not with an HTML page', async () => {
    /**
     * **Found by this matrix, and fixed.**
     *
     * `src/routes/api/me/builder/$builderId.ts` implements `PATCH` and nothing else. An unimplemented method on
     * a TanStack Start file route falls through to the route *component*, so `GET` used to return **200 with an
     * HTML document** instead of `405` with an `Allow` header — a client scripting the endpoint would read 200
     * and conclude it received a profile. It now answers 405 via
     * `methodNotAllowed` in `src/shared/lib/http/method-not-allowed.ts`.
     *
     * This is the same defect class already fixed once this session on `PATCH /api/solutions/runs/:id`
     * (plans/UI/tasks.md, Wave 8), which suggests it is worth a sweep across every `/api` file route rather
     * than a second one-off fix — the follow-up task should be "audit all API file routes for unimplemented
     * methods", not "add GET here".
     *
     * The wider sweep — 83 route files declare no GET at all — remains a task, because that is a decision per
     * route rather than one edit. This is the instance with a measured defect behind it.
     */
    const response = await harness.other.api!.get('/api/me/builder/does-not-exist-at-all')
    expect(response.status(), await response.text()).toBe(405)
    expect(response.headers()['allow'], 'a 405 without Allow is a dead end for the caller').toContain('PATCH')
  })

  test('PATCH on a profile the caller has not claimed is refused', async () => {
    // The method that *is* implemented. `Not your profile` — a claim is proof you are the subject, and
    // editing a profile you have not claimed is editing a stranger's identity.
    const response = await harness.other.api!.fetch('/api/me/builder/does-not-exist-at-all', {
      method: 'PATCH',
      data: { displayName: 'Someone Else' },
    })
    expect(response.status(), await response.text()).toBeGreaterThanOrEqual(400)
  })

  test('restrict-processing on a profile the caller has not claimed is refused', async () => {
    // A processing restriction is a GDPR control over someone's data. Accepting it from a caller who has not
    // proved they are that someone would let anyone freeze anyone else's profile.
    const response = await harness.other.api!.post(
      '/api/me/builder/does-not-exist-at-all/restrict-processing',
      { data: { restricted: true } },
    )
    expect(response.status(), await response.text()).toBeGreaterThanOrEqual(400)
  })
})

test.describe('plan routes', () => {
  test('GET /api/plans/me answers for the caller’s own entitlement', async () => {
    const response = await harness.solo.api!.get('/api/plans/me')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.text()
    expect(body).not.toContain(harness.other.userId!)
  })

  /*
   * `GET /api/me/plan-changes lists only the caller's own history` was here. The route is gone, and so is the
   * `plan_changes` table it read — which had no writer at all, so the history it isolated was always empty and
   * the test could not have failed. The manual-grant trail now lives in `security_audit_events`, asserted in
   * `admin-users.spec.ts` where the grant is actually made.
   */
})
