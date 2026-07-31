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
  enrichmentJobs,
  organizationBuilders,
  organizations,
} from '~/shared/lib/db/schema'
import { claimDueEnrichmentJobs } from '~/shared/lib/repositories/enrichment-worker'

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
