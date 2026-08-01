/**
 * plans/UI/tasks.md Wave 6 "Add public/admin preview and profile/portfolio cross-links".
 *
 * The bidirectional builder-profile ↔ portfolio cross-link, and the portfolio-owner return-to-Account
 * link — all three gated on "the allowlisted public target exists" (published_builder_profiles row
 * for the reverse link, `builder_claims.metadata.portfolio.published` for the forward link, and the
 * viewer's own session for the owner link), proven against the real routes and a real database.
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
import { createOwnerPrincipal, createVerifiedPrincipal, type FixtureContext, type Principal } from './harness/fixtures/principals'
import type { OrganizationFixture } from './harness/fixtures/organizations'
import { seedConsent } from './harness/fixtures/privacy'
import { seedBuilderIdentity, cleanupBuilderIdentity } from './harness/fixtures/builders'
import {
  seedVerifiedBuilderClaim,
  seedPublishedBuilderProfile,
  cleanupBuilderClaim,
  cleanupPublishedBuilderProfile,
} from './harness/fixtures/builder-claims'
import { expectStrictBrowser, gotoHydrated } from './harness/browser'
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
  other: Principal
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

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}portfoliolinks` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const other = await createVerifiedPrincipal(ctx, 'other')
    await seedConsent(sql, { userId: owner.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })
    await seedConsent(sql, { userId: other.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })

    harness = { workerIndex, databaseName: database.databaseName, redisPrefix: cache.prefix, baseURL: server.baseURL, sql, ctx, owner, organization, other }
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

async function markPortfolioPublished(claimId: string, published: boolean) {
  if (!published) return
  await harness.sql`
    update builder_claims
    set metadata = jsonb_build_object('portfolio', jsonb_build_object('published', true, 'publishedAt', ${new Date().toISOString()}::text))
    where id = ${claimId}
  `
}

async function seedIdentityAndClaim(input: { directoryPublished: boolean; portfolioPublished: boolean }) {
  const { sql, ctx, owner } = harness
  const { builderIdentityId } = await seedBuilderIdentity(sql, { scope: ctx.scope })
  const { claimId } = await seedVerifiedBuilderClaim(sql, { builderIdentityId, subjectUserId: owner.userId!, scope: ctx.scope })
  if (input.directoryPublished) {
    await seedPublishedBuilderProfile(sql, { builderIdentityId, publishedByUserId: owner.userId! })
  }
  await markPortfolioPublished(claimId, input.portfolioPublished)
  return { builderIdentityId, claimId }
}

async function cleanupIdentity(builderIdentityId: string, claimId: string) {
  await cleanupBuilderClaim(harness.sql, claimId)
  await cleanupPublishedBuilderProfile(harness.sql, builderIdentityId)
  await cleanupBuilderIdentity(harness.sql, builderIdentityId)
}

test.describe('builder profile -> portfolio link', () => {
  test('links to the portfolio once it is published', async ({ browser }) => {
    const { builderIdentityId, claimId } = await seedIdentityAndClaim({ directoryPublished: true, portfolioPublished: true })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      const guard = expectStrictBrowser(page)
      // An anonymous visit to a builder profile fires a handful of session-gated background
      // fetches (session check, notes, dashboard stats) that 401 for a signed-out visitor — the
      // page itself already handles this gracefully (see BuilderProfilePage.tsx); expected, not a bug.
      for (let i = 0; i < 8; i++) guard.allowExpectedFailure(/status of 401/)
      try {
        await gotoHydrated(page, `${harness.baseURL}/builders/${builderIdentityId}`)
        const link = page.getByTestId('builder-portfolio-link')
        await expect(link).toBeVisible()
        await expect(link).toHaveAttribute('href', `/portfolio/${claimId}`)
        guard.assertClean()
      } finally {
        guard.dispose()
        await context.close()
      }
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })

  test('renders no link when the claim is verified but the portfolio was never published', async ({ browser }) => {
    const { builderIdentityId, claimId } = await seedIdentityAndClaim({ directoryPublished: true, portfolioPublished: false })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      const guard = expectStrictBrowser(page)
      for (let i = 0; i < 8; i++) guard.allowExpectedFailure(/status of 401/)
      try {
        await gotoHydrated(page, `${harness.baseURL}/builders/${builderIdentityId}`)
        await expect(page.getByTestId('builder-portfolio-link')).toHaveCount(0)
        guard.assertClean()
      } finally {
        guard.dispose()
        await context.close()
      }
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })

  test('renders no link for an unclaimed builder', async ({ browser }) => {
    const { sql, ctx } = harness
    const { builderIdentityId } = await seedBuilderIdentity(sql, { scope: ctx.scope })
    await seedPublishedBuilderProfile(sql, { builderIdentityId, publishedByUserId: harness.owner.userId! })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      const guard = expectStrictBrowser(page)
      for (let i = 0; i < 8; i++) guard.allowExpectedFailure(/status of 401/)
      try {
        await gotoHydrated(page, `${harness.baseURL}/builders/${builderIdentityId}`)
        await expect(page.getByTestId('builder-portfolio-link')).toHaveCount(0)
        guard.assertClean()
      } finally {
        guard.dispose()
        await context.close()
      }
    } finally {
      await cleanupPublishedBuilderProfile(sql, builderIdentityId)
      await cleanupBuilderIdentity(sql, builderIdentityId)
    }
  })
})

test.describe('portfolio -> builder profile link', () => {
  test('links back to the builder profile once the identity is publicly listed', async ({ browser }) => {
    const { builderIdentityId, claimId } = await seedIdentityAndClaim({ directoryPublished: true, portfolioPublished: true })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      const guard = expectStrictBrowser(page)
      try {
        await gotoHydrated(page, `${harness.baseURL}/portfolio/${claimId}`)
        const link = page.getByTestId('portfolio-builder-profile-link')
        await expect(link).toBeVisible()
        await expect(link).toHaveAttribute('href', `/builders/${builderIdentityId}`)
        guard.assertClean()
      } finally {
        guard.dispose()
        await context.close()
      }
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })

  test('renders no link when the identity has no published directory profile', async ({ browser }) => {
    const { builderIdentityId, claimId } = await seedIdentityAndClaim({ directoryPublished: false, portfolioPublished: true })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      const guard = expectStrictBrowser(page)
      try {
        await gotoHydrated(page, `${harness.baseURL}/portfolio/${claimId}`)
        await expect(page.getByTestId('public-portfolio')).toBeVisible()
        await expect(page.getByTestId('portfolio-builder-profile-link')).toHaveCount(0)
        guard.assertClean()
      } finally {
        guard.dispose()
        await context.close()
      }
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })
})

test.describe('portfolio owner return to Account', () => {
  test('the owner sees a link back to /me; a different signed-in user and an anonymous visitor do not', async ({ browser }) => {
    const { builderIdentityId, claimId } = await seedIdentityAndClaim({ directoryPublished: true, portfolioPublished: true })
    try {
      // Anonymous.
      const anonContext = await browser.newContext()
      const anonPage = await anonContext.newPage()
      const anonGuard = expectStrictBrowser(anonPage)
      try {
        await gotoHydrated(anonPage, `${harness.baseURL}/portfolio/${claimId}`)
        await expect(anonPage.getByTestId('portfolio-manage-link')).toHaveCount(0)
        anonGuard.assertClean()
      } finally {
        anonGuard.dispose()
        await anonContext.close()
      }

      // A different signed-in user — not the claim's subject.
      const otherContext = await browser.newContext({ storageState: harness.other.storageState! })
      const otherPage = await otherContext.newPage()
      const otherGuard = expectStrictBrowser(otherPage)
      try {
        await gotoHydrated(otherPage, `${harness.baseURL}/portfolio/${claimId}`)
        await expect(otherPage.getByTestId('portfolio-manage-link')).toHaveCount(0)
        otherGuard.assertClean()
      } finally {
        otherGuard.dispose()
        await otherContext.close()
      }

      // The owner.
      const ownerContext = await browser.newContext({ storageState: harness.owner.storageState! })
      const ownerPage = await ownerContext.newPage()
      const ownerGuard = expectStrictBrowser(ownerPage)
      try {
        await gotoHydrated(ownerPage, `${harness.baseURL}/portfolio/${claimId}`)
        const manageLink = ownerPage.getByTestId('portfolio-manage-link')
        await expect(manageLink).toBeVisible()
        await expect(manageLink).toHaveAttribute('href', '/me')
        ownerGuard.assertClean()
      } finally {
        ownerGuard.dispose()
        await ownerContext.close()
      }
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })
})
