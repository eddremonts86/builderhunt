/**
 * plans/UI/tasks.md Wave 4 "Add verified-subject provenance UI" and "Add restrict-processing
 * confirmation and state".
 *
 * Runs the verified-claimant subject-rights routes over real HTTP with a real session — not the
 * in-process route-handler checks `scripts/db/verify-api-isolation-local.mjs` already does — so it
 * covers the auth middleware and active-organization resolution in front of both handlers.
 *
 * Three things matter here:
 *   1. A verified claimant can read their own evidence provenance (source, field categories,
 *      observation date, retention state) and restrict processing exactly once, idempotently.
 *   2. Restricting cancels queued enrichment jobs and purges evidence — and that purge is durable:
 *      a page reload (or a repeat POST) must keep showing the restricted state, not silently reset.
 *   3. Nobody else — an unrelated signed-in user, or the same user against someone else's builder
 *      identity — can read or mutate any of this.
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
import { seedBuilderIdentity, seedOrganizationBuilder, cleanupBuilderIdentity } from './harness/fixtures/builders'
import { seedEnrichmentJob } from './harness/fixtures/workers'
import {
  seedVerifiedBuilderClaim,
  seedPublishedBuilderProfile,
  seedEnrichmentEvidence,
  cleanupBuilderClaim,
  cleanupPublishedBuilderProfile,
  cleanupEnrichmentEvidence,
  cleanupBuilderProcessingRestriction,
} from './harness/fixtures/builder-claims'
import { uniqueId } from './harness/ids'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
  claimant: Principal
  claimantOrg: OrganizationFixture
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}pep` }
    const clock = fixedClockFromEnv()

    const { principal: claimant, organization: claimantOrg } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const { principal: stranger, organization: strangerOrg } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })

    harness = { workerIndex, databaseName: database.databaseName, redisPrefix: cache.prefix, baseURL: server.baseURL, sql, ctx, claimant, claimantOrg, stranger, strangerOrg }
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

/** A fresh identity, claimed and verified by `harness.claimant`, tracked + enriched by `harness.claimantOrg`. */
async function seedClaimedAndEnrichedIdentity() {
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
  const { jobId } = await seedEnrichmentJob(sql, {
    organizationId: claimantOrg.organizationId,
    builderIdentityId,
    status: 'succeeded',
    availableAt: new Date(),
    scope: ctx.scope,
  })
  await seedEnrichmentEvidence(sql, {
    organizationId: claimantOrg.organizationId,
    jobId,
    builderIdentityId,
    payload: { headline: 'Ships distributed systems in Rust', topics: ['rust', 'distributed-systems'] },
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  })
  return { builderIdentityId, claimId, jobId }
}

async function cleanupIdentity(builderIdentityId: string, claimId: string) {
  await cleanupBuilderProcessingRestriction(harness.sql, builderIdentityId)
  await cleanupEnrichmentEvidence(harness.sql, builderIdentityId)
  await cleanupBuilderClaim(harness.sql, claimId)
  await cleanupPublishedBuilderProfile(harness.sql, builderIdentityId)
  await cleanupBuilderIdentity(harness.sql, builderIdentityId)
}

test.describe('verified-subject provenance and restrict-processing', () => {
  test('the verified claimant sees only source, field categories, observation date, and retention state', async () => {
    const { builderIdentityId, claimId } = await seedClaimedAndEnrichedIdentity()
    try {
      const response = await harness.claimant.api!.get(`/api/me/builder/${builderIdentityId}/evidence-provenance`)
      expect(response.status()).toBe(200)
      const body = await response.json() as { provenance: Array<Record<string, unknown>>; restrictedSince: string | null }

      expect(body.restrictedSince).toBeNull()
      expect(body.provenance).toHaveLength(1)
      const entry = body.provenance[0]
      expect(Object.keys(entry).sort()).toEqual(['expiresAt', 'fieldCategories', 'observedAt', 'retentionState', 'source'])
      expect(entry.source).toBe('github')
      expect(entry.fieldCategories).toEqual(expect.arrayContaining(['headline', 'topics']))
      expect(entry.retentionState).toBe('active')

      // Never any tenant/recruiter/reviewer/note/score data, at any depth of the payload.
      const serialized = JSON.stringify(body).toLowerCase()
      for (const forbidden of ['organizationid', 'reviewedby', 'confidencebps', 'matchsignals', 'sourceurl', harness.claimantOrg.organizationId.toLowerCase()]) {
        expect(serialized).not.toContain(forbidden)
      }
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })

  test('another signed-in user cannot read or restrict a stranger\'s builder identity', async () => {
    const { builderIdentityId, claimId } = await seedClaimedAndEnrichedIdentity()
    try {
      const getResponse = await harness.stranger.api!.get(`/api/me/builder/${builderIdentityId}/evidence-provenance`)
      expect(getResponse.status()).toBe(403)

      const postResponse = await harness.stranger.api!.post(`/api/me/builder/${builderIdentityId}/restrict-processing`)
      expect(postResponse.status()).toBe(403)

      // The stranger's 403 must not have mutated anything for the real claimant.
      const asClaimant = await harness.claimant.api!.get(`/api/me/builder/${builderIdentityId}/evidence-provenance`)
      expect((await asClaimant.json()).restrictedSince).toBeNull()
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })

  test('a random builder id reveals nothing, same as a real stranger\'s id', async () => {
    const randomId = uniqueId('nonexistent-builder')
    const response = await harness.claimant.api!.get(`/api/me/builder/${randomId}/evidence-provenance`)
    expect(response.status()).toBe(403)
  })

  test('restricting cancels queued jobs, purges evidence, and the restricted state survives a reload — repeating is a safe no-op', async () => {
    const { builderIdentityId, claimId, jobId: _succeededJobId } = await seedClaimedAndEnrichedIdentity()
    try {
      // A second, still-queued job for the same identity — this is the one restricting must cancel.
      const { jobId: queuedJobId } = await seedEnrichmentJob(harness.sql, {
        organizationId: harness.claimantOrg.organizationId,
        builderIdentityId,
        status: 'queued',
        availableAt: new Date(),
        scope: harness.ctx.scope,
      })

      const first = await harness.claimant.api!.post(`/api/me/builder/${builderIdentityId}/restrict-processing`)
      expect(first.status()).toBe(200)
      const firstBody = await first.json() as { restricted: boolean; since: string; jobsCancelled: number; evidencePurged: number }
      expect(firstBody.restricted).toBe(true)
      expect(firstBody.jobsCancelled).toBeGreaterThanOrEqual(1)
      expect(firstBody.evidencePurged).toBeGreaterThanOrEqual(1)

      const [queuedRow] = await harness.sql<{ status: string }[]>`select status from enrichment_jobs where id = ${queuedJobId}`
      expect(queuedRow?.status).not.toBe('queued')

      const [evidenceRows] = await harness.sql<{ count: string }[]>`
        select count(*)::text as count from enrichment_evidence where builder_identity_id = ${builderIdentityId}
      `
      expect(Number(evidenceRows.count)).toBe(0)

      // Durable across a fresh read — this is the "reload" proof: a plain GET, no POST involved.
      const afterReload = await harness.claimant.api!.get(`/api/me/builder/${builderIdentityId}/evidence-provenance`)
      const reloadBody = await afterReload.json() as { provenance: unknown[]; restrictedSince: string | null }
      expect(reloadBody.restrictedSince).not.toBeNull()
      expect(reloadBody.provenance).toEqual([])

      // Repeating is a safe no-op, not a second restriction record or an error.
      const second = await harness.claimant.api!.post(`/api/me/builder/${builderIdentityId}/restrict-processing`)
      expect(second.status()).toBe(200)
      const secondBody = await second.json() as { restricted: boolean; since: string }
      expect(secondBody.since).toBe(firstBody.since)

      const [restrictionRows] = await harness.sql<{ count: string }[]>`
        select count(*)::text as count from builder_processing_restrictions where builder_identity_id = ${builderIdentityId} and status = 'active'
      `
      expect(restrictionRows.count).toBe('1')
    } finally {
      await cleanupIdentity(builderIdentityId, claimId)
    }
  })
})
