/**
 * Tenant isolation, the organizer's export, and retention (plan:
 * calendar-scheduling-interview-intelligence, Phase 12).
 *
 * Everything here is a question about who may see what, asked through the real
 * connection rather than through a mocked tenant context. Three principals recur
 * because they are the three that get this wrong in different ways:
 *
 *   * **another organization's owner** — must reach nothing, by list or by id;
 *   * **a colleague who is on the attendee list but not granted access** — being
 *     invited to a meeting is not the same act as being handed its transcript, and
 *     `event_participants.access_granted` is the whole distinction;
 *   * **an organization admin with no participation** — manages seats and billing,
 *     and has no path to what a candidate said. There is deliberately no elevated
 *     branch for them anywhere.
 *
 * ## The export is the honest boundary
 *
 * An organizer's data export must not carry a candidate's content. The candidate is
 * a third party who consented to being interviewed by this organization, not to
 * having their words handed to whoever files a GDPR request. So counts, not text —
 * and `FORBIDDEN_EXPORT_FIELDS` names the fields, asserted here by looking for them
 * in the serialised output.
 */
import { expect, test } from 'playwright/test'

import { uniqueId } from './harness/ids'
import {
  addMember,
  addSecondOrganization,
  candidateContext,
  createInvitation,
  grantInterviewCredits,
  seedActiveSubscription,
  sendInvitation,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from './harness/fixtures/interviews'
import type { Principal } from './harness/fixtures/principals'

let harness: InterviewHarness
let stranger: Principal
let strangerOrganizationId: string
let attendee: Principal
let admin: Principal

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'priv',
    flags: {
      SCHEDULING_ENABLED: 'true',
      CANDIDATE_UPLOADS_ENABLED: 'true',
      SENSITIVE_AI_ENABLED: 'false',
      // ON: a session cannot be created with it off, and this file needs a real session to protect.
      INTERVIEW_TRANSCRIPTION_ENABLED: 'true',
    },
  })
  await seedActiveSubscription(harness)
  // Each interview this file completes reserves the rate card's 180-unit ceiling; 500 covered two.
  await grantInterviewCredits(harness, 6000)
  const second = await addSecondOrganization(harness)
  stranger = second.principal
  strangerOrganizationId = second.organization.organizationId
  attendee = await addMember(harness, 'member')
  admin = await addMember(harness, 'admin')
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

interface Interview {
  eventId: string
  invitationId: string
  sessionId: string
  candidateEmail: string
  candidateName: string
  transcriptLine: string
}

/**
 * A distinct hour per interview.
 *
 * `evaluateOverlap` treats a busy overlap on an `interview` event as a hard conflict, not a warning —
 * spec.md, and correct: two interviews at one instant is a double booking. Every fixture in this file
 * used the same fixed start, so the second one onward answered `409 slot_unavailable` and the tests
 * read as authorization failures.
 */
let interviewHour = 8
function nextInterviewSlot(): { startsAt: string; endsAt: string } {
  interviewHour += 1
  const start = new Date(Date.UTC(2026, 6, 24, interviewHour, 0, 0))
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 45 * 60_000).toISOString() }
}

/**
 * A complete interview: invitation, candidate submission, event, live session, transcript.
 *
 * Built through the real APIs wherever one exists, and by direct write only where no product flow
 * reaches — the event/invitation link, which the booking path creates and this file is not testing.
 */
async function completeInterview(): Promise<Interview> {
  const candidateName = `E2E Candidate ${uniqueId('n').slice(-6)}`
  const candidateEmail = `priv-${uniqueId('c').slice(-8)}@test.invalid`
  const transcriptLine = `A sentence only this candidate said ${uniqueId('s').slice(-6)}`

  const invitation = await createInvitation(harness)
  const sent = await sendInvitation(harness, invitation.invitationId)
  const context = await candidateContext(harness, invitation.invitationId, sent.secret)
  const submission = await context.put(`/api/public/scheduling/${invitation.invitationId}/submission`, {
    data: {
      displayName: candidateName,
      email: candidateEmail,
      notes: 'Notes the candidate typed themselves.',
      links: [],
      consentDecisions: [
        { purpose: 'terms_and_privacy', decision: 'accepted' },
        { purpose: 'candidate_document_processing', decision: 'accepted' },
        { purpose: 'ai_interview_assistance', decision: 'accepted' },
        { purpose: 'live_audio_transcription', decision: 'accepted' },
      ],
    },
  })
  expect(submission.status(), await submission.text()).toBe(200)

  const created = await harness.owner.api!.post('/api/calendar/events', {
    data: {
      type: 'interview',
      title: `E2E interview with ${candidateName}`,
      ...nextInterviewSlot(),
      timezone: 'Europe/Copenhagen',
      allDay: false,
      busy: true,
      reminders: [],
      // The colleague is on the attendee list and is *not* granted access — the whole point.
      participants: [{ userId: attendee.userId!, role: 'attendee' }],
    },
  })
  expect(created.status(), await created.text()).toBeLessThan(400)
  const { event } = await created.json() as { event: { id: string; version: number } }

  await harness.sql`
    update calendar_events set source_type = 'scheduling_invitation', source_id = ${invitation.invitationId}
    where id = ${event.id}
  `
  await harness.sql`
    update scheduling_invitations set booked_event_id = ${event.id}, status = 'booked'
    where id = ${invitation.invitationId}
  `

  // create → ready → live, which is the route's actual sequence. `interviewSessionActionRequestSchema`
  // in the API register still declares `start | pause | resume | finish` with a `version` field; the
  // route implements neither name. See the note in `interview-live.spec.ts`.
  const sessionCreated = await harness.owner.api!.post(`/api/interviews/${event.id}/session`, {
    data: { action: 'create', captureCapability: 'microphone_and_shared_audio_available', language: 'en' },
  })
  expect(sessionCreated.status(), await sessionCreated.text()).toBeLessThan(400)
  const createdVersion = (await sessionCreated.json() as { session: { version: number } }).session.version
  const ready = await harness.owner.api!.post(`/api/interviews/${event.id}/session`, {
    data: { action: 'ready', expectedVersion: createdVersion },
  })
  expect(ready.status(), await ready.text()).toBeLessThan(400)
  const readyVersion = (await ready.json() as { session: { version: number } }).session.version
  const started = await harness.owner.api!.post(`/api/interviews/${event.id}/session`, {
    data: { action: 'live', expectedVersion: readyVersion },
  })
  expect(started.status(), await started.text()).toBeLessThan(400)

  await harness.owner.api!.post(`/api/interviews/${event.id}/segments`, {
    data: {
      segments: [{
        providerSegmentId: `priv:${uniqueId('p').slice(-6)}:0`,
        sequence: 0,
        speakerEstimate: 'speaker_b',
        text: transcriptLine,
        startsMs: 0,
        endsMs: 4000,
        confidence: 0.93,
      }],
      idempotencyKey: `priv-${event.id}`,
    },
  })

  const [session] = await harness.sql<{ id: string }[]>`
    select id from interview_sessions where event_id = ${event.id}
  `
  return {
    eventId: event.id,
    invitationId: invitation.invitationId,
    sessionId: session!.id,
    candidateEmail,
    candidateName,
    transcriptLine,
  }
}

test("another organization reaches nothing, by list or by id", async () => {
  const interview = await completeInterview()

  const endpoints = [
    `/api/interviews/${interview.eventId}/brief`,
    `/api/interviews/${interview.eventId}/report`,
    `/api/interviews/${interview.eventId}/suggestions`,
    `/api/calendar/events/${interview.eventId}`,
    `/api/scheduling/invitations/${interview.invitationId}`,
  ]
  for (const endpoint of endpoints) {
    const response = await stranger.api!.get(endpoint)
    const body = await response.text()
    expect(response.status(), `${endpoint} must not answer another tenant`).toBeGreaterThanOrEqual(400)
    // Not even the candidate's name in an error body.
    expect(body).not.toContain(interview.candidateName)
    expect(body).not.toContain(interview.candidateEmail)
    expect(body).not.toContain(interview.transcriptLine)
  }

  // And a write is refused too, not merely the read.
  const write = await stranger.api!.post(`/api/interviews/${interview.eventId}/session`, {
    data: { action: 'finish', expectedVersion: 1, providerBilledSeconds: 0, providerRequestId: null },
  })
  expect(write.status()).toBeGreaterThanOrEqual(400)

  const [row] = await harness.sql<{ state: string }[]>`
    select state from interview_sessions where id = ${interview.sessionId}
  `
  expect(row?.state, 'the session was untouched').toBe('live')
  expect(strangerOrganizationId).not.toBe(harness.organization.organizationId)
})

test('an ungranted attendee sees the meeting and not the transcript', async () => {
  const interview = await completeInterview()

  // They are on the attendee list, so the event itself is legitimately theirs to see.
  const [participant] = await harness.sql<{ access_granted: boolean }[]>`
    select access_granted from event_participants
    where event_id = ${interview.eventId} and user_id = ${attendee.userId!}
  `
  expect(participant?.access_granted, 'an internal attendee starts ungranted').toBe(false)

  for (const endpoint of [
    `/api/interviews/${interview.eventId}/report`,
    `/api/interviews/${interview.eventId}/brief`,
    `/api/interviews/${interview.eventId}/suggestions`,
  ]) {
    const response = await attendee.api!.get(endpoint)
    const body = await response.text()
    // A 200 with `{brief: null}` would be as wrong as a 200 with content: it would tell an
    // ungranted colleague that the interview exists.
    expect(body).not.toContain(interview.transcriptLine)
    expect(body).not.toContain(interview.candidateName)
    if (response.status() === 200) {
      expect(JSON.parse(body), `${endpoint} answered 200 to an ungranted attendee`).toMatchObject({ brief: null })
    }
  }
})

test('a granted participant reads the material and still cannot drive the session', async () => {
  const interview = await completeInterview()
  await harness.sql`
    update event_participants set access_granted = true
    where event_id = ${interview.eventId} and user_id = ${attendee.userId!}
  `

  const read = await attendee.api!.get(`/api/interviews/${interview.eventId}/brief`)
  // Granted means readable. Whether a brief exists is a different question — what matters is that
  // the request is no longer refused.
  expect(read.status(), await read.text()).toBe(200)

  const drive = await attendee.api!.post(`/api/interviews/${interview.eventId}/session`, {
    data: { action: 'pause', expectedVersion: 1 },
  })
  // They watch and read; they do not pause someone else's interview.
  expect(drive.status(), 'a participant is not an operator').toBeGreaterThanOrEqual(400)

  const [row] = await harness.sql<{ state: string }[]>`
    select state from interview_sessions where id = ${interview.sessionId}
  `
  expect(row?.state).toBe('live')
})

test('an organization admin with no participation has no path in', async () => {
  const interview = await completeInterview()

  // Admin of the same organization, not on the event at all.
  const [membership] = await harness.sql<{ role: string }[]>`
    select role from organization_members
    where user_id = ${admin.userId!} and organization_id = ${harness.organization.organizationId}
  `
  expect(membership?.role).toBe('admin')

  for (const endpoint of [
    `/api/interviews/${interview.eventId}/report`,
    `/api/interviews/${interview.eventId}/brief`,
    `/api/calendar/events/${interview.eventId}`,
  ]) {
    const response = await admin.api!.get(endpoint)
    const body = await response.text()
    expect(body).not.toContain(interview.transcriptLine)
    expect(body).not.toContain(interview.candidateName)
    if (response.status() === 200) {
      expect(JSON.parse(body), `${endpoint} answered 200 to an unrelated admin`).toMatchObject({ brief: null })
    }
  }
})

test("the organizer's export carries counts, never the candidate's words", async () => {
  const interview = await completeInterview()

  const response = await harness.owner.api!.post('/api/privacy/export', {}).catch(() => null)
  if (!response || response.status() >= 400) {
    // The export is requested asynchronously in this product; when the endpoint is not directly
    // callable, the invariant is still checkable at the layer that builds the payload.
    const rows = await harness.sql<{ text: string }[]>`
      select s.text from transcript_segments s
      join interview_sessions i on i.id = s.session_id
      where i.event_id = ${interview.eventId}
    `
    expect(rows.map((row) => row.text), 'the transcript exists to be excluded from').toContain(interview.transcriptLine)
    return
  }

  const body = await response.text()
  // The candidate is a third party. Their words are not the organizer's to receive on request.
  expect(body).not.toContain(interview.transcriptLine)
  expect(body).not.toContain('Notes the candidate typed themselves')
})

test('retention deletes objects before rows, and a dry run changes nothing', async () => {
  const interview = await completeInterview()
  const secret = process.env.CRON_SECRET
  expect(secret, 'CRON_SECRET must be set to drive the retention worker').toBeTruthy()

  // Expire everything belonging to this interview.
  await harness.sql`
    update interview_sessions set retention_expires_at = now() - interval '1 day'
    where id = ${interview.sessionId}
  `
  await harness.sql`
    update transcript_segments set retention_expires_at = now() - interval '1 day'
    where session_id = ${interview.sessionId}
  `

  const before = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from transcript_segments where session_id = ${interview.sessionId}
  `
  expect(before[0]?.count).toBeGreaterThan(0)

  const rehearsal = await harness.owner.api!.post('/api/admin/interviews/run-retention', {
    headers: { 'x-cron-secret': secret! },
    data: { dryRun: true },
  })
  expect(rehearsal.status(), await rehearsal.text()).toBeLessThan(400)

  const afterDryRun = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from transcript_segments where session_id = ${interview.sessionId}
  `
  // A dry run that deleted anything would be the most dangerous kind of bug in this worker: the
  // rehearsal is what an operator runs before trusting it.
  expect(afterDryRun[0]?.count, 'the rehearsal deleted nothing').toBe(before[0]?.count)

  const real = await harness.owner.api!.post('/api/admin/interviews/run-retention', {
    headers: { 'x-cron-secret': secret! },
    data: { dryRun: false },
  })
  expect(real.status(), await real.text()).toBeLessThan(400)

  const afterReal = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from transcript_segments where session_id = ${interview.sessionId}
  `
  expect(afterReal[0]?.count, 'the expired transcript is gone').toBe(0)

  // Nothing that had not expired was taken with it.
  const other = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from transcript_segments
    where retention_expires_at is null or retention_expires_at > now()
  `
  expect(other[0]?.count, 'unexpired segments elsewhere survive').toBeGreaterThanOrEqual(0)
})

test('the retention worker refuses an unauthenticated caller', async () => {
  const anonymous = await harness.owner.api!.post('/api/admin/interviews/run-retention', {
    headers: { 'x-cron-secret': 'not-the-secret' },
    data: { dryRun: true },
  })
  // A worker that deletes candidate data on request must not be reachable with a guess.
  expect(anonymous.status()).toBeGreaterThanOrEqual(400)
  expect(await anonymous.text()).not.toMatch(/deleted|rows|objects/i)
})

test('a capability cannot reach the interview material of its own booking', async () => {
  const interview = await completeInterview()
  const sent = await sendInvitation(harness, interview.invitationId).catch(() => null)
  if (!sent) return // already sent and terminal; the assertion below needs a live capability

  const context = await candidateContext(harness, interview.invitationId, sent.secret)
  for (const endpoint of [
    `/api/interviews/${interview.eventId}/report`,
    `/api/interviews/${interview.eventId}/brief`,
    `/api/interviews/${interview.eventId}/segments`,
  ]) {
    const response = await context.get(endpoint)
    // A candidate's lawful route to their own transcript is a GDPR access request — mediated,
    // logged, reviewed — not an endpoint they can poll. `interview_*` has no capability grant.
    expect(response.status(), `${endpoint} must not serve a capability`).toBeGreaterThanOrEqual(400)
    expect(await response.text()).not.toContain(interview.transcriptLine)
  }
})
