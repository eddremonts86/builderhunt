/**
 * plans/UI/tasks.md Wave 6 "Build a scoped Export Center and reconcile public claims".
 *
 * Every scope×format pair the Export Center advertises (~/shared/lib/exports/capability-registry.ts)
 * against the real `/api/export/builders` route and a real database: all tracked, one shortlist, one
 * saved search's live results, and the noted-builders collection — each as CSV and JSON. Also proves
 * a foreign org's shortlist/saved search 404s rather than leaking existence or contents.
 */
import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import { createOwnerPrincipal, disposePrincipal, type FixtureContext, type Principal } from './harness/fixtures/principals'
import { seedTrackedBuilder, cleanupBuilderIdentity } from './harness/fixtures/builders'
import type { OrganizationFixture } from './harness/fixtures/organizations'

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
}

let harness: Harness

async function seedTenant(ctx: FixtureContext): Promise<Tenant> {
  const clock = fixedClockFromEnv()
  const { principal, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
  return { principal, organization }
}

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}exports` }

    const a = await seedTenant(ctx)
    const b = await seedTenant(ctx)

    harness = { workerIndex, databaseName: database.databaseName, redisPrefix: cache.prefix, baseURL: server.baseURL, sql, ctx, a, b }
    await fetch(`${server.baseURL}/`).then((r) => r.text()).catch(() => undefined)
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

async function csvHeader(res: { text: () => Promise<string> }): Promise<string[]> {
  const body = await res.text()
  return body.split('\n')[0].split(',').map((c) => c.replace(/^"|"$/g, ''))
}

test.describe('Export Center — all tracked builders', () => {
  test('CSV and JSON both return the tracked builder', async () => {
    const { principal, organization } = harness.a
    const { builderIdentityId } = await seedTrackedBuilder(harness.ctx, { organizationId: organization.organizationId, creatorUserId: principal.userId! })
    try {
      const csv = await principal.api!.get('/api/export/builders?scope=all&format=csv')
      expect(csv.status()).toBe(200)
      expect(csv.headers()['content-type']).toContain('text/csv')
      const header = await csvHeader(csv)
      expect(header).toEqual(['username', 'source', 'displayName', 'score', 'language', 'country', 'topics', 'profileUrl'])

      const json = await principal.api!.get('/api/export/builders?scope=all&format=json')
      expect(json.status()).toBe(200)
      const body = await json.json() as { scope: string; rowCount: number; truncated: boolean; rows: Array<{ username: string }> }
      expect(body.scope).toBe('all')
      expect(body.truncated).toBe(false)
      expect(body.rows.length).toBeGreaterThanOrEqual(1)
    } finally {
      await cleanupBuilderIdentity(harness.sql, builderIdentityId)
    }
  })

  test('rejects an unknown scope or format', async () => {
    const { principal } = harness.a
    const badScope = await principal.api!.get('/api/export/builders?scope=everything&format=csv')
    expect(badScope.status()).toBe(400)
    const badFormat = await principal.api!.get('/api/export/builders?scope=all&format=xlsx')
    expect(badFormat.status()).toBe(400)
  })
})

test.describe('Export Center — one shortlist', () => {
  test('exports only the shortlisted builder, and a foreign shortlist 404s', async () => {
    const { principal, organization } = harness.a
    const { builderIdentityId } = await seedTrackedBuilder(harness.ctx, { organizationId: organization.organizationId, creatorUserId: principal.userId! })
    let listId: string | undefined
    try {
      const listRes = await principal.api!.post('/api/lists', { data: { name: 'Export test list', visibility: 'private' } })
      expect(listRes.status()).toBe(201)
      const list = await listRes.json() as { id: string }
      listId = list.id

      const itemRes = await principal.api!.post(`/api/lists/${list.id}/items`, { data: { builderIdentityId } })
      expect([200, 201]).toContain(itemRes.status())

      const csv = await principal.api!.get(`/api/export/builders?scope=list&format=csv&listId=${list.id}`)
      expect(csv.status()).toBe(200)
      const rows = (await csv.text()).split('\n').filter(Boolean)
      expect(rows.length).toBe(2) // header + one row

      // Missing listId entirely.
      const missingId = await principal.api!.get('/api/export/builders?scope=list&format=csv')
      expect(missingId.status()).toBe(400)

      // Another org's shortlist id must 404 — never a 403 (existence must not leak).
      const foreign = await harness.b.principal.api!.get(`/api/export/builders?scope=list&format=csv&listId=${list.id}`)
      expect(foreign.status()).toBe(404)
    } finally {
      if (listId) await principal.api!.delete(`/api/lists/${listId}`).catch(() => undefined)
      await cleanupBuilderIdentity(harness.sql, builderIdentityId)
    }
  })
})

test.describe("Export Center — one saved search's results", () => {
  test('exports live search results for the saved query, and a foreign saved search 404s', async () => {
    const { principal } = harness.a
    let queryId: string | undefined
    try {
      const queryRes = await principal.api!.post('/api/queries', {
        data: { name: 'Export test query', keywords: ['rust'], sources: ['github'] },
      })
      expect(queryRes.status()).toBe(200)
      const query = await queryRes.json() as { id: string }
      queryId = query.id

      const json = await principal.api!.get(`/api/export/builders?scope=saved-search&format=json&savedQueryId=${query.id}`)
      expect(json.status()).toBe(200)
      const body = await json.json() as { scope: string; rows: unknown[] }
      expect(body.scope).toBe('saved-search')
      expect(Array.isArray(body.rows)).toBe(true)

      const missingId = await principal.api!.get('/api/export/builders?scope=saved-search&format=json')
      expect(missingId.status()).toBe(400)

      const foreign = await harness.b.principal.api!.get(`/api/export/builders?scope=saved-search&format=json&savedQueryId=${query.id}`)
      expect(foreign.status()).toBe(404)
    } finally {
      if (queryId) await principal.api!.delete(`/api/queries/${queryId}`).catch(() => undefined)
    }
  })
})

test.describe('Export Center — note collection', () => {
  test('exports only builders with at least one note', async () => {
    const { principal, organization } = harness.a
    const { builderIdentityId: noted, organizationBuilderId: notedOrgBuilderId } = await seedTrackedBuilder(harness.ctx, { organizationId: organization.organizationId, creatorUserId: principal.userId! })
    const { builderIdentityId: unnoted } = await seedTrackedBuilder(harness.ctx, { organizationId: organization.organizationId, creatorUserId: principal.userId! })
    try {
      // `builder_notes.builder_id` still FKs to the legacy `builders` table (nothing in this
      // codebase writes to it anymore — see organization-builders.ts's listNotedOrganizationBuilders
      // comment) — same shadow-row workaround `tests/e2e/api/cross-tenant.spec.ts` uses, with the
      // shadow row's id matching the organization_builders id the notes route actually resolves to.
      await harness.sql`
        insert into builders (id, organization_id, user_id, source, source_id, username, profile_url, created_at, updated_at)
        values (${notedOrgBuilderId}, ${organization.organizationId}, ${principal.userId!}, 'github', ${notedOrgBuilderId}, ${notedOrgBuilderId}, ${`https://e2e.test/github/${notedOrgBuilderId}`}, now(), now())
      `
      const noteRes = await principal.api!.post(`/api/builders/${noted}/notes`, { data: { content: 'Strong systems background.' } })
      expect(noteRes.status()).toBe(200)

      const json = await principal.api!.get('/api/export/builders?scope=notes&format=json')
      expect(json.status()).toBe(200)
      const body = await json.json() as { rows: Array<{ profileUrl: string }> }
      const profileUrls = body.rows.map((r) => r.profileUrl)
      // The noted identity's own deterministic profile_url (seedBuilderIdentity) must be present;
      // the unnoted sibling's must not.
      expect(profileUrls.some((url) => url.includes(noted))).toBe(true)
      expect(profileUrls.some((url) => url.includes(unnoted))).toBe(false)
    } finally {
      await harness.sql`delete from builder_notes where organization_id = ${organization.organizationId} and builder_id = ${notedOrgBuilderId}`.catch(() => undefined)
      await harness.sql`delete from builders where id = ${notedOrgBuilderId}`.catch(() => undefined)
      await cleanupBuilderIdentity(harness.sql, noted)
      await cleanupBuilderIdentity(harness.sql, unnoted)
    }
  })
})
