/**
 * `GET /api/builders/recent` and `GET /api/interviews/shared` (plan 53, task 10 — neither had an e2e spec).
 *
 * Both are tenant-scoped reads, and each carries one property that is only observable end to end.
 *
 * **`builders/recent` runs every row through `filterSuppressed`.** That is the read side of the profile-removal
 * flow covered in `privacy-profile-removal.spec.ts`: once someone proves control of their profile and it is
 * suppressed, they must stop appearing in the lists an organization browses. A removal that deletes rows but leaves
 * a cached projection serving the person is the failure that matters here, and it cannot be seen from either
 * feature alone — the suppression is written by one and honoured by the other.
 *
 * **`interviews/shared` is scoped by an active material grant, not by ownership.** It is deliberately a sibling of
 * the owner-scoped `GET /api/interviews/`, so the risk is the opposite of the usual one: not that it shows too
 * little, but that a list built from grants leaks an interview to someone whose grant was never made.
 *
 * ## The 60-second cache, which shapes how these tests are written
 *
 * `loadActiveSuppressionKeys` caches active suppressions for 60s **inside the app process**. Seeding a suppression
 * after a request has already warmed that cache would leave the suppressed builder visible for up to a minute, and
 * a test written that way would fail intermittently for a reason that looks like a product bug. So everything is
 * seeded in `beforeAll`, before any request, and visibility is asserted with a *second, unsuppressed* builder
 * rather than by re-reading the same one before and after.
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

interface SeededBuilder {
  identityId: string
  organizationBuilderId: string
  username: string
}

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  a: Tenant
  b: Tenant
  /** Tracked by A and visible. */
  visible: SeededBuilder
  /** Tracked by A but suppressed before the server ever answered a request. */
  suppressed: SeededBuilder
  /** Tracked by B only. */
  foreign: SeededBuilder
  anonymous: APIRequestContext
}

let harness: Harness

test.describe.configure({ mode: 'serial' })

async function seedTrackedBuilder(sql: Sql, tenant: Tenant, label: string): Promise<SeededBuilder> {
  const identityId = `e2e-ident-${label}-${randomUUID().slice(0, 8)}`
  const organizationBuilderId = `e2e-ob-${label}-${randomUUID().slice(0, 8)}`
  await sql`
    insert into builder_identities (id, source, source_id, username, display_name, profile_url)
    values (${identityId}, 'github', ${identityId}, ${identityId}, ${`E2E ${label}`}, ${`https://e2e.test/github/${identityId}`})
  `
  await sql`
    insert into organization_builders (id, organization_id, builder_identity_id, creator_user_id, visibility, status)
    values (${organizationBuilderId}, ${tenant.organization.organizationId}, ${identityId},
            ${tenant.principal.userId!}, 'private', 'tracked')
  `
  return { identityId, organizationBuilderId, username: identityId }
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}recentshared` }
    const clock = fixedClockFromEnv()

    const tenants: Tenant[] = []
    for (let index = 0; index < 2; index += 1) {
      const { principal, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
      await seedConsent(sql, { userId: principal.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })
      tenants.push({ principal, organization })
    }
    const [a, b] = tenants as [Tenant, Tenant]

    const visible = await seedTrackedBuilder(sql, a, 'visible')
    const suppressed = await seedTrackedBuilder(sql, a, 'suppressed')
    const foreign = await seedTrackedBuilder(sql, b, 'foreign')

    // Written here, before the first request, so the app's 60s suppression cache is populated with it on its very
    // first load rather than a minute later. See the file docblock.
    await sql`
      insert into profile_suppressions (id, source, source_id, normalized_profile_url_hash, reason)
      values (${randomUUID()}, 'github', ${suppressed.identityId}, ${`hash-${suppressed.identityId}`}, 'verified-removal')
    `

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      a,
      b,
      visible,
      suppressed,
      foreign,
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

interface RecentBuilderRow {
  id: string
  identityId: string
  username: string
  source: string
}

async function readRecent(tenant: Tenant): Promise<RecentBuilderRow[]> {
  const response = await tenant.principal.api!.get('/api/builders/recent')
  expect(response.status(), await response.text()).toBe(200)
  return response.json() as Promise<RecentBuilderRow[]>
}

test.describe('GET /api/builders/recent', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.get('/api/builders/recent')
    expect(response.status()).toBe(401)
  })

  test('lists the caller\'s own tracked builders and not the other tenant\'s', async () => {
    const rows = await readRecent(harness.a)
    const identityIds = rows.map((row) => row.identityId)
    expect(identityIds).toContain(harness.visible.identityId)
    expect(identityIds).not.toContain(harness.foreign.identityId)
  })

  test('omits a suppressed identity, while an unsuppressed one in the same list stays visible', async () => {
    /**
     * The read side of profile removal. Once someone proves control of their profile, they stop appearing in the
     * lists organizations browse — and the unsuppressed builder in the same response is what makes the absence
     * evidence of filtering rather than of an empty list.
     */
    const rows = await readRecent(harness.a)
    const identityIds = rows.map((row) => row.identityId)
    expect(identityIds).toContain(harness.visible.identityId)
    expect(identityIds, 'a suppressed identity must not be browsable').not.toContain(harness.suppressed.identityId)
  })

  test('exposes the identity id separately from the tracked-row id', async () => {
    // Documented on the route: the profile pages and `GET /api/builders/:id` key on `builder_identities.id`, so a
    // list that returned only `organization_builders.id` would build links that 404.
    const rows = await readRecent(harness.a)
    const row = rows.find((entry) => entry.identityId === harness.visible.identityId)
    expect(row, 'the seeded builder must be in the list').toBeTruthy()
    expect(row!.id).toBe(harness.visible.organizationBuilderId)
    expect(row!.identityId).toBe(harness.visible.identityId)
    expect(row!.id, 'the two ids are different things and must not be conflated').not.toBe(row!.identityId)
  })
})

test.describe('GET /api/interviews/shared', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.get('/api/interviews/shared')
    expect(response.status()).toBe(401)
  })

  test('is empty for a caller who holds no material grant', async () => {
    /**
     * The default, and the one that matters most for a list built from grants rather than ownership: with no grant
     * anywhere, the answer is an empty list — not the owner's interviews, and not everything in the tenant.
     *
     * The populated case needs a booked interview with `event_participants.material_access_granted` set for a
     * non-owner, which the interview harness builds; it belongs with that fixture rather than duplicated here, and
     * is noted in the plan as the remaining half.
     */
    const response = await harness.a.principal.api!.get('/api/interviews/shared')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as { interviews: unknown[] }
    expect(Array.isArray(body.interviews)).toBe(true)
    expect(body.interviews).toHaveLength(0)
  })

  test('never returns the other tenant\'s interviews either', async () => {
    const response = await harness.b.principal.api!.get('/api/interviews/shared')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as { interviews: unknown[] }
    expect(body.interviews).toHaveLength(0)
  })
})

test.describe('POST /api/builders/track — retired sources', () => {
  /**
   * Tracking is the one path that *persists* a person: `organization_builders`, then
   * `upsertEmbeddingStubs` into `builder_embeddings` (pgvector) and `recordIngestedSourceObservations`
   * into `public_source_observations`. Searching only caches, five minutes, in memory and Redis.
   *
   * `sourcehut` and `hashnode` were retired on 2026-08-04 with their connectors deleted (drizzle/0143,
   * 0144), and this route's zod enum went on accepting both for a further day — so a source the product
   * could no longer read was still a source it would index a person from, on nothing but a
   * client-supplied payload. For `sourcehut` that is the sharper edge: sr.ht's robots policy disallows
   * "anything used to feed a machine learning model", and this route is exactly how a sr.ht profile
   * would have reached the vector index.
   *
   * End-to-end rather than a unit assertion on the schema, because what is being pinned is that the
   * *deployed route* refuses the payload — a zod enum is easy to widen and nothing else would notice.
   */
  for (const retired of ['sourcehut', 'hashnode'] as const) {
    test(`refuses a ${retired} payload`, async () => {
      const sourceId = `e2e-${retired}-${randomUUID().slice(0, 8)}`
      const response = await harness.a.principal.api!.post('/api/builders/track', {
        data: {
          source: retired,
          sourceId,
          username: sourceId,
          displayName: `E2E ${retired}`,
          profileUrl: retired === 'sourcehut' ? `https://sr.ht/~${sourceId}` : `https://hashnode.com/@${sourceId}`,
          topics: [],
        },
      })
      expect(response.status(), await response.text()).toBe(400)

      // And nothing was written on the way to the rejection.
      const identities = await harness.sql<{ count: string }[]>`
        select count(*)::text as count from builder_identities where source_id = ${sourceId}
      `
      expect(identities[0]?.count, `a rejected ${retired} track still created an identity`).toBe('0')
      const embedded = await harness.sql<{ count: string }[]>`
        select count(*)::text as count from builder_embeddings where source_id = ${sourceId}
      `
      expect(embedded[0]?.count, `a rejected ${retired} track still reached the vector index`).toBe('0')
    })
  }

  test('still accepts a live source, so the enum was narrowed and not broken', async () => {
    const sourceId = `e2e-live-${randomUUID().slice(0, 8)}`.toLowerCase()
    const response = await harness.a.principal.api!.post('/api/builders/track', {
      data: {
        source: 'github',
        sourceId,
        username: sourceId,
        displayName: 'E2E Live',
        profileUrl: `https://github.com/${sourceId}`,
        topics: [],
      },
    })
    expect(response.status(), await response.text()).toBeLessThan(400)
  })
})
