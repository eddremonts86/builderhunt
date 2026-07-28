/**
 * The interview list is one hand-written SQL query with five joins and a correlated subquery. None of that
 * is typechecked, so a wrong column name or a join that silently multiplies rows would only surface on the
 * page — which is exactly where nobody would know whether the data or the query was at fault.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/shared/lib/env', () => ({ env: { INTERVIEW_TRANSCRIPT_RETENTION_DAYS: 90 } }))

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const schema = await import('~/shared/lib/db/schema')
const { listInterviewsForOwner, insertBriefVersion } = await import('~/shared/lib/repositories/interviews')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'il-org'
const OWNER = 'il-owner'
const OTHER_OWNER = 'il-other'
const NOW = new Date('2027-12-05T09:00:00.000Z')
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`
let calendarId = ''

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('interview_list')
  db = disposable.db
  drop = disposable.drop

  await db.insert(schema.organizations).values({ id: ORG, name: 'Org', slug: ORG })
  await db.insert(schema.authUsers).values([
    { id: OWNER, name: 'Owner', email: 'il-o@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
    { id: OTHER_OWNER, name: 'Other', email: 'il-x@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
  ])
  const [calendar] = await db.insert(schema.userCalendars).values({
    organizationId: ORG, ownerUserId: OWNER, name: 'Cal', timezone: 'UTC', isDefault: true,
  }).returning({ id: schema.userCalendars.id })
  calendarId = calendar.id
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(schema.interviewReports)
  await db.delete(schema.transcriptSegments)
  await db.delete(schema.interviewSessions)
  await db.delete(schema.interviewBriefs)
  await db.delete(schema.candidateSubmissions)
  await db.delete(schema.schedulingInvitations)
  await db.delete(schema.calendarEvents)
})

async function seedBookedInterview(options: {
  ownerUserId?: string
  startsAt?: Date
  roleTitle?: string
  candidateName?: string | null
  booked?: boolean
  eventStatus?: string
} = {}) {
  const owner = options.ownerUserId ?? OWNER
  const startsAt = options.startsAt ?? NOW
  const [event] = await db.insert(schema.calendarEvents).values({
    organizationId: ORG, calendarId, ownerUserId: owner, type: 'personal',
    status: options.eventStatus ?? 'scheduled', title: 'Interview',
    startsAt, endsAt: new Date(startsAt.getTime() + 2_700_000),
    timezone: 'UTC', allDay: false, busy: true,
  }).returning({ id: schema.calendarEvents.id })

  const [invitation] = await db.insert(schema.schedulingInvitations).values({
    organizationId: ORG, ownerUserId: owner, roleTitle: options.roleTitle ?? 'Staff Engineer',
    roleContext: 'Platform', durationMinutes: 45, timezone: 'UTC', modality: 'remote_call',
    meetingUrl: 'https://meet.test.invalid/room', policyVersion: 'v1',
    bookedEventId: options.booked === false ? null : event.id,
  }).returning({ id: schema.schedulingInvitations.id })

  if (options.candidateName !== null) {
    await db.insert(schema.candidateSubmissions).values({
      organizationId: ORG, invitationId: invitation.id,
      displayName: options.candidateName ?? 'Casey Candidate',
      emailNormalized: `${uniqueId('cand')}@test.invalid`, retentionExpiresAt: FAR_FUTURE(),
    })
  }

  return { eventId: event.id, invitationId: invitation.id }
}

const list = (ownerUserId = OWNER) =>
  db.transaction((tx) => listInterviewsForOwner(tx as never, { organizationId: ORG, ownerUserId }))

describe('the query runs and returns what the page needs', () => {
  it('returns a booked interview with the candidate and role', async () => {
    const { eventId } = await seedBookedInterview()
    const rows = await list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      eventId,
      roleTitle: 'Staff Engineer',
      candidateDisplayName: 'Casey Candidate',
      modality: 'remote_call',
      meetingUrl: 'https://meet.test.invalid/room',
      eventStatus: 'scheduled',
      sessionState: null,
      hasBrief: false,
      reportStatus: null,
      transcriptSegments: 0,
    })
  })

  it('returns a row even when no candidate submission exists', async () => {
    // The submission arrives when the candidate fills the form. An interview booked but not yet submitted
    // to must still appear, or the organizer cannot open its brief.
    await seedBookedInterview({ candidateName: null })
    const rows = await list()
    expect(rows).toHaveLength(1)
    expect(rows[0].candidateDisplayName).toBeNull()
  })

  it('excludes an invitation that was never booked', async () => {
    await seedBookedInterview({ booked: false })
    // Not an interview yet. It belongs on the invitations screen.
    expect(await list()).toHaveLength(0)
  })

  it('excludes another owner\'s interview', async () => {
    await seedBookedInterview({ ownerUserId: OTHER_OWNER })
    // A colleague granted access to one interview should not get a roster of everyone's candidates.
    expect(await list()).toHaveLength(0)
    expect(await list(OTHER_OWNER)).toHaveLength(1)
  })

  it('orders newest first', async () => {
    await seedBookedInterview({ startsAt: new Date('2027-12-01T09:00:00.000Z'), roleTitle: 'Older' })
    await seedBookedInterview({ startsAt: new Date('2027-12-10T09:00:00.000Z'), roleTitle: 'Newer' })
    // Today's interviews are the ones being opened and yesterday's is the one being written up.
    expect((await list()).map((row) => row.roleTitle)).toEqual(['Newer', 'Older'])
  })

  it('includes a cancelled event, so the organizer can see it was cancelled', async () => {
    await seedBookedInterview({ eventStatus: 'cancelled' })
    const rows = await list()
    expect(rows).toHaveLength(1)
    expect(rows[0].eventStatus).toBe('cancelled')
  })
})

describe('the joins do not multiply rows', () => {
  it('returns one row per interview with a session, brief, report and transcript', async () => {
    const { eventId } = await seedBookedInterview()

    const [session] = await db.insert(schema.interviewSessions).values({
      organizationId: ORG, eventId, ownerUserId: OWNER, state: 'processing',
      captureMode: 'remote_call', language: 'en', provider: 'deepgram',
      consentNoticeVersion: 'v1', captureCapability: 'microphone_only',
      startedAt: NOW, retentionExpiresAt: FAR_FUTURE(),
    }).returning({ id: schema.interviewSessions.id })

    for (let n = 1; n <= 3; n += 1) {
      await db.insert(schema.transcriptSegments).values({
        organizationId: ORG, sessionId: session.id, providerSegmentId: `req:0:${n}`, sequence: n,
        speakerEstimate: 'speaker_a', text: `Turn ${n}.`, startsMs: n * 1_000, endsMs: n * 1_000 + 900,
        retentionExpiresAt: FAR_FUTURE(),
      })
    }

    await db.transaction((tx) => insertBriefVersion(tx as never, {
      organizationId: ORG, eventId, ownerUserId: OWNER,
      content: {
        candidateSummary: 'Summary.', relevantEvidence: [], informationGaps: [],
        contradictions: [], questionGroups: [],
      },
      evidenceManifest: [], provider: null, model: null, promptVersion: null,
      status: 'active', retentionExpiresAt: FAR_FUTURE(),
    }))

    await db.insert(schema.interviewReports).values([
      {
        organizationId: ORG, eventId, ownerUserId: OWNER, version: 1, status: 'draft',
        content: {}, retentionExpiresAt: FAR_FUTURE(),
      },
      {
        organizationId: ORG, eventId, ownerUserId: OWNER, version: 2, status: 'final',
        content: {}, finalizedAt: NOW, retentionExpiresAt: FAR_FUTURE(),
      },
    ])

    const rows = await list()
    // One row. Three transcript segments and two report versions joined naively would give six.
    expect(rows).toHaveLength(1)
    expect(rows[0].transcriptSegments).toBe(3)
    expect(rows[0].hasBrief).toBe(true)
    expect(rows[0].sessionState).toBe('processing')
    // The *latest* version's status, not whichever the planner happened to pick.
    expect(rows[0].reportStatus).toBe('final')
  })

  it('counts a superseded brief as no brief', async () => {
    const { eventId } = await seedBookedInterview()
    await db.insert(schema.interviewBriefs).values({
      organizationId: ORG, eventId, ownerUserId: OWNER, version: 1, status: 'draft',
      content: {}, evidenceManifest: [], retentionExpiresAt: FAR_FUTURE(),
    })
    const rows = await list()
    // A draft existing is not the same as this interview having a brief to read, and a tick for one would
    // send the organizer to an empty page.
    expect(rows[0].hasBrief).toBe(false)
  })

  it('reports the latest report status when the newest is still a draft', async () => {
    const { eventId } = await seedBookedInterview()
    await db.insert(schema.interviewReports).values([
      {
        organizationId: ORG, eventId, ownerUserId: OWNER, version: 1, status: 'final',
        content: {}, finalizedAt: NOW, retentionExpiresAt: FAR_FUTURE(),
      },
      {
        organizationId: ORG, eventId, ownerUserId: OWNER, version: 2, status: 'draft',
        content: {}, retentionExpiresAt: FAR_FUTURE(),
      },
    ])
    expect((await list())[0].reportStatus).toBe('draft')
  })

  it('separates transcript counts between two interviews', async () => {
    const first = await seedBookedInterview({ startsAt: new Date('2027-12-02T09:00:00.000Z'), roleTitle: 'First' })
    const second = await seedBookedInterview({ startsAt: new Date('2027-12-03T09:00:00.000Z'), roleTitle: 'Second' })

    for (const [interview, count] of [[first, 2], [second, 5]] as const) {
      const [session] = await db.insert(schema.interviewSessions).values({
        organizationId: ORG, eventId: interview.eventId, ownerUserId: OWNER, state: 'processing',
        captureMode: 'in_person', language: 'en', provider: 'deepgram',
        consentNoticeVersion: 'v1', captureCapability: 'microphone_only',
        startedAt: NOW, retentionExpiresAt: FAR_FUTURE(),
      }).returning({ id: schema.interviewSessions.id })
      for (let n = 1; n <= count; n += 1) {
        await db.insert(schema.transcriptSegments).values({
          organizationId: ORG, sessionId: session.id, providerSegmentId: `s:${n}`, sequence: n,
          speakerEstimate: 'speaker_a', text: 'x', startsMs: n, endsMs: n + 1,
          retentionExpiresAt: FAR_FUTURE(),
        })
      }
    }

    const rows = await list()
    // The count is joined on the session id, not the organization: without that every interview would show
    // the whole organization's transcript volume.
    expect(rows.map((row) => [row.roleTitle, row.transcriptSegments])).toEqual([['Second', 5], ['First', 2]])
  })
})
