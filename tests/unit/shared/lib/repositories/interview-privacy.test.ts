/**
 * The subject of an account export is the organizer. A candidate's CV, the text of what they said, and a
 * model's assessment of them are a *third party's* personal data — so the assertions here are mostly
 * negative, and they are the point: an export that handed one data subject another's data would be a
 * disclosure dressed as compliance.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/shared/lib/env', () => ({ env: { INTERVIEW_TRANSCRIPT_RETENTION_DAYS: 90 } }))

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const schema = await import('~/shared/lib/db/schema')
const {
  FORBIDDEN_EXPORT_FIELDS,
  loadInterviewExportSection,
  shortenInterviewRetentionForOwner,
} = await import('~/shared/lib/repositories/interview-privacy')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'ip-org'
const OWNER = 'ip-owner'
const OTHER = 'ip-other'
const NOW = new Date('2028-02-01T09:00:00.000Z')
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`
let calendarId = ''

/** The one string that must never appear anywhere in an export. */
const CANDIDATE_WORDS = 'I rewrote the cache layer in Rust and halved tail latency.'

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('interview_privacy')
  db = disposable.db
  drop = disposable.drop

  await db.insert(schema.organizations).values({ id: ORG, name: 'Org', slug: ORG })
  await db.insert(schema.authUsers).values([
    { id: OWNER, name: 'Owner', email: 'ip-o@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
    { id: OTHER, name: 'Other', email: 'ip-x@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
  ])
  const [calendar] = await db.insert(schema.userCalendars).values({
    organizationId: ORG, ownerUserId: OWNER, name: 'Cal', timezone: 'UTC', isDefault: true,
  }).returning({ id: schema.userCalendars.id })
  calendarId = calendar.id
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(schema.transcriptSegments)
  await db.delete(schema.interviewSessions)
  await db.delete(schema.interviewReports)
  await db.delete(schema.interviewBriefs)
  await db.delete(schema.documentExtractions)
  await db.delete(schema.candidateDocuments)
  await db.delete(schema.candidateLinks)
  await db.delete(schema.candidateSubmissions)
  await db.delete(schema.privacyConsents)
  // Invitations before events: `scheduling_invitations`' composite FK to `calendar_events` is `set null`,
  // so deleting the event first tries to null `(organization_id, booked_event_id)` together — and
  // `organization_id` is NOT NULL, which fails with an error that names the wrong table.
  await db.delete(schema.schedulingInvitations)
  await db.delete(schema.calendarEvents)
})

async function seedFullInterview(ownerUserId = OWNER) {
  const [event] = await db.insert(schema.calendarEvents).values({
    organizationId: ORG, calendarId, ownerUserId, type: 'personal', status: 'scheduled',
    title: 'Interview', startsAt: NOW, endsAt: new Date(NOW.getTime() + 2_700_000),
    timezone: 'UTC', allDay: false, busy: true,
  }).returning({ id: schema.calendarEvents.id })

  const [invitation] = await db.insert(schema.schedulingInvitations).values({
    organizationId: ORG, ownerUserId, roleTitle: 'Staff Engineer', roleContext: 'Platform',
    durationMinutes: 45, timezone: 'UTC', modality: 'remote_call', policyVersion: 'v1',
    capabilityHash: 'c'.repeat(64), bookedEventId: event.id, status: 'booked', bookedAt: NOW, openedAt: NOW,
  }).returning({ id: schema.schedulingInvitations.id })

  const [submission] = await db.insert(schema.candidateSubmissions).values({
    organizationId: ORG, invitationId: invitation.id, displayName: 'Casey Candidate',
    emailNormalized: 'casey@candidate.invalid', retentionExpiresAt: FAR_FUTURE(),
  }).returning({ id: schema.candidateSubmissions.id })

  const [document] = await db.insert(schema.candidateDocuments).values({
    organizationId: ORG, submissionId: submission.id, objectKey: `clean/${ORG}/secret-key-abc`,
    originalName: 'casey-cv.pdf', declaredMediaType: 'application/pdf', sha256: 'a'.repeat(64),
    bytes: 100, scanStatus: 'clean', extractionStatus: 'succeeded', retentionExpiresAt: FAR_FUTURE(),
  }).returning({ id: schema.candidateDocuments.id })
  await db.insert(schema.documentExtractions).values({
    organizationId: ORG, documentId: document.id, parser: 'pdfjs', parserVersion: '1',
    contentSha256: 'b'.repeat(64), plainText: CANDIDATE_WORDS, status: 'succeeded',
    retentionExpiresAt: FAR_FUTURE(),
  })
  await db.insert(schema.candidateLinks).values({
    organizationId: ORG, submissionId: submission.id,
    url: 'https://casey.dev', normalizedUrl: 'https://casey.dev',
    sourceType: 'personal_site', acquisitionMode: 'user_submitted', policyDecision: 'user_submitted',
    importState: 'not_requested',
  })

  const [session] = await db.insert(schema.interviewSessions).values({
    organizationId: ORG, eventId: event.id, ownerUserId, state: 'finalized',
    captureMode: 'remote_call', language: 'en', provider: 'deepgram',
    consentNoticeVersion: 'v1', captureCapability: 'microphone_only',
    startedAt: NOW, finishedAt: NOW, providerBilledSeconds: 1_800,
    retentionExpiresAt: FAR_FUTURE(),
  }).returning({ id: schema.interviewSessions.id })
  await db.insert(schema.transcriptSegments).values({
    organizationId: ORG, sessionId: session.id, providerSegmentId: 'req:0:1', sequence: 1,
    speakerEstimate: 'speaker_b', text: CANDIDATE_WORDS, startsMs: 0, endsMs: 3_000,
    retentionExpiresAt: FAR_FUTURE(),
  })

  await db.insert(schema.interviewBriefs).values({
    organizationId: ORG, eventId: event.id, ownerUserId, version: 1, status: 'active',
    content: { candidateSummary: CANDIDATE_WORDS }, evidenceManifest: [],
    retentionExpiresAt: FAR_FUTURE(),
  })
  await db.insert(schema.interviewReports).values({
    organizationId: ORG, eventId: event.id, ownerUserId, version: 1, status: 'final',
    content: { summary: [{ statement: CANDIDATE_WORDS, segmentIds: [] }] },
    finalizedAt: NOW, retentionExpiresAt: FAR_FUTURE(),
  })
  await db.insert(schema.privacyConsents).values({
    organizationId: ORG, invitationId: invitation.id, subjectEmailHash: 'h'.repeat(64),
    purpose: 'live_audio_transcription', noticeVersion: 'v1', decision: 'accepted',
    decidedAt: NOW, requestEvidenceHash: 'e'.repeat(64),
  })

  return { eventId: event.id, invitationId: invitation.id, sessionId: session.id }
}

const load = (userId = OWNER) =>
  db.transaction((tx) => loadInterviewExportSection(tx as never, { organizationId: ORG, userId }))

describe('what the organizer gets', () => {
  it('lists their invitations with status and counts', async () => {
    await seedFullInterview()
    const section = await load()
    expect(section.invitations).toHaveLength(1)
    expect(section.invitations[0]).toMatchObject({
      roleTitle: 'Staff Engineer',
      status: 'booked',
      modality: 'remote_call',
      candidateSubmissions: 1,
      candidateDocuments: 1,
      candidateLinks: 1,
    })
  })

  it('lists their interviews with session state and billed duration', async () => {
    await seedFullInterview()
    const section = await load()
    expect(section.interviews).toHaveLength(1)
    expect(section.interviews[0]).toMatchObject({
      captureMode: 'remote_call',
      sessionState: 'finalized',
      providerBilledSeconds: 1_800,
      transcriptSegments: 1,
      hasBrief: true,
      reportStatus: 'final',
    })
  })

  it('reports consent receipts as a count', async () => {
    await seedFullInterview()
    expect((await load()).consentReceiptsRecorded).toBe(1)
  })

  it('groups credit usage by operation rather than by interview', async () => {
    await seedFullInterview()
    await db.insert(schema.billingCreditReservations).values({
      id: uniqueId('res'), organizationId: ORG, operation: 'interview_live_transcription',
      rateCardVersion: 1, idempotencyKey: uniqueId('k'), maximumUnits: 180, settledUnits: 31,
      state: 'settled', deadlineAt: FAR_FUTURE(), createdAt: NOW, updatedAt: NOW,
    })
    const section = await load()
    // Grouped: a per-reservation list keyed by interview would reconstruct which candidate cost what.
    expect(section.creditUsage).toEqual([
      { operation: 'interview_live_transcription', reservations: 1, settledUnits: 31 },
    ])
  })

  it('shows nothing for an interview owned by someone else', async () => {
    await seedFullInterview(OTHER)
    const section = await load(OWNER)
    // An export must not become a way to read a colleague's interviews.
    expect(section.invitations).toEqual([])
    expect(section.interviews).toEqual([])
    expect(section.consentReceiptsRecorded).toBe(0)
  })
})

describe('what the organizer must never get', () => {
  it('carries no word of what the candidate said or wrote', async () => {
    await seedFullInterview()
    const serialized = JSON.stringify(await load())
    // One string seeded into the extraction, the transcript, the brief and the report. If any of the four
    // leaks, this fails.
    expect(serialized).not.toContain(CANDIDATE_WORDS)
    expect(serialized).not.toContain('cache layer')
  })

  it('carries no object key, capability hash, or email hash', async () => {
    await seedFullInterview()
    const serialized = JSON.stringify(await load())
    expect(serialized).not.toContain('secret-key-abc')
    expect(serialized).not.toContain('c'.repeat(64))
    expect(serialized).not.toContain('h'.repeat(64))
    expect(serialized).not.toContain('e'.repeat(64))
  })

  it('carries no candidate email or name', async () => {
    await seedFullInterview()
    const serialized = JSON.stringify(await load())
    // The candidate's identity is the candidate's. The organizer knows it already; an export file leaving
    // the system does not need to.
    expect(serialized).not.toContain('casey@candidate.invalid')
    expect(serialized).not.toContain('Casey Candidate')
    expect(serialized).not.toContain('casey-cv.pdf')
  })

  it('carries no submitted link', async () => {
    await seedFullInterview()
    expect(JSON.stringify(await load())).not.toContain('casey.dev')
  })

  it('uses none of the forbidden field names', async () => {
    await seedFullInterview()
    const serialized = JSON.stringify(await load())
    // Asserted against the exported list, not a copy: a field added to the section and forgotten here would
    // otherwise pass a test that looks thorough.
    for (const field of FORBIDDEN_EXPORT_FIELDS) {
      expect(serialized, `export carries a "${field}" field`).not.toContain(`"${field}"`)
    }
  })
})

describe('account deletion hands the material to retention', () => {
  it('shortens retention rather than erasing a candidate’s record', async () => {
    const { sessionId } = await seedFullInterview()
    const result = await db.transaction((tx) => shortenInterviewRetentionForOwner(tx as never, {
      organizationId: ORG, userId: OWNER, now: NOW,
    }))
    expect(result).toMatchObject({ invitations: 1, sessions: 1, briefs: 1, reports: 1 })

    // The rows are still there — deleting a candidate's transcript because the interviewer closed their
    // account would erase a third party's data on a request they never made.
    const [session] = await db.select().from(schema.interviewSessions)
    expect(session.id).toBe(sessionId)
    expect(session.retentionExpiresAt).toEqual(NOW)
    // And the transcript is untouched, so it goes on its own clock rather than on an account-closure event.
    expect(await db.select().from(schema.transcriptSegments)).toHaveLength(1)
  })

  it('revokes the invitation so no new booking can arrive', async () => {
    await seedFullInterview()
    await db.transaction((tx) => shortenInterviewRetentionForOwner(tx as never, {
      organizationId: ORG, userId: OWNER, now: NOW,
    }))
    const [invitation] = await db.select().from(schema.schedulingInvitations)
    expect(invitation.revokedAt).toEqual(NOW)
  })

  it('leaves another owner’s interviews alone', async () => {
    await seedFullInterview(OTHER)
    const result = await db.transaction((tx) => shortenInterviewRetentionForOwner(tx as never, {
      organizationId: ORG, userId: OWNER, now: NOW,
    }))
    expect(result).toMatchObject({ invitations: 0, sessions: 0, briefs: 0, reports: 0 })
  })

  it('is idempotent', async () => {
    await seedFullInterview()
    await db.transaction((tx) => shortenInterviewRetentionForOwner(tx as never, {
      organizationId: ORG, userId: OWNER, now: NOW,
    }))
    const second = await db.transaction((tx) => shortenInterviewRetentionForOwner(tx as never, {
      organizationId: ORG, userId: OWNER, now: new Date(NOW.getTime() + 60_000),
    }))
    // The invitation was already revoked, so its `coalesce` leaves the original timestamp and the row is no
    // longer matched. The rest are idempotent by assignment.
    expect(second.invitations).toBe(0)
    const [invitation] = await db.select().from(schema.schedulingInvitations)
    expect(invitation.revokedAt).toEqual(NOW)
  })
})
