/**
 * Covers what the worker's own suite cannot reach through it: the quota sum, and whether the lease
 * is genuinely atomic under concurrency.
 *
 * The concurrency case is the reason this file uses a real database rather than a fake. `FOR UPDATE
 * SKIP LOCKED` is the entire mechanism preventing two overlapping workers — a cron run and a manual
 * admin run, say — from both scanning one object, and the second one would move an object the first
 * already moved. Nothing but Postgres can demonstrate that it holds.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  authUsers,
  candidateDocuments,
  candidateSubmissions,
  organizations,
  schedulingInvitations,
} from '~/shared/lib/db/schema'
import {
  leaseDocumentsForScan,
  sumSubmissionDocumentBytes,
  withWorkerOrganization,
} from '~/shared/lib/repositories/interview-documents'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'idr-org'
const OWNER = 'idr-owner'
const NOW = new Date('2027-06-10T09:00:00.000Z')
const RETENTION = new Date('2027-12-31T00:00:00.000Z')

let submission: string
let otherSubmission: string

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('interview_documents_repo')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values({ id: ORG, name: 'Org', slug: 'idr-org' })
  await db.insert(authUsers).values({
    id: OWNER, name: 'Owner', email: 'idr-owner@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW,
  })

  // Two invitations, because `candidate_submissions_invitation_id_unique` allows exactly one
  // submission per invitation — the quota is therefore per candidate, not per role.
  const invitations = await db.insert(schedulingInvitations).values([1, 2].map(() => ({
    organizationId: ORG,
    ownerUserId: OWNER,
    roleTitle: 'Engineer',
    roleContext: 'Backend',
    durationMinutes: 45,
    timezone: 'UTC',
    modality: 'remote_call',
    policyVersion: 'v1',
    retentionExpiresAt: RETENTION,
  }))).returning({ id: schedulingInvitations.id })

  const submissions = await db.insert(candidateSubmissions).values([
    { organizationId: ORG, invitationId: invitations[0].id, displayName: 'One', emailNormalized: 'one@test.invalid', retentionExpiresAt: RETENTION },
    { organizationId: ORG, invitationId: invitations[1].id, displayName: 'Two', emailNormalized: 'two@test.invalid', retentionExpiresAt: RETENTION },
  ]).returning({ id: candidateSubmissions.id })

  submission = submissions[0].id
  otherSubmission = submissions[1].id
}, 120_000)

afterAll(async () => {
  await drop()
})

beforeEach(async () => {
  await db.delete(candidateDocuments)
})

let keySequence = 0
async function seed(options: {
  submissionId?: string
  bytes?: number
  scanStatus?: string
  rejectionCode?: string | null
}) {
  keySequence += 1
  const [row] = await db.insert(candidateDocuments).values({
    organizationId: ORG,
    submissionId: options.submissionId ?? submission,
    objectKey: `quarantine/${ORG}/seed/${keySequence}`,
    originalName: 'cv.txt',
    declaredMediaType: 'text/plain',
    sha256: 'a'.repeat(64),
    bytes: options.bytes ?? 1000,
    scanStatus: options.scanStatus ?? 'pending',
    rejectionCode: options.rejectionCode ?? null,
    retentionExpiresAt: RETENTION,
  }).returning({ id: candidateDocuments.id })
  return row.id
}

describe('sumSubmissionDocumentBytes', () => {
  it('counts pending and scanning bytes, because they are already in the bucket', async () => {
    // Excluding in-flight uploads is the bug this guards: a burst of concurrent uploads would each
    // see an empty quota and collectively blow past 25 MB.
    await seed({ bytes: 1000 })
    await seed({ bytes: 2000, scanStatus: 'scanning' })
    await seed({ bytes: 4000, scanStatus: 'clean' })

    const total = await db.transaction((tx) => sumSubmissionDocumentBytes(tx as never, {
      organizationId: ORG,
      submissionId: submission,
    }))
    expect(total).toBe(7000)
  })

  it('excludes terminal rejections, whose bytes are gone', async () => {
    await seed({ bytes: 1000 })
    await seed({ bytes: 8000, scanStatus: 'infected', rejectionCode: 'Eicar-Test-Signature' })
    await seed({ bytes: 9000, scanStatus: 'failed', rejectionCode: 'scan_unavailable' })

    const total = await db.transaction((tx) => sumSubmissionDocumentBytes(tx as never, {
      organizationId: ORG,
      submissionId: submission,
    }))
    expect(total).toBe(1000)
  })

  it('does not count another candidate\u2019s submission', async () => {
    await seed({ bytes: 1000 })
    await seed({ bytes: 5000, submissionId: otherSubmission })

    const total = await db.transaction((tx) => sumSubmissionDocumentBytes(tx as never, {
      organizationId: ORG,
      submissionId: submission,
    }))
    expect(total).toBe(1000)
  })

  it('returns 0 rather than null for a submission with nothing uploaded', async () => {
    const total = await db.transaction((tx) => sumSubmissionDocumentBytes(tx as never, {
      organizationId: ORG,
      submissionId: submission,
    }))
    expect(total).toBe(0)
  })
})

describe('leaseDocumentsForScan is atomic', () => {
  it('never hands the same document to two concurrent leases', async () => {
    const ids = [await seed({}), await seed({}), await seed({}), await seed({})]

    // Both transactions open before either commits, which is the situation a select-then-update
    // would get wrong.
    const [first, second] = await Promise.all([
      withWorkerOrganization(ORG, (tx) => leaseDocumentsForScan(tx, ORG, { limit: 4, maxAttempts: 3 }), db),
      withWorkerOrganization(ORG, (tx) => leaseDocumentsForScan(tx, ORG, { limit: 4, maxAttempts: 3 }), db),
    ])

    const claimed = [...first, ...second].map((document) => document.id)
    expect(new Set(claimed).size, 'no document claimed twice').toBe(claimed.length)
    expect(claimed.length).toBeLessThanOrEqual(ids.length)

    // And every claimed row really is marked, not just returned.
    for (const id of claimed) {
      const [row] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, id))
      expect(row.scanStatus).toBe('scanning')
      expect(row.scanAttempts).toBe(1)
    }
  })

  it('returns the oldest documents first', async () => {
    // Both dates set explicitly. `created_at` defaults to the database's real clock, so seeding one
    // row and back-dating it to a fixture year that is actually in the future makes the "older" row
    // the newer one — the ordering assertion then passes or fails for the wrong reason.
    const older = await seed({})
    const newer = await seed({})
    await db.update(candidateDocuments)
      .set({ createdAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(candidateDocuments.id, older))
    await db.update(candidateDocuments)
      .set({ createdAt: new Date('2020-06-01T00:00:00.000Z') })
      .where(eq(candidateDocuments.id, newer))

    const leased = await withWorkerOrganization(ORG, (tx) =>
      leaseDocumentsForScan(tx, ORG, { limit: 1, maxAttempts: 3 }), db)

    // The candidate who has been waiting longest, rather than whoever arrived most recently.
    expect(leased.map((document) => document.id)).toEqual([older])
  })
})
