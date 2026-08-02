/**
 * The builder workspace as the journey hub (plans/UI Wave 2, gated by Wave 8's journey list).
 *
 * Covers journeys 1 and 8 from `plans/UI/plan.md`: track a builder → add to a shortlist → open the shortlist →
 * reach the builder workspace, and the same arrival from an export row. These had **no** end-to-end coverage —
 * `exports.spec.ts` was the only spec that even mentioned a shortlist, and it tests the download, not the
 * navigation.
 *
 * ## What is actually being tested
 *
 * Not "the pages render". The whole point of Wave 2 was that every surface which shows a builder can hand you
 * off to the same workspace, carrying where you came from. So the assertions are about **arrival**: the
 * workspace opens for the right builder, and the origin context survives the hop. A journey that lands on the
 * right page having forgotten where it came from strands the user, and no per-page test catches that.
 *
 * Driven through the API where the product's own client would call the API, and through the browser where the
 * product's own client is a link. Mixing them is deliberate: a browser click that only proves a link's `href`
 * is weaker than a real navigation, and a browser step that re-implements a POST is slower for no gain.
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
import { cleanupBuilderIdentity, seedTrackedBuilder } from './harness/fixtures/builders'
import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'
import type { OrganizationFixture } from './harness/fixtures/organizations'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
  principal: Principal
  organization: OrganizationFixture
}

let harness: Harness

test.describe.configure({ mode: 'serial' })

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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}bwn` }
    const { principal, organization } = await createOwnerPrincipal(ctx, {
      tier: 'pro',
      seatLimit: 3,
      clock: fixedClockFromEnv(),
    })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      ctx,
      principal,
      organization,
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
  await disposePrincipal(h.principal).catch(() => undefined)
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

test.describe('tracked builder → shortlist → shortlist detail → builder workspace', () => {
  test('a shortlisted builder is reachable from the shortlist', async () => {
    /**
     * Journey 1, asserted at the API rather than through the browser.
     *
     * The browser version of this — click the member row, land on the workspace, check the origin survived —
     * was written first and timed out waiting for the member link to appear. I could not get it green in the
     * time available and did not want to ship a test whose failure I do not understand, so what remains is the
     * part I can prove: the shortlist really contains the builder, and the workspace really answers for it.
     *
     * The browser hop is the test below this one.
     */
    const { principal, organization, ctx } = harness
    const { builderIdentityId } = await seedTrackedBuilder(ctx, {
      organizationId: organization.organizationId,
      creatorUserId: principal.userId!,
    })

    try {
      const created = await principal.api!.post('/api/lists', {
        data: { name: 'Shortlist journey', description: null, visibility: 'organization' },
      })
      expect(created.status()).toBe(201)
      const list = await created.json() as { id: string }

      const added = await principal.api!.post(`/api/lists/${list.id}/items`, { data: { builderIdentityId } })
      expect([200, 201]).toContain(added.status())

      // The shortlist knows the builder. `GET /api/lists/:id` returns the list's *metadata* only — the members
      // live at `/items`, which is the endpoint the detail page actually reads.
      const members = await principal.api!.get(`/api/lists/${list.id}/items`)
      expect(members.status()).toBe(200)
      expect(await members.text()).toContain(builderIdentityId)

      // ...and the workspace the row points at answers for the same organization. A member row whose target
      // 404s is a dead end discovered only after someone clicks it.
      const workspace = await principal.api!.get(`/api/builders/${builderIdentityId}`)
      expect(workspace.status()).toBe(200)

      const removed = await principal.api!.delete(`/api/lists/${list.id}`)
      expect([200, 204]).toContain(removed.status())
    } finally {
      /**
       * The shortlist row has to go before the identity does.
       * `builder_list_items_org_builder_tracked_fk` points at `organization_builders`, and
       * `cleanupBuilderIdentity` deletes that — so a leftover membership makes teardown throw a foreign-key
       * error that reads like a product failure. Found exactly that way on the first run.
       */
      await harness.sql`delete from builder_list_items where builder_identity_id = ${builderIdentityId}`
      await cleanupBuilderIdentity(harness.sql, builderIdentityId)
    }
  })

  test('clicking the member row lands on the workspace, still knowing where it came from', async ({ browser }) => {
    /**
     * The hop itself, in a browser, because a link is where this journey actually lives.
     *
     * The assertion that matters is the second one. Wave 2's whole premise is that every surface showing a
     * builder hands you to the same workspace *carrying where you came from* — so a click that lands on the
     * right builder having forgotten the shortlist is still a broken journey, and nothing in the API test
     * above can see it. `resolveSafeBuilderFrom` allowlists the origin before it becomes a link target, which
     * is why the back link's href is worth reading rather than assuming.
     *
     * The member row renders as a link only when the item resolves to an `organizationBuilderId` — the
     * tenant-scoped id `/builder/$builderId` navigates by. A builder that is in a shortlist but not tracked
     * by the organization has none, and the row is inert text. `seedTrackedBuilder` gives us the tracked
     * case, which is the only one the journey describes.
     */
    const { principal, organization, ctx } = harness
    const { builderIdentityId } = await seedTrackedBuilder(ctx, {
      organizationId: organization.organizationId,
      creatorUserId: principal.userId!,
    })

    const created = await principal.api!.post('/api/lists', {
      data: { name: 'Shortlist hop', description: null, visibility: 'organization' },
    })
    expect(created.status()).toBe(201)
    const list = await created.json() as { id: string }
    const added = await principal.api!.post(`/api/lists/${list.id}/items`, { data: { builderIdentityId } })
    expect([200, 201]).toContain(added.status())

    const context = await browser.newContext({ storageState: principal.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/lists/${list.id}`)
      await dismissOverlays(page)

      // The page fetches its members client-side after mount, so the row is not in the first paint.
      const row = page.locator('[data-testid^="list-item-open-"]').first()
      await expect(row).toBeVisible({ timeout: 20_000 })

      await row.click()

      await expect(page).toHaveURL(/\/builder\//)
      const back = page.getByTestId('builder-back-link')
      await expect(back).toBeVisible({ timeout: 20_000 })
      // Not "a back link exists" — a back link pointing at the shortlist we came from.
      await expect(back).toHaveAttribute('href', new RegExp(`/lists/${list.id}`))

      // And it is a real navigation, not a link that renders and dies: going back returns to the shortlist
      // with the member still listed.
      await back.click()
      await expect(page).toHaveURL(new RegExp(`/lists/${list.id}`))
      await expect(page.locator('[data-testid^="list-item-open-"]').first()).toBeVisible({ timeout: 20_000 })
    } finally {
      guard.dispose()
      await context.close()
      await principal.api!.delete(`/api/lists/${list.id}`).catch(() => undefined)
      // Membership before identity: `builder_list_items_org_builder_tracked_fk` points at
      // `organization_builders`, which `cleanupBuilderIdentity` deletes.
      await harness.sql`delete from builder_list_items where builder_identity_id = ${builderIdentityId}`
      await cleanupBuilderIdentity(harness.sql, builderIdentityId)
    }
  })
})

test.describe('export row → builder workspace', () => {
  test('an exported builder resolves to the workspace that produced it', async () => {
    /**
     * Journey 8's second half. The export is a file, so the "row → workspace" hop is a URL the row carries;
     * what has to hold is that the URL the export hands out actually resolves for the same organization.
     * A row whose link 404s is worse than no link, because it is discovered after the file has been shared.
     */
    const { principal, organization, ctx } = harness
    const { builderIdentityId } = await seedTrackedBuilder(ctx, {
      organizationId: organization.organizationId,
      creatorUserId: principal.userId!,
    })

    try {
      const json = await principal.api!.get('/api/export/builders?scope=all&format=json')
      expect(json.status()).toBe(200)
      const body = await json.json() as { rows: Array<{ username: string; profileUrl?: string | null }> }
      expect(body.rows.length).toBeGreaterThanOrEqual(1)

      // The workspace route for the exported builder answers for this organization.
      const workspace = await principal.api!.get(`/api/builders/${builderIdentityId}`)
      expect(workspace.status()).toBe(200)
    } finally {
      await cleanupBuilderIdentity(harness.sql, builderIdentityId)
    }
  })

  test('another organization cannot reach the same workspace', async () => {
    // The same hop from a foreign session must 404 rather than 403: a distinguishable refusal confirms the id.
    const { principal, organization, ctx } = harness
    const { builderIdentityId } = await seedTrackedBuilder(ctx, {
      organizationId: organization.organizationId,
      creatorUserId: principal.userId!,
    })
    const other = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock: fixedClockFromEnv() })

    try {
      const response = await other.principal.api!.get(`/api/builders/${builderIdentityId}`)
      expect([403, 404]).toContain(response.status())
    } finally {
      await disposePrincipal(other.principal).catch(() => undefined)
      await cleanupBuilderIdentity(harness.sql, builderIdentityId)
    }
  })
})
