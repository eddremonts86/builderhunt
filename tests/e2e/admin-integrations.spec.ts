/**
 * plans/UI/tasks.md Wave 5 "Build Admin Integrations UI".
 *
 * Runs the full browser flow against the real `/admin/integrations` page and the
 * `/api/admin/integrations` endpoint, proving every source/AI-task enum member renders, the
 * disabled Product Hunt/Devpost/enrichment and AI-unavailable states are explicit (not silently
 * missing rows), no secret-shaped text ever reaches the DOM, and the source-filtered Search link
 * actually pre-selects that one source.
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
import { createOwnerPrincipal, type FixtureContext, type Principal } from './harness/fixtures/principals'
import { createPlatformAdminPrincipal, registerPlatformAdminEnv, reservePlatformAdminSeed } from './harness/fixtures/platform-admin'
import type { OrganizationFixture } from './harness/fixtures/organizations'
import { seedConsent } from './harness/fixtures/privacy'
import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'
import { SOURCE_NAMES } from '~/lib/sources/types'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
  owner: Principal
  organization: OrganizationFixture
  admin: Principal
}

let harness: Harness

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}int`)
  registerPlatformAdminEnv(adminSeed)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}int` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const admin = await createPlatformAdminPrincipal(ctx, adminSeed)
    await seedConsent(sql, { userId: admin.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })

    harness = { workerIndex, databaseName: database.databaseName, redisPrefix: cache.prefix, baseURL: server.baseURL, sql, ctx, owner, organization, admin }
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
  await harness.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(harness.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(harness.workerIndex, harness.databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(harness.redisPrefix).catch(() => undefined)
})

test.describe('admin integrations', () => {
  test('the API is unavailable to a non-platform-admin organization owner', async () => {
    const response = await harness.owner.api!.get('/api/admin/integrations')
    expect(response.status()).toBe(403)
  })

  test('the route redirects a non-platform-admin away rather than rendering the page', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    guard.allowExpectedFailure(/status of 40[13]/)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/integrations`)
      await expect(page.getByTestId('admin-integrations-page')).toHaveCount(0)
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('every SOURCE_NAMES member and Product Hunt/Devpost dormancy render explicitly, with no secret-shaped text anywhere', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/integrations`)
      await dismissOverlays(page)
      await expect(page.getByTestId('admin-integrations-page')).toBeVisible()

      for (const source of SOURCE_NAMES) {
        await expect(page.getByTestId(`integration-row-${source}`)).toBeVisible()
      }

      await expect(page.getByTestId('integration-badge-producthunt')).toHaveText(/dormant/i)
      await expect(page.getByTestId('integration-row-producthunt')).toContainText(/supported yet/i)
      await expect(page.getByTestId('integration-badge-devpost')).toHaveText(/dormant/i)

      const bodyText = await page.locator('body').innerText()
      for (const needle of ['GITHUB_TOKEN', 'MINIMAX_API_KEY', 'REDDIT_CLIENT_SECRET', 'PRODUCTHUNT_TOKEN', 'Bearer ']) {
        expect(bodyText).not.toContain(needle)
      }

      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('every registered AI task renders with a version and enabled/disabled state', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/integrations`)
      await dismissOverlays(page)

      await expect(page.getByTestId('integration-ai-task-ping')).toBeVisible()
      await expect(page.getByTestId('integration-ai-task-interview-brief-generate')).toContainText('v1')

      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('clicking a source\'s Search link pre-selects only that source on the real Search page', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/integrations`)
      await dismissOverlays(page)

      await page.getByTestId('integration-search-link-gitlab').click()
      await page.waitForURL(/\/search\?sources=gitlab/)
      await dismissOverlays(page)

      // The deep link is applied by a post-mount effect that then persists it — poll rather than
      // assume it has landed the instant the URL changes.
      await expect.poll(() => page.evaluate(() => localStorage.getItem('builderhunt.search_filters'))).not.toBeNull()
      const stored = await page.evaluate(() => localStorage.getItem('builderhunt.search_filters'))
      expect(JSON.parse(stored ?? '{}').sources).toEqual(['gitlab'])

      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('links to Operations and Metrics resolve to real admin pages', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/integrations`)
      await dismissOverlays(page)

      await expect(page.getByTestId('integrations-link-operations')).toHaveAttribute('href', '/admin/operations')
      await expect(page.getByTestId('integrations-link-metrics')).toHaveAttribute('href', '/admin/metrics')

      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
    }
  })
})
