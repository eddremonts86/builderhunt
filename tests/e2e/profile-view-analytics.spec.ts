/**
 * plans/UI/tasks.md Wave 4 "Record profile views and show owner aggregates".
 *
 * Runs `POST/GET /api/builders/:builderId/views` over real HTTP with real sessions — the write
 * path's consent gate and the read path's verified-owner gate both depend on the auth middleware
 * and tenant-context resolution in front of the handler, not just the handler body.
 *
 * What matters:
 *   1. An eligible (signed-in, consented) view aggregates, and a repeat view the same day does not
 *      double-count — "once per policy" means once per (viewer, builder, day), not once ever.
 *   2. Ineligible callers fail quietly with a distinguishable status: signed-out is 401, signed-in
 *      but not consented is 451 — never a 500, never a silent no-op that looks like success.
 *   3. Only the verified claimant of the builder identity can read the aggregate — a stranger and
 *      an unverified (pending) claimant both get 403, not a redacted-but-200 response.
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
import type { OrganizationFixture } from './harness/fixtures/organizations'
import { seedConsent } from './harness/fixtures/privacy'
import { seedBuilderIdentity, seedOrganizationBuilder, cleanupBuilderIdentity } from './harness/fixtures/builders'
import {
  seedVerifiedBuilderClaim,
  seedPublishedBuilderProfile,
  cleanupBuilderClaim,
  cleanupPublishedBuilderProfile,
} from './harness/fixtures/builder-claims'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
  claimant: Principal
  claimantOrg: OrganizationFixture
  viewer: Principal
  viewerOrg: OrganizationFixture
  stranger: Principal
  strangerOrg: OrganizationFixture
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}pva` }
    const clock = fixedClockFromEnv()

    const { principal: claimant, organization: claimantOrg } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const { principal: viewer, organization: viewerOrg } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const { principal: stranger, organization: strangerOrg } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })

    // The viewer has accepted every current consent document — the "eligible" baseline. The
    // stranger deliberately has NOT accepted privacy, so it doubles as the 451 case in one seed.
    await seedConsent(sql, { userId: viewer.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })
    await seedConsent(sql, { userId: viewer.userId!, document: 'privacy', version: CURRENT_CONSENT_VERSIONS.privacy, acceptedAt: clock.now() })
    await seedConsent(sql, { userId: viewer.userId!, document: 'cookies', version: CURRENT_CONSENT_VERSIONS.cookies, acceptedAt: clock.now() })

    harness = { workerIndex, databaseName: database.databaseName, redisPrefix: cache.prefix, baseURL: server.baseURL, sql, ctx, claimant, claimantOrg, viewer, viewerOrg, stranger, strangerOrg }
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

async function seedClaimedIdentity() {
  const { sql, ctx, claimant, claimantOrg } = harness
  const { builderIdentityId } = await seedBuilderIdentity(sql, { scope: ctx.scope })
  await seedOrganizationBuilder(sql, {
    organizationId: claimantOrg.organizationId,
    builderIdentityId,
    creatorUserId: claimant.userId!,
    scope: ctx.scope,
  })
  const { claimId } = await seedVerifiedBuilderClaim(sql, { builderIdentityId, subjectUserId: claimant.userId!, scope: ctx.scope })
  await seedPublishedBuilderProfile(sql, { builderIdentityId, publishedByUserId: claimant.userId! })
  return { builderIdentityId, claimId }
}

async function cleanupIdentity(builderIdentityId: string, claimId: string) {
  await harness.sql`delete from builder_profile_views where builder_id = ${builderIdentityId}`
  await cleanupBuilderClaim(harness.sql, claimId)
  await cleanupPublishedBuilderProfile(harness.sql, builderIdentityId)
  await cleanupBuilderIdentity(harness.sql, builderIdentityId)
}

test.describe('profile view analytics', () => {
  test('an eligible view aggregates, and a repeat view the same day does not double-count', async () => {
    const { builderIdentityId, claimId } = await seedClaimedIdentity()
    try {
      const first = await harness.viewer.api!.post(`/api/builders/${builderIdentityId}/views`)
      expect(first.status()).toBe(200)
      const second = await harness.viewer.api!.post(`/api/builders/${builderIdentityId}/views`)
      expect(second.status()).toBe(200)

      const read = await harness.claimant.api!.get(`/api/builders/${builderIdentityId}/views`)
      expect(read.status()).toBe(200)
      const body = await read.json() as { builderId: string; windowDays: number; total: number; daily: Array<{ day: string; count: number }> }
      expect(body.total).toBe(1)
      expect(body.windowDays).toBe(30)
      // Never anything beyond counts: no viewer id, organization, query, or referrer field exists.
      const serialized = JSON.stringify(body).toLowerCase()
      for (const forbidden of ['viewerid', 'viewer_id', 'organizationid', 'referrer', 'query', harness.viewer.userId!.toLowerCase()]) {
        expect(serialized).not.toContain(forbidden)
      }
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })

  test('a signed-out (unauthenticated) view attempt fails quietly with 401, not a 500 or a silent 200', async () => {
    const { builderIdentityId, claimId } = await seedClaimedIdentity()
    try {
      const response = await fetch(`${harness.baseURL}/api/builders/${builderIdentityId}/views`, { method: 'POST' })
      expect(response.status).toBe(401)
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })

  test('a signed-in but not-yet-consented viewer gets 451, distinct from the 401 case', async () => {
    const { builderIdentityId, claimId } = await seedClaimedIdentity()
    try {
      // `stranger` never accepted the privacy document in this suite's seeding.
      const response = await harness.stranger.api!.post(`/api/builders/${builderIdentityId}/views`)
      expect(response.status()).toBe(451)
      const body = await response.json() as { error: string; document: string }
      expect(body.error).toBe('consent_required')
      expect(body.document).toBe('privacy')

      // And it must not have been recorded despite the 451.
      const read = await harness.claimant.api!.get(`/api/builders/${builderIdentityId}/views`)
      expect((await read.json()).total).toBe(0)
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })

  test('a stranger (not the claimant) cannot read the aggregate', async () => {
    const { builderIdentityId, claimId } = await seedClaimedIdentity()
    try {
      await harness.viewer.api!.post(`/api/builders/${builderIdentityId}/views`)
      const response = await harness.stranger.api!.get(`/api/builders/${builderIdentityId}/views`)
      expect(response.status()).toBe(403)
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })

  test('an unverified (pending) claimant cannot read the aggregate', async () => {
    const { sql, ctx, viewerOrg } = harness
    const { builderIdentityId } = await seedBuilderIdentity(sql, { scope: ctx.scope })
    await seedOrganizationBuilder(sql, {
      organizationId: viewerOrg.organizationId,
      builderIdentityId,
      creatorUserId: harness.viewer.userId!,
      scope: ctx.scope,
    })
    // A pending claim — never verified — for the SAME user who will attempt the read.
    const pendingClaimId = `pending-${builderIdentityId}`
    await sql`
      insert into builder_claims (id, builder_identity_id, subject_user_id, evidence_source, evidence_reference, status)
      values (${pendingClaimId}, ${builderIdentityId}, ${harness.viewer.userId!}, 'github', 'e2e-pending', 'pending')
    `
    try {
      const response = await harness.viewer.api!.get(`/api/builders/${builderIdentityId}/views`)
      expect(response.status()).toBe(403)
    } finally {
      await sql`delete from builder_claims where id = ${pendingClaimId}`
      await cleanupBuilderIdentity(sql, builderIdentityId)
    }
  })
})
