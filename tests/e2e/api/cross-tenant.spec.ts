/**
 * Cross-tenant runtime boundary (plan: exhaustive-local-e2e-design).
 *
 * `scripts/check-tenant-boundaries.mjs` enforces the *importer* boundary — no
 * route may reach the global database handle — and
 * `scripts/db/verify-api-isolation-local.mjs` exercises route handlers
 * in-process against two seeded tenants. Neither goes over real HTTP with a
 * real session, so neither covers the auth middleware, the cookie jar, or the
 * active-organization resolution that sits in front of every handler. This
 * spec does.
 *
 * The property under test is sharper than "a cross-tenant request is denied".
 * A route that answers 404 for a resource that does not exist and 403 for one
 * that exists in another tenant has told the caller that the second id is real.
 * Repeat that across an id space and it is an enumeration oracle: an attacker
 * learns which organizations hold which records without ever reading one.
 *
 * So each route is probed three ways as the SAME session A:
 *
 *   1. A's own id      → the baseline: what success looks like.
 *   2. B's real id     → must be indistinguishable from…
 *   3. a fabricated id → …the "no such thing" answer.
 *
 * (2) and (3) must agree on status, on the error key, and on body length.
 * Length matters because `{"error":"forbidden"}` and `{"error":"not_found"}`
 * differ in bytes even when both are 404s, and a length oracle is still an
 * oracle.
 */
import { test, expect, type APIRequestContext } from 'playwright/test'
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
import { uniqueId } from '../harness/ids'

interface Tenant {
  principal: Principal
  organization: OrganizationFixture
  /** A saved search owned by this tenant. */
  queryId: string
  /** A tracked builder owned by this tenant. */
  builderId: string
  /** An alert owned by this tenant. */
  alertId: string
  /** A sourcing sprint owned by this tenant. */
  sprintId: string
  /** A data-export request owned by this tenant's *user* (account-subject, not tenant). */
  exportId: string
}

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  a: Tenant
  b: Tenant
}

let harness: Harness

/** Seeds one tenant's private records directly, bypassing the routes under test. */
async function seedTenant(sql: Sql, ctx: FixtureContext, label: string): Promise<Tenant> {
  const clock = fixedClockFromEnv()
  const { principal, organization } = await createOwnerPrincipal(ctx, {
    tier: 'pro',
    seatLimit: 3,
    clock,
  })

  const queryId = uniqueId(`q-${label}`)
  const builderId = uniqueId(`b-${label}`)
  const alertId = uniqueId(`a-${label}`)
  const sprintId = uniqueId(`s-${label}`)
  const exportId = uniqueId(`e-${label}`)

  await sql`
    insert into saved_queries (id, organization_id, user_id, name, keywords, sources, created_at)
    values (${queryId}, ${organization.organizationId}, ${principal.userId!},
            ${`${label} saved search`}, '{}', '{}', now())
  `
  await sql`
    insert into alerts (id, organization_id, user_id, query_id, name, keywords, created_at)
    values (${alertId}, ${organization.organizationId}, ${principal.userId!}, ${queryId},
            ${`${label} alert`}, '{}', now())
  `
  await sql`
    insert into sourcing_sprints (id, organization_id, creator_user_id, name, criteria, variants, created_at)
    values (${sprintId}, ${organization.organizationId}, ${principal.userId!},
            ${`${label} sprint`}, '{}'::jsonb, '[]'::jsonb, now())
  `
  // The notes route resolves a builder through `organization_builders`/`builder_identities` —
  // the canonical, current tables — not the legacy `builders` table (superseded, unwritten).
  const identityId = uniqueId(`i-${label}`)
  await sql`
    insert into builder_identities (id, source, source_id, username, profile_url, created_at, updated_at)
    values (${identityId}, 'github', ${`xt-${label}`}, ${`xt-${label}`},
            ${`https://e2e.test/github/xt-${label}`}, now(), now())
  `
  await sql`
    insert into organization_builders (id, organization_id, builder_identity_id, creator_user_id)
    values (${builderId}, ${organization.organizationId}, ${identityId}, ${principal.userId!})
  `
  await sql`
    insert into builder_notes (id, organization_id, user_id, builder_id, content, created_at, updated_at)
    values (${uniqueId(`n-${label}`)}, ${organization.organizationId}, ${principal.userId!},
            ${builderId}, ${`${label} note`}, now(), now())
  `

  // Account-subject, not tenant-scoped: `/api/me/data-export/$id` keys off the
  // session's user id. The boundary it must hold is between *users*, which is a
  // different axis from the organization one and just as worth probing.
  await sql`
    insert into data_export_requests (id, user_id)
    values (${exportId}, ${principal.userId!})
  `

  return { principal, organization, queryId, builderId, alertId, sprintId, exportId }
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}xtenant` }

    const a = await seedTenant(sql, ctx, 'a')
    const b = await seedTenant(sql, ctx, 'b')

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      a,
      b,
    }

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

interface Probe {
  status: number
  /** The response's `error` field, when it has one — the discriminating key. */
  errorKey: string | null
  length: number
}

/**
 * An identifier of exactly the same length and shape as `id`, which cannot
 * exist: the last eight characters are replaced with a constant that no
 * generated id ever produces. Length parity is what makes the body-size
 * comparison below mean anything.
 */
function absentLike(id: string): string {
  const marker = '00000000'
  return id.length <= marker.length ? marker.slice(0, id.length) : id.slice(0, -marker.length) + marker
}

async function probe(api: APIRequestContext, path: string): Promise<Probe> {
  const response = await api.get(path)
  const text = await response.text()
  let errorKey: string | null
  try {
    const body = JSON.parse(text) as { error?: unknown }
    errorKey = typeof body.error === 'string' ? body.error : null
  } catch {
    // Not JSON at all — an HTML error page or an empty body. That is still a
    // distinguishable answer, and `length` below captures the difference.
    errorKey = null
  }
  return { status: response.status(), errorKey, length: text.length }
}

/**
 * The routes worth probing: tenant-private, addressed by an id in the path, and
 * readable with a plain GET. A route whose id is not tenant-scoped (changelog
 * slugs, public portfolios) is deliberately absent — it has no boundary to
 * cross.
 *
 * `/api/feeds/$searchId` is absent too, despite being tenant-scoped: it
 * authenticates with a capability token rather than the session, so A's own
 * request would fail the baseline. Its boundary is a different shape and
 * belongs in its own test.
 *
 * `/api/alerts/$id` and `/api/me/builder/$builderId` are absent for a duller
 * reason: neither exposes GET, only PATCH. A GET against them falls through to
 * the SPA document, which answers identically for every id — the negative
 * control below caught exactly that when they were first listed here.
 */
const ROUTES = [
  { name: 'sprint', path: (t: Tenant) => `/api/sprints/${t.sprintId}` },
  { name: 'builder notes', path: (t: Tenant) => `/api/builders/${t.builderId}/notes` },
  { name: 'data export', path: (t: Tenant) => `/api/me/data-export/${t.exportId}` },
] as const

test.describe('cross-tenant identifiers are indistinguishable from absent ones', () => {
  for (const route of ROUTES) {
    test(`${route.name} does not confirm that B's id exists`, async () => {
      const { a, b } = harness
      const api = a.principal.api!

      // The fabricated id must be the SAME LENGTH as B's, because these routes
      // answer with the SPA document and the requested id ends up inside it —
      // so a shorter placeholder produces a shorter body and the length
      // comparison below would fail on the placeholder rather than on any
      // information leak. Same length, same shape, guaranteed not to exist.
      const absentTenant: Tenant = {
        ...b,
        alertId: absentLike(b.alertId),
        builderId: absentLike(b.builderId),
        queryId: absentLike(b.queryId),
        sprintId: absentLike(b.sprintId),
        exportId: absentLike(b.exportId),
      }

      const [own, cross, absent] = await Promise.all([
        probe(api, route.path(a)),
        probe(api, route.path(b)),
        probe(api, route.path(absentTenant)),
      ])

      // Two negative controls, without which the real assertion is vacuous.
      // A route that denied everyone, or one that returned a constant, would
      // otherwise satisfy "B's id looks like an absent id" while proving
      // nothing at all.
      expect(own.status, `A must reach its own ${route.name}`).toBeLessThan(400)
      expect(
        own.status !== absent.status || own.length !== absent.length,
        `${route.name}: the route answers identically for a real and an absent id, `
        + 'so the cross-tenant comparison below cannot detect anything',
      ).toBe(true)

      // The actual property. Reported together so a failure shows all three.
      expect(
        { status: cross.status, errorKey: cross.errorKey },
        `${route.name}: B's id must answer exactly like an id that does not exist`,
      ).toEqual({ status: absent.status, errorKey: absent.errorKey })

      expect(
        cross.length,
        `${route.name}: response length distinguishes B's id from an absent one`,
      ).toBe(absent.length)
    })
  }
})

test.describe('routes that ignore client-supplied tenancy', () => {
  test('the team endpoint always answers for the session\'s own organization', async () => {
    const { a, b } = harness
    // `GET /api/organizations/team` takes no organization parameter by design;
    // the tenant comes from the session. Passing B's id as a query string must
    // change nothing — if it did, the tenant would be client-controlled.
    const plain = await a.principal.api!.get('/api/organizations/team')
    const spoofed = await a.principal.api!.get(
      `/api/organizations/team?organizationId=${encodeURIComponent(b.organization.organizationId)}`,
    )

    expect(plain.status()).toBe(200)
    expect(spoofed.status()).toBe(200)
    expect(await spoofed.text()).toBe(await plain.text())
  })

  test('changing a member role cannot reach into another organization', async () => {
    const { a, b } = harness
    // `params.memberId` is a *user* id and the organization comes from the
    // session, so A patching B's user id can only ever address "that user's
    // membership in A's organization" — which does not exist. This is the
    // severe case: a read that crosses the boundary leaks, a write that
    // crosses it demotes the owner of another organization.
    const before = await harness.sql<{ role: string }[]>`
      select role from organization_members
      where organization_id = ${b.organization.organizationId} and user_id = ${b.principal.userId!}
    `
    expect(before[0]?.role, 'B owns their own organization before A touches anything').toBe('owner')

    const crossTenant = await a.principal.api!.patch(
      `/api/organizations/members/${b.principal.userId!}`,
      { data: { role: 'member' } },
    )
    const nonexistent = await a.principal.api!.patch(
      `/api/organizations/members/${absentLike(b.principal.userId!)}`,
      { data: { role: 'member' } },
    )

    // Same answer for "a real user in another organization" and "no such user".
    expect(crossTenant.status()).toBe(nonexistent.status())
    expect(await crossTenant.text()).toBe(await nonexistent.text())
    expect(crossTenant.status(), 'the write must not be accepted').toBeGreaterThanOrEqual(400)

    const after = await harness.sql<{ role: string }[]>`
      select role from organization_members
      where organization_id = ${b.organization.organizationId} and user_id = ${b.principal.userId!}
    `
    expect(after[0]?.role, "B's role in B's own organization is untouched").toBe('owner')
  })

  test('creating an invitation refuses an organizationId in the body', async () => {
    const { a, b } = harness
    // The route's zod schema is `.strict()` since plan 59, so an `organizationId` is a rejected request
    // rather than a silently stripped field. What this test protects is unchanged and is asserted below:
    // no row lands in B, and — now — none lands in A either, because nothing was written at all.
    const email = `xt-${uniqueId('inv').slice(-10)}@test.invalid`
    const response = await a.principal.api!.post('/api/organizations/invitations', {
      data: { email, role: 'member', organizationId: b.organization.organizationId },
    })
    expect(response.status(), await response.text()).toBe(400)

    const rows = await harness.sql<{ organization_id: string }[]>`
      select organization_id from organization_invitations where email = ${email}
    `
    expect(rows, 'a refused body must not write to either organization').toHaveLength(0)
  })
})
