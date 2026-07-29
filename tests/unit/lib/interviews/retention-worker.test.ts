/**
 * Real disposable Postgres, fake object storage.
 *
 * Retention is the one worker whose bugs are invisible until a regulator asks. The claims that matter are all
 * about *not* deleting the wrong thing: a transcript still inside its own window must survive its session's
 * expiry, a document whose object deletion failed must keep its row so the next pass retries, and one
 * tenant's sweep must not touch another's. Every one of those is a database-shaped question about FK cascades
 * and predicates, and none survives a mocked repository.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tenantTransaction } from '../../helpers/tenant-transaction'

const mockEnv = vi.hoisted(() => ({
  INTERVIEW_CONSENT_RETENTION_MONTHS: 24,
  INTERVIEW_TRANSCRIPT_RETENTION_DAYS: 90,
  CREDIT_FIRST_PAYER_CAP_UNITS: 100000,
}))
vi.mock('~/shared/lib/env', () => ({ env: mockEnv }))

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const schema = await import('~/shared/lib/db/schema')
const { grantCredits } = await import('~/shared/lib/billing/credits')
const { reserveCredits } = await import('~/shared/lib/billing/feature-authorization')
const { runInterviewRetentionWorker } = await import('~/lib/interviews/retention-worker')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG_A = 'rt-org-a'
const ORG_B = 'rt-org-b'
const OWNER_A = 'rt-owner-a'
const OWNER_B = 'rt-owner-b'
const NOW = new Date('2028-01-15T09:00:00.000Z')
const PAST = new Date('2027-12-01T09:00:00.000Z')
const FUTURE = new Date('2028-06-01T09:00:00.000Z')

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`

const calendars = new Map<string, string>()

/** Records every key the worker asked to delete, and can be told to fail for one of them. */
function fakeStorage(failFor: (key: string) => boolean = () => false) {
  const deleted: string[] = []
  return {
    deleted,
    deleteObject: async ({ key }: { key: string }) => {
      if (failFor(key)) throw new Error('storage unavailable')
      deleted.push(key)
    },
  }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('retention_worker')
  db = disposable.db
  drop = disposable.drop

  for (const [org, owner] of [[ORG_A, OWNER_A], [ORG_B, OWNER_B]] as const) {
    await db.insert(schema.organizations).values({ id: org, name: org, slug: org })
    await db.insert(schema.authUsers).values({
      id: owner, name: owner, email: `${owner}@test.invalid`,
      emailVerified: true, createdAt: PAST, updatedAt: PAST,
    })
    const [calendar] = await db.insert(schema.userCalendars).values({
      organizationId: org, ownerUserId: owner, name: 'Cal', timezone: 'UTC', isDefault: true,
    }).returning({ id: schema.userCalendars.id })
    calendars.set(org, calendar.id)

    const customerId = uniqueId('cus')
    await db.insert(schema.billingCustomers).values({
      id: customerId, organizationId: org, livemode: false,
      stripeCustomerId: `cus_${customerId}`, createdAt: PAST, updatedAt: PAST,
    })
    await db.insert(schema.billingSubscriptions).values({
      id: uniqueId('sub'), organizationId: org, customerId, livemode: false,
      catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: uniqueId('ssub'), stripeStatus: 'active', providerSyncedAt: PAST,
      createdAt: PAST, updatedAt: PAST,
    })
  }
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(schema.transcriptSegments)
  await db.delete(schema.interviewSuggestions)
  await db.delete(schema.interviewSessions)
  await db.delete(schema.interviewReports)
  await db.delete(schema.interviewBriefs)
  await db.delete(schema.documentExtractions)
  await db.delete(schema.candidateDocuments)
  await db.delete(schema.candidateWebImports)
  await db.delete(schema.candidateLinks)
  await db.delete(schema.candidateSubmissions)
  await db.delete(schema.privacyConsents)
  await db.delete(schema.calendarEvents)
  await db.delete(schema.schedulingInvitations)
  await db.delete(schema.billingCreditAllocations)
  await db.delete(schema.billingLedgerEntries)
  await db.delete(schema.billingCreditReservations)
  await db.delete(schema.billingCreditGrants)
  mockEnv.INTERVIEW_CONSENT_RETENTION_MONTHS = 24
})

async function seedInterview(options: {
  org?: string
  owner?: string
  /** When each layer expires. `FUTURE` means "still inside its window". */
  sessionExpiry?: Date
  segmentExpiry?: Date
  briefExpiry?: Date
  reportExpiry?: Date
} = {}) {
  const org = options.org ?? ORG_A
  const owner = options.owner ?? OWNER_A
  const [event] = await db.insert(schema.calendarEvents).values({
    organizationId: org, calendarId: calendars.get(org)!, ownerUserId: owner, type: 'personal',
    status: 'scheduled', title: 'Interview', startsAt: PAST,
    endsAt: new Date(PAST.getTime() + 2_700_000), timezone: 'UTC', allDay: false, busy: true,
  }).returning({ id: schema.calendarEvents.id })

  const [session] = await db.insert(schema.interviewSessions).values({
    organizationId: org, eventId: event.id, ownerUserId: owner, state: 'finalized',
    captureMode: 'remote_call', language: 'en', provider: 'deepgram',
    consentNoticeVersion: 'v1', captureCapability: 'microphone_only',
    startedAt: PAST, finishedAt: PAST,
    retentionExpiresAt: options.sessionExpiry ?? PAST,
  }).returning({ id: schema.interviewSessions.id })

  await db.insert(schema.transcriptSegments).values({
    organizationId: org, sessionId: session.id, providerSegmentId: 'req:0:1', sequence: 1,
    speakerEstimate: 'speaker_a', text: 'What the candidate said.', startsMs: 0, endsMs: 900,
    retentionExpiresAt: options.segmentExpiry ?? PAST,
  })

  await db.insert(schema.interviewBriefs).values({
    organizationId: org, eventId: event.id, ownerUserId: owner, version: 1, status: 'active',
    content: {}, evidenceManifest: [], retentionExpiresAt: options.briefExpiry ?? PAST,
  })
  await db.insert(schema.interviewReports).values({
    organizationId: org, eventId: event.id, ownerUserId: owner, version: 1, status: 'draft',
    content: {}, retentionExpiresAt: options.reportExpiry ?? PAST,
  })

  return { eventId: event.id, sessionId: session.id }
}

async function seedDocument(options: { org?: string; expiry?: Date; extractionExpiry?: Date } = {}) {
  const org = options.org ?? ORG_A
  const owner = org === ORG_A ? OWNER_A : OWNER_B
  const [invitation] = await db.insert(schema.schedulingInvitations).values({
    organizationId: org, ownerUserId: owner, roleTitle: 'Engineer', roleContext: 'x',
    durationMinutes: 45, timezone: 'UTC', modality: 'remote_call', policyVersion: 'v1',
  }).returning({ id: schema.schedulingInvitations.id })
  const [submission] = await db.insert(schema.candidateSubmissions).values({
    organizationId: org, invitationId: invitation.id, displayName: 'Candidate',
    emailNormalized: `${uniqueId('c')}@test.invalid`, retentionExpiresAt: options.expiry ?? PAST,
  }).returning({ id: schema.candidateSubmissions.id })
  const key = `clean/${org}/${uniqueId('obj')}`
  const [document] = await db.insert(schema.candidateDocuments).values({
    organizationId: org, submissionId: submission.id, objectKey: key,
    originalName: 'cv.pdf', declaredMediaType: 'application/pdf', sha256: 'a'.repeat(64),
    bytes: 100, scanStatus: 'clean', extractionStatus: 'succeeded',
    retentionExpiresAt: options.expiry ?? PAST,
  }).returning({ id: schema.candidateDocuments.id })
  await db.insert(schema.documentExtractions).values({
    organizationId: org, documentId: document.id, parser: 'pdfjs', parserVersion: '1',
    contentSha256: 'b'.repeat(64), plainText: 'Ten years of Rust.', status: 'succeeded',
    retentionExpiresAt: options.extractionExpiry ?? PAST,
  })
  return { submissionId: submission.id, documentId: document.id, objectKey: key, invitationId: invitation.id }
}

const run = (overrides: Record<string, unknown> = {}) => runInterviewRetentionWorker({
  now: NOW, db: db as never, storage: fakeStorage(), ...overrides,
})

const countOf = async (table: never) => (await db.select().from(table)).length

describe('the sweep deletes what has expired', () => {
  it('removes an expired interview end to end', async () => {
    await seedInterview()
    const result = await run()
    expect(result.counts.transcriptSegments).toBe(1)
    expect(result.counts.interviewSessions).toBe(1)
    expect(result.counts.interviewBriefs).toBe(1)
    expect(result.counts.interviewReports).toBe(1)
    expect(await countOf(schema.transcriptSegments as never)).toBe(0)
    expect(await countOf(schema.interviewSessions as never)).toBe(0)
  })

  it('leaves everything still inside its window', async () => {
    await seedInterview({
      sessionExpiry: FUTURE, segmentExpiry: FUTURE, briefExpiry: FUTURE, reportExpiry: FUTURE,
    })
    const result = await run()
    expect(result.tenants).toBe(0)
    expect(await countOf(schema.transcriptSegments as never)).toBe(1)
    expect(await countOf(schema.interviewSessions as never)).toBe(1)
  })

  it('keeps a transcript inside its window even when its session has expired', async () => {
    // The FK is `on delete cascade`, so a parent-first delete would take this transcript with it. That is
    // exactly the bug: a 90-day transcript must not vanish because its session row expired first.
    await seedInterview({ sessionExpiry: PAST, segmentExpiry: FUTURE })
    const result = await run()
    expect(result.counts.transcriptSegments).toBe(0)
    expect(result.counts.interviewSessions).toBe(0)
    expect(await countOf(schema.transcriptSegments as never)).toBe(1)
    expect(await countOf(schema.interviewSessions as never)).toBe(1)
  })

  it('deletes the session on a later pass, once its transcript has gone', async () => {
    await seedInterview({ sessionExpiry: PAST, segmentExpiry: FUTURE })
    await run()
    await db.delete(schema.transcriptSegments)
    const second = await run()
    expect(second.counts.interviewSessions).toBe(1)
  })

  it('keeps a submission whose document is still inside its own window', async () => {
    await seedDocument({ expiry: PAST })
    await db.update(schema.candidateDocuments).set({ retentionExpiresAt: FUTURE })
    const result = await run()
    // The submission cascades to documents, so deleting it first would take a document the candidate was
    // told would be kept.
    expect(result.counts.candidateSubmissions).toBe(0)
    expect(await countOf(schema.candidateDocuments as never)).toBe(1)
  })
})

describe('objects go before rows', () => {
  it('deletes the object and then the row', async () => {
    const { objectKey } = await seedDocument()
    const storage = fakeStorage()
    const result = await run({ storage })
    expect(storage.deleted).toEqual([objectKey])
    expect(result.counts.candidateDocuments).toBe(1)
    expect(await countOf(schema.candidateDocuments as never)).toBe(0)
  })

  it('keeps the row when the object deletion fails', async () => {
    const { objectKey } = await seedDocument()
    const storage = fakeStorage((key) => key === objectKey)
    const result = await run({ storage })
    // The row is the only thing that will make the next pass try again. Deleting it would strand the
    // candidate's CV in R2 with nothing pointing at it — a silent, permanent retention breach.
    expect(result.objectsFailed).toBe(1)
    expect(result.counts.candidateDocuments).toBe(0)
    expect(await countOf(schema.candidateDocuments as never)).toBe(1)
  })

  it('retries on the next pass and succeeds', async () => {
    const { objectKey } = await seedDocument()
    await run({ storage: fakeStorage((key) => key === objectKey) })
    const second = await run({ storage: fakeStorage() })
    expect(second.counts.candidateDocuments).toBe(1)
    expect(await countOf(schema.candidateDocuments as never)).toBe(0)
  })

  it('sweeps rows even with no storage configured', async () => {
    // An operator with no object storage still owes the relational deletion. Refusing the whole pass
    // because R2 is absent would retain rows past their promise for an unrelated reason.
    await seedInterview()
    const result = await runInterviewRetentionWorker({ now: NOW, db: db as never, storage: undefined })
    expect(result.counts.transcriptSegments).toBe(1)
  })
})

describe('tenant isolation', () => {
  it('does not touch another tenant’s data', async () => {
    await seedInterview({ org: ORG_A, owner: OWNER_A })
    await seedInterview({ org: ORG_B, owner: OWNER_B, sessionExpiry: FUTURE, segmentExpiry: FUTURE, briefExpiry: FUTURE, reportExpiry: FUTURE })
    await run()
    const remaining = await db.select().from(schema.interviewSessions)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].organizationId).toBe(ORG_B)
  })

  it('sweeps both tenants when both have expired data', async () => {
    await seedInterview({ org: ORG_A, owner: OWNER_A })
    await seedInterview({ org: ORG_B, owner: OWNER_B })
    const result = await run()
    expect(result.tenants).toBe(2)
    expect(result.counts.interviewSessions).toBe(2)
  })

  it('keeps sweeping after one tenant fails', async () => {
    await seedDocument({ org: ORG_A })
    await seedInterview({ org: ORG_B, owner: OWNER_B })
    // Storage fails only for tenant A's object, which leaves its document row alone. Tenant B is unaffected.
    const result = await run({ storage: fakeStorage((key) => key.includes(ORG_A)) })
    expect(result.objectsFailed).toBe(1)
    expect(result.counts.interviewSessions).toBe(1)
  })
})

describe('consent outlives the data', () => {
  async function seedConsent(decidedAt: Date) {
    const { invitationId } = await seedDocument()
    await db.insert(schema.privacyConsents).values({
      organizationId: ORG_A, invitationId, subjectEmailHash: 'h'.repeat(64),
      purpose: 'candidate_document_processing', noticeVersion: 'v1', decision: 'accepted',
      decidedAt, requestEvidenceHash: 'e'.repeat(64),
    })
  }

  it('keeps a consent recorded inside the consent window', async () => {
    // Ten months ago, against a 24-month window. The documents it covered are already gone — the consent is
    // the only remaining evidence that processing them was lawful.
    await seedConsent(new Date('2027-03-15T09:00:00.000Z'))
    const result = await run()
    expect(result.counts.candidateDocuments).toBe(1)
    expect(result.counts.privacyConsents).toBe(0)
    expect(await countOf(schema.privacyConsents as never)).toBe(1)
  })

  it('deletes a consent past the consent window', async () => {
    await seedConsent(new Date('2025-01-01T09:00:00.000Z'))
    const result = await run()
    expect(result.counts.privacyConsents).toBe(1)
  })

  it('honours a shorter configured consent window', async () => {
    mockEnv.INTERVIEW_CONSENT_RETENTION_MONTHS = 6
    await seedConsent(new Date('2027-03-15T09:00:00.000Z'))
    const result = await run()
    // Ten months old against a six-month window.
    expect(result.counts.privacyConsents).toBe(1)
  })
})

describe('a dry run changes nothing', () => {
  it('reports the same counts and deletes nothing', async () => {
    await seedInterview()
    await seedDocument()
    const storage = fakeStorage()
    const preview = await run({ dryRun: true, storage })

    expect(preview.dryRun).toBe(true)
    expect(preview.counts.transcriptSegments).toBe(1)
    expect(preview.counts.candidateDocuments).toBe(1)
    // Nothing removed from storage or the database.
    expect(storage.deleted).toEqual([])
    expect(await countOf(schema.transcriptSegments as never)).toBe(1)
    expect(await countOf(schema.candidateDocuments as never)).toBe(1)
  })

  it('matches what the real pass then deletes', async () => {
    await seedInterview()
    await seedDocument()
    const preview = await run({ dryRun: true })
    const real = await run()
    // The whole point of a rehearsal: if the numbers differ, the rehearsal was worthless.
    expect(real.counts).toEqual(preview.counts)
  })
})

describe('stale reservations', () => {
  async function seedStaleReservation(deadlineAt: Date) {
    await tenantTransaction(db, ORG_A, (tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG_A,
      source: 'promotional', units: 500, expiresAt: FUTURE, idempotencyKey: uniqueId('idem'),
    }))
    const reservationId = uniqueId('res')
    await tenantTransaction(db, ORG_A, (tx) => reserveCredits(
      tx as never,
      { organizationId: ORG_A, userId: OWNER_A, role: 'owner', requestId: 'r' } as never,
      { reservationId, operation: 'interview_live_transcription', idempotencyKey: uniqueId('k') },
    ))
    await db.update(schema.billingCreditReservations).set({ deadlineAt })
    return reservationId
  }

  it('releases one abandoned past its deadline', async () => {
    await seedStaleReservation(PAST)
    const result = await run()
    expect(result.reservationsReleased).toBe(1)
    const [reservation] = await db.select().from(schema.billingCreditReservations)
    // Released through the platform's own contract, so the ledger entries and the grant restoration are the
    // platform's — this worker never writes the ledger.
    expect(reservation.state).toBe('released')
  })

  it('leaves one still inside its deadline', async () => {
    await seedStaleReservation(FUTURE)
    const result = await run()
    expect(result.reservationsReleased).toBe(0)
    const [reservation] = await db.select().from(schema.billingCreditReservations)
    expect(reservation.state).toBe('reserved')
  })

  it('is idempotent across two passes', async () => {
    await seedStaleReservation(PAST)
    await run()
    const second = await run()
    // Already released is the common case on a re-run, not a failure worth alarming on.
    expect(second.reservationsFailed).toBe(0)
  })

  it('reports without releasing on a dry run', async () => {
    await seedStaleReservation(PAST)
    const result = await run({ dryRun: true })
    expect(result.reservationsReleased).toBe(1)
    const [reservation] = await db.select().from(schema.billingCreditReservations)
    expect(reservation.state).toBe('reserved')
  })
})
