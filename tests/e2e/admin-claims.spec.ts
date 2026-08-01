/**
 * plans/UI/tasks.md Wave 4 "Build Admin Claims UI and revocation flow".
 *
 * Runs the full browser flow — list, filter, open detail, revoke with a reason — against the real
 * `/admin/claims` page and the already-existing `/api/admin/builder-claims/$claimId/revoke`
 * endpoint, then proves the revoke took effect where it's supposed to: the portfolio 404s
 * immediately (`getPublicPortfolioClaim` rechecks `status = 'verified'` on every read, and the
 * route's cache is explicitly purged on revoke), and the directory profile's `isVerified` flips to
 * false — and that none of this is reachable by a non-platform-admin.
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
import { seedBuilderIdentity, seedOrganizationBuilder, cleanupBuilderIdentity } from './harness/fixtures/builders'
import {
  seedVerifiedBuilderClaim,
  seedPublishedBuilderProfile,
  cleanupBuilderClaim,
  cleanupPublishedBuilderProfile,
} from './harness/fixtures/builder-claims'
import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'

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

  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}claims`)
  registerPlatformAdminEnv(adminSeed)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}claims` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const admin = await createPlatformAdminPrincipal(ctx, adminSeed)
    // The admin drives the real /admin/claims page in a browser below — without an accepted ToS
    // record, the app blocks every page behind an "Updated Terms of Service" modal.
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

async function seedClaimedAndPublishedIdentity(portfolioPublished: boolean) {
  const { sql, ctx, owner, organization } = harness
  const { builderIdentityId } = await seedBuilderIdentity(sql, { scope: ctx.scope })
  await seedOrganizationBuilder(sql, {
    organizationId: organization.organizationId,
    builderIdentityId,
    creatorUserId: owner.userId!,
    scope: ctx.scope,
  })
  const { claimId } = await seedVerifiedBuilderClaim(sql, { builderIdentityId, subjectUserId: owner.userId!, scope: ctx.scope })
  await seedPublishedBuilderProfile(sql, { builderIdentityId, publishedByUserId: owner.userId! })
  if (portfolioPublished) {
    // `publishedAt` must be a strict ISO-8601 string with a `Z` suffix — `parsePortfolioSettings`
    // fail-closes to unpublished on anything `z.string().datetime()` rejects, which includes
    // Postgres's own `now()` text form (`+00:00` offset, not `Z`).
    await sql`
      update builder_claims
      set metadata = jsonb_build_object('portfolio', jsonb_build_object('published', true, 'publishedAt', ${new Date().toISOString()}::text))
      where id = ${claimId}
    `
  }
  return { builderIdentityId, claimId }
}

async function cleanupIdentity(builderIdentityId: string, claimId: string) {
  await cleanupBuilderClaim(harness.sql, claimId)
  await cleanupPublishedBuilderProfile(harness.sql, builderIdentityId)
  await cleanupBuilderIdentity(harness.sql, builderIdentityId)
}

test.describe('admin claims', () => {
  test('a platform admin can list and filter claims by status', async () => {
    const { builderIdentityId, claimId } = await seedClaimedAndPublishedIdentity(false)
    try {
      const list = await harness.admin.api!.get('/api/admin/builder-claims?status=verified')
      expect(list.status()).toBe(200)
      const body = await list.json() as { rows: Array<{ id: string; status: string }> }
      expect(body.rows.some((r) => r.id === claimId)).toBe(true)
      expect(body.rows.every((r) => r.status === 'verified')).toBe(true)
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })

  test('the API is unavailable to a non-platform-admin organization owner', async () => {
    const listResponse = await harness.owner.api!.get('/api/admin/builder-claims')
    expect(listResponse.status()).toBe(403)

    const revokeResponse = await harness.owner.api!.post('/api/admin/builder-claims/nonexistent-claim/revoke', {
      data: { reason: 'trying anyway' },
    })
    expect(revokeResponse.status()).toBe(403)
  })

  test('the route redirects a non-platform-admin away rather than rendering the page', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    guard.allowExpectedFailure(/status of 40[13]/)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/claims`)
      await expect(page.getByTestId('admin-claims-page')).toHaveCount(0)
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('revoking a claim (with a reason) invalidates the portfolio immediately and clears isVerified on the directory profile', async ({ browser }) => {
    const { builderIdentityId, claimId } = await seedClaimedAndPublishedIdentity(true)
    try {
      // Baseline: portfolio reachable, profile verified, before any revoke.
      const beforePortfolio = await fetch(`${harness.baseURL}/api/portfolio/${claimId}`)
      expect(beforePortfolio.status).toBe(200)
      const beforeProfile = await harness.owner.api!.get(`/api/builders/${builderIdentityId}`)
      expect((await beforeProfile.json()).isVerified).toBe(true)

      const context = await browser.newContext({ storageState: harness.admin.storageState! })
      const page = await context.newPage()
      const guard = expectStrictBrowser(page)
      try {
        await gotoHydrated(page, `${harness.baseURL}/admin/claims`)
        await dismissOverlays(page)
        await expect(page.getByTestId('admin-claims-page')).toBeVisible()
        await page.getByTestId(`admin-claim-detail-toggle-${claimId}`).click()
        await expect(page.getByTestId(`admin-claim-detail-${claimId}`)).toBeVisible()

        const confirmButton = page.getByTestId(`admin-claim-revoke-confirm-${claimId}`)
        // Reason is required — the button must stay disabled (not just silently no-op) until one
        // is entered, so an admin can't revoke a claim with no explanation on file.
        await expect(confirmButton).toBeDisabled()

        await page.getByTestId('admin-claim-revoke-reason').fill('Confirmed the account owner does not match the evidence.')
        await expect(confirmButton).toBeEnabled()
        await confirmButton.click()
        await expect(page.getByTestId(`admin-claim-detail-${claimId}`)).toHaveCount(0)

        guard.assertClean()
      } finally {
        guard.dispose()
        await context.close()
      }

      const [row] = await harness.sql<{ status: string; revoked_at: Date | null; revocation_reason: string | null }[]>`
        select status, revoked_at, revocation_reason from builder_claims where id = ${claimId}
      `
      expect(row.status).toBe('revoked')
      expect(row.revoked_at).not.toBeNull()
      expect(row.revocation_reason).toContain('does not match the evidence')

      const afterPortfolio = await fetch(`${harness.baseURL}/api/portfolio/${claimId}`)
      expect(afterPortfolio.status).toBe(404)

      const afterProfile = await harness.owner.api!.get(`/api/builders/${builderIdentityId}`)
      expect((await afterProfile.json()).isVerified).toBe(false)
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })
})
