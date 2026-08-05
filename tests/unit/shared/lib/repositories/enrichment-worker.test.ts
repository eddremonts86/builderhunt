/**
 * `claimDueEnrichmentJobs` is atomic under concurrency (plan: stealth-scraping / public-profile-
 * enrichment, implementation_plan.md Phase 1 checkpoint: "lease concurrency integration tests").
 *
 * This is the reason the test uses a real database rather than a fake. `FOR UPDATE SKIP LOCKED` is
 * the entire mechanism preventing two overlapping worker runs (a cron tick and a manual admin run,
 * say) from both claiming the same due job — the second claim would then race the first to mark it
 * `running`, double-processing it and burning connector quota twice for one request. Nothing but
 * Postgres can demonstrate the lock actually holds; a mock would just prove the mock does what it
 * was told to do.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  authUsers,
  builderIdentities,
  enrichmentEvidence,
  enrichmentJobs,
  organizationBuilders,
  organizations,
} from '~/shared/lib/db/schema'
import { claimDueEnrichmentJobs, runEnrichmentRetentionPass } from '~/shared/lib/repositories/enrichment-worker'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'ewr-org'
const OWNER = 'ewr-owner'
const NOW = new Date('2027-06-10T09:00:00.000Z')

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('enrichment_worker_repo')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values({ id: ORG, name: 'Org', slug: 'ewr-org' })
  await db.insert(authUsers).values({
    id: OWNER, name: 'Owner', email: 'ewr-owner@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW,
  })
}, 120_000)

afterAll(async () => {
  await drop()
})

beforeEach(async () => {
  // Evidence first: `enrichment_evidence_organization_job_fk` is ON DELETE NO ACTION, so clearing the
  // jobs table while an evidence row still points at one raises 23503 — the same constraint the
  // retention cases below exist for.
  await db.delete(enrichmentEvidence)
  await db.delete(enrichmentJobs)
  await db.delete(organizationBuilders)
  await db.delete(builderIdentities)
})

let identitySequence = 0
// `enrichment_jobs_active_unique` allows exactly one queued/running job per (organization,
// builder_identity) pair, so seeding N concurrently-claimable jobs needs N distinct identities.
async function seedQueuedJob(): Promise<string> {
  identitySequence += 1
  // Captured once: `identitySequence` is a shared module variable, and this function awaits
  // between uses of it, so a concurrent call (this test races several) would otherwise bump it
  // again mid-flight and hand two calls the same suffix for their later inserts.
  const n = identitySequence
  const source = `ewr-source-${n}`
  const [identity] = await db.insert(builderIdentities).values({
    id: `ewr-identity-${n}`,
    source: 'github',
    sourceId: source,
    username: source,
    profileUrl: `https://github.com/${source}`,
  }).returning({ id: builderIdentities.id })

  await db.insert(organizationBuilders).values({
    id: `ewr-org-builder-${n}`,
    organizationId: ORG,
    builderIdentityId: identity.id,
    creatorUserId: OWNER,
  })

  const [job] = await db.insert(enrichmentJobs).values({
    id: `ewr-job-${n}`,
    organizationId: ORG,
    builderIdentityId: identity.id,
    requestedConnectors: ['github'],
    submittedUrls: [],
  }).returning({ id: enrichmentJobs.id })
  return job.id
}

describe('claimDueEnrichmentJobs is atomic', () => {
  it('never hands the same job to two concurrent claimers', async () => {
    const ids = await Promise.all([seedQueuedJob(), seedQueuedJob(), seedQueuedJob(), seedQueuedJob()])

    // Both transactions open before either commits, which is the situation a select-then-update
    // would get wrong.
    const [first, second] = await Promise.all([
      claimDueEnrichmentJobs(4, 300, { db }),
      claimDueEnrichmentJobs(4, 300, { db }),
    ])

    const claimed = [...first, ...second].map((job) => job.id)
    expect(new Set(claimed).size, 'no job claimed twice').toBe(claimed.length)
    expect(claimed.length).toBeLessThanOrEqual(ids.length)

    // Every claimed row really is marked, not just returned — a lease token and `running` status,
    // not a snapshot taken before the update landed.
    for (const id of claimed) {
      const [row] = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.id, id))
      expect(row.status).toBe('running')
      expect(row.leaseToken).toBeTruthy()
      expect(row.attemptCount).toBe(1)
    }
  })

  it('does not claim a job whose available_at is in the future', async () => {
    await seedQueuedJob()
    await db.update(enrichmentJobs).set({ availableAt: new Date('2099-01-01T00:00:00.000Z') })

    const claimed = await claimDueEnrichmentJobs(4, 300, { db })

    expect(claimed).toHaveLength(0)
  })

  it('respects the requested limit even when more jobs are due', async () => {
    await Promise.all([seedQueuedJob(), seedQueuedJob(), seedQueuedJob()])

    const claimed = await claimDueEnrichmentJobs(2, 300, { db })

    expect(claimed).toHaveLength(2)
  })
})

/**
 * Same reason this file uses a real database: the bug these two cases pin was a foreign key, and a
 * mock cannot hold one. `enrichment_evidence_organization_job_fk` (drizzle/0016) is ON DELETE NO
 * ACTION, while accepted evidence is kept for 180 days and its job is retired after 90 — so the job
 * sweep used to raise 23503 for every successful job in that 90-day window, and because the pass runs
 * inside `runEnrichmentWorker`, one such row failed the entire worker run.
 *
 * Found 2026-08-05 by scripts/ops/verify-enrichment-adversarial-local.mjs (case 10 of the runtime
 * adversarial matrix), against real rows rather than fixtures shaped to pass.
 */
async function seedFinishedJobWithEvidence(suffix: string, evidence: Array<{ resolution: string; observedAt: Date; expiresAt: Date }>) {
  const source = `ewr-ret-${suffix}`
  await db.insert(builderIdentities).values({
    id: `ewr-ret-identity-${suffix}`, source: 'github', sourceId: source, username: source, profileUrl: `https://github.com/${source}`,
  })
  await db.insert(organizationBuilders).values({
    id: `ewr-ret-tracked-${suffix}`, organizationId: ORG, builderIdentityId: `ewr-ret-identity-${suffix}`, creatorUserId: OWNER,
  })
  await db.insert(enrichmentJobs).values({
    id: `ewr-ret-job-${suffix}`,
    organizationId: ORG,
    builderIdentityId: `ewr-ret-identity-${suffix}`,
    requestedConnectors: ['github'],
    submittedUrls: [],
    status: 'succeeded',
    finishedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
  })
  for (const [index, row] of evidence.entries()) {
    await db.insert(enrichmentEvidence).values({
      organizationId: ORG,
      jobId: `ewr-ret-job-${suffix}`,
      builderIdentityId: `ewr-ret-identity-${suffix}`,
      connector: 'github',
      acquisitionMode: 'official_api',
      sourceUrl: `https://github.com/${source}`,
      contentHash: `ewr-ret-hash-${suffix}-${index}`,
      payload: { profileUrl: `https://github.com/${source}`, topics: [] },
      confidenceBps: 7500,
      resolverVersion: 1,
      scoreComponents: {},
      matchSignals: [],
      contradictions: [],
      resolution: row.resolution,
      observedAt: row.observedAt,
      expiresAt: row.expiresAt,
    })
  }
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000)
const daysAhead = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000)

describe('runEnrichmentRetentionPass', () => {

  it('keeps a 90-day-old job alive while it still holds unexpired accepted evidence, instead of failing', async () => {
    await seedFinishedJobWithEvidence('live', [{ resolution: 'accepted', observedAt: daysAgo(1), expiresAt: daysAhead(179) }])

    const result = await runEnrichmentRetentionPass({ rawRetentionDays: 30, acceptedRetentionDays: 180, batchSize: 500 }, { db })

    expect(result.evidenceDeleted).toBe(0)
    expect(result.jobsDeleted, 'the job outlives its 90-day mark because its evidence has not expired').toBe(0)
    const [job] = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.id, 'ewr-ret-job-live'))
    expect(job).toBeTruthy()
  })

  it('deletes the job in the same pass that expires its last evidence row', async () => {
    await seedFinishedJobWithEvidence('expired', [
      { resolution: 'accepted', observedAt: daysAgo(200), expiresAt: daysAgo(1) },
      { resolution: 'review', observedAt: daysAgo(40), expiresAt: daysAgo(1) },
      { resolution: 'rejected', observedAt: daysAgo(10), expiresAt: daysAgo(1) },
    ])

    const result = await runEnrichmentRetentionPass({ rawRetentionDays: 30, acceptedRetentionDays: 180, batchSize: 500 }, { db })

    expect(result.evidenceDeleted).toBe(3)
    expect(result.jobsDeleted).toBe(1)
    expect(await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.id, 'ewr-ret-job-expired'))).toHaveLength(0)
  })
})

/**
 * The second door the same foreign-key family opened, found 2026-08-05 by case 11 of the runtime
 * adversarial matrix: `DELETE /api/builders/:id` (untrack) deletes only the `organization_builders` row,
 * and with `ON DELETE NO ACTION` on the two composite FKs that pointed at it, the statement raised
 * 23503 for any builder the organization had enriched — the route answered 500 for exactly the people
 * the product had enriched. Deleting a whole organization was always fine, because both cascades from
 * `organizations` fire in one statement and a NO ACTION check runs at end-of-statement.
 *
 * `drizzle/0150_enrichment_untrack_cascade.sql` cascades both. Pinned at the constraint level rather
 * than through the route: what regressed would be the FK's ON DELETE action, and that is enforced
 * against the table owner too, unlike a grant or a policy.
 */
describe('untracking a builder with enrichment data (drizzle/0150)', () => {
  it('takes the organization\'s jobs and evidence with it instead of raising 23503', async () => {
    await seedFinishedJobWithEvidence('untrack', [
      { resolution: 'accepted', observedAt: daysAgo(1), expiresAt: daysAhead(179) },
    ])

    await expect(
      db.delete(organizationBuilders).where(eq(organizationBuilders.id, 'ewr-ret-tracked-untrack')),
    ).resolves.toBeDefined()

    expect(await db.select().from(enrichmentEvidence).where(eq(enrichmentEvidence.jobId, 'ewr-ret-job-untrack'))).toHaveLength(0)
    expect(await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.id, 'ewr-ret-job-untrack'))).toHaveLength(0)
  })
})
