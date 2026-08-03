/**
 * `GET /api/organizations/activity` and `POST /api/organizations/deletion/immediate` (plan 53, task 10 — neither
 * had an e2e spec).
 *
 * Two routes with nothing in common except that both make a claim in a comment that only a real request can check.
 *
 * The activity route says it "NEVER derives the organization from anything but the principal — there is no
 * `?organizationId=` parameter, no header to spoof, no fallback". A spoofing attempt is a one-line request and the
 * claim is worth exactly the test that tries it, so this spec asks for another organization's feed by every route
 * the comment rules out.
 *
 * The immediate-deletion route is the most destructive endpoint in the product: no 30-day grace period, subscription
 * cancelled, product data gone. Its confirmation contract exists precisely because a scripted call could otherwise
 * skip what the UI enforces, so that contract is asserted from a script — which is the thing the UI cannot prove.
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
  ctx: FixtureContext
  a: Tenant
  b: Tenant
  anonymous: APIRequestContext
}

let harness: Harness

test.describe.configure({ mode: 'serial' })

async function makeTenant(ctx: FixtureContext, sql: Sql): Promise<Tenant> {
  const clock = fixedClockFromEnv()
  const { principal, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
  await seedConsent(sql, { userId: principal.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })
  return { principal, organization }
}

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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}orgact` }

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      ctx,
      a: await makeTenant(ctx, sql),
      b: await makeTenant(ctx, sql),
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

/** Inserts an activity row directly: the emit path belongs to the features that write it, not to this route. */
async function seedActivity(organizationId: string, actorUserId: string, targetKey: string, occurredAt: Date) {
  await harness.sql`
    insert into organization_activity (organization_id, actor_user_id, type, version, target_key, metadata, idempotency_key, occurred_at)
    values (${organizationId}, ${actorUserId}, 'builder_list_created', 1, ${targetKey},
            ${harness.sql.json({ name: targetKey })}, ${`e2e-act-${randomUUID()}`}, ${occurredAt})
  `
}

interface ActivityRow {
  id: string
  type: string
  version: number
  targetKey: string
  actorUserId: string | null
  occurredAt: string
  metadata: Record<string, unknown>
}

test.describe('GET /api/organizations/activity', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.get('/api/organizations/activity')
    expect(response.status()).toBe(401)
  })

  test('returns only the caller\'s own organization rows, never the other tenant\'s', async () => {
    const aKey = `a-list-${randomUUID().slice(0, 8)}`
    const bKey = `b-list-${randomUUID().slice(0, 8)}`
    await seedActivity(harness.a.organization.organizationId, harness.a.principal.userId!, aKey, new Date('2026-07-01T10:00:00Z'))
    await seedActivity(harness.b.organization.organizationId, harness.b.principal.userId!, bKey, new Date('2026-07-01T11:00:00Z'))

    const response = await harness.a.principal.api!.get('/api/organizations/activity')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as { rows: ActivityRow[] }
    const keys = body.rows.map((row) => row.targetKey)

    // Both halves matter: seeing A's row proves the feed is not simply empty, which is what makes the absence of
    // B's row evidence of isolation rather than evidence of a broken query.
    expect(keys).toContain(aKey)
    expect(keys).not.toContain(bKey)
  })

  test('ignores a client-supplied organizationId — there is no such parameter to spoof', async () => {
    /**
     * The route's own comment claims this. A query parameter the handler never reads is invisible in review and
     * trivial to add later by accident, so the claim is worth the request that tries it: B's id is passed three
     * ways, and A's feed must come back unchanged each time.
     */
    const baseline = await harness.a.principal.api!.get('/api/organizations/activity')
    const expected = (await baseline.json() as { rows: ActivityRow[] }).rows.map((row) => row.id)
    // An empty baseline would make every comparison below `[] === []`, which passes while proving nothing.
    expect(expected.length, 'A needs at least one activity row for the comparison to mean anything').toBeGreaterThan(0)

    const spoofed = [
      `/api/organizations/activity?organizationId=${harness.b.organization.organizationId}`,
      `/api/organizations/activity?organization_id=${harness.b.organization.organizationId}`,
      `/api/organizations/activity?orgId=${harness.b.organization.organizationId}`,
    ]
    for (const path of spoofed) {
      const response = await harness.a.principal.api!.get(path)
      expect(response.status(), `${path} answered ${response.status()}`).toBe(200)
      const rows = (await response.json() as { rows: ActivityRow[] }).rows
      expect(rows.map((row) => row.id), `${path} changed the result set`).toEqual(expected)
    }
  })

  test('rejects a half-supplied keyset cursor with 422', async () => {
    // `before` without `id` is an ambiguous keyset: the route refuses rather than silently returning the same page
    // twice, which is the failure a client would never notice.
    const response = await harness.a.principal.api!.get('/api/organizations/activity?before=2026-07-01T10:00:00.000Z')
    expect(response.status(), await response.text()).toBe(422)
    expect(await response.json()).toMatchObject({ error: 'invalid_cursor' })
  })

  test('paginates by keyset without repeating a row', async () => {
    const scope = randomUUID().slice(0, 8)
    for (let index = 0; index < 3; index += 1) {
      await seedActivity(
        harness.a.organization.organizationId,
        harness.a.principal.userId!,
        `page-${scope}-${index}`,
        new Date(Date.UTC(2026, 6, 2, 10, index)),
      )
    }

    const first = await harness.a.principal.api!.get('/api/organizations/activity?limit=1')
    const firstRows = (await first.json() as { rows: ActivityRow[] }).rows
    expect(firstRows).toHaveLength(1)

    const cursor = firstRows[0]!
    const second = await harness.a.principal.api!.get(
      `/api/organizations/activity?limit=1&before=${encodeURIComponent(cursor.occurredAt)}&id=${cursor.id}`,
    )
    expect(second.status(), await second.text()).toBe(200)
    const secondRows = (await second.json() as { rows: ActivityRow[] }).rows
    expect(secondRows).toHaveLength(1)
    // The whole point of a keyset cursor over an offset: page two cannot hand back page one's row.
    expect(secondRows[0]!.id).not.toBe(cursor.id)
  })

  test('rejects a limit outside the documented bounds', async () => {
    for (const limit of ['0', '201', 'abc']) {
      const response = await harness.a.principal.api!.get(`/api/organizations/activity?limit=${limit}`)
      expect(response.status(), `limit=${limit} answered ${response.status()}`).toBe(422)
    }
  })
})

test.describe('POST /api/organizations/deletion/immediate', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.post('/api/organizations/deletion/immediate', {
      data: { confirmOrganizationName: 'anything' },
    })
    expect(response.status()).toBe(401)
  })

  test('refuses an empty body with 400 once the caller is known', async () => {
    const response = await harness.a.principal.api!.post('/api/organizations/deletion/immediate', { data: {} })
    expect(response.status(), await response.text()).toBe(400)
  })

  test('refuses a wrong organization name — the confirmation is re-checked server-side', async () => {
    /**
     * The UI gates its own button on a type-to-confirm match, and this is the assertion that the gate is not only
     * in the UI. A scripted call skipping the confirmation is exactly the caller this check exists for.
     */
    const response = await harness.a.principal.api!.post('/api/organizations/deletion/immediate', {
      data: { confirmOrganizationName: 'Not The Right Name' },
    })
    expect(response.status(), await response.text()).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'Organization name does not match' })

    // And nothing happened: the organization is still there, undeleted.
    const [row] = await harness.sql`select id from organizations where id = ${harness.a.organization.organizationId}`
    expect(row).toBeTruthy()
  })

  test('refuses an unknown extra field — the body schema is strict', async () => {
    // `.strict()` is deliberate on the most destructive endpoint in the product: a caller passing something this
    // route does not understand is a caller who believes it does something it does not.
    const response = await harness.a.principal.api!.post('/api/organizations/deletion/immediate', {
      data: { confirmOrganizationName: harness.a.organization.name, unexpectedFlag: true },
    })
    expect(response.status(), await response.text()).toBe(400)

    const [row] = await harness.sql`select id from organizations where id = ${harness.a.organization.organizationId}`
    expect(row, 'a rejected body must not have deleted anything').toBeTruthy()
  })

  test('deletes the organization when the owner confirms the exact name', async () => {
    /**
     * Runs against a **dedicated throwaway tenant**, created here rather than reused from the harness: this test
     * really does destroy an organization, and pointing it at `a` or `b` would silently break every later
     * assertion in the file. Ordering is not what protects them — a separate subject is.
     */
    const victim = await makeTenant(harness.ctx, harness.sql)
    const response = await victim.principal.api!.post('/api/organizations/deletion/immediate', {
      data: { confirmOrganizationName: victim.organization.name },
    })
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as { ok: boolean; requestId: string }
    expect(body.ok).toBe(true)
    expect(body.requestId, 'an audit trail needs an id for the action that just happened').toBeTruthy()

    // Immediate means immediate: no grace period, so the row is gone rather than flagged for later.
    const rows = await harness.sql`select id from organizations where id = ${victim.organization.organizationId}`
    expect(rows).toHaveLength(0)
  })
})
