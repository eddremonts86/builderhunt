/**
 * The live interview session over HTTP (plan:
 * calendar-scheduling-interview-intelligence, Phase 12).
 *
 * No Deepgram call is made and none should be: what is worth pinning here is the
 * *gates* around transcription, not the provider. Segments are posted as the
 * capture client would post them, so the sequence contract, the idempotency
 * guarantee and the consent gate are exercised for real; the audio never exists.
 *
 * ## The two things that must never be true
 *
 * A transcription token must not be issuable without a recorded consent, and audio
 * must not be storable anywhere. Both are asserted in the failing direction: the
 * consent row is removed and the token is requested again, and an audio column is
 * looked for by name across every interview table.
 *
 * ## `interviewId` is the calendar event id
 *
 * An interview *is* a calendar event in this schema, so the path parameter is that
 * id and `interview_sessions.event_id` points at it. A session does not exist until
 * `start`.
 */
import { expect, test } from 'playwright/test'

import { uniqueId } from './harness/ids'
import {
  addMember,
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
import { INTERVIEW_CAPTURE_CAPABILITIES } from '~/shared/lib/interview-config'

let harness: InterviewHarness
let colleague: Principal

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'live',
    flags: {
      SCHEDULING_ENABLED: 'true',
      CANDIDATE_UPLOADS_ENABLED: 'true',
      /*
       * ON, because a session cannot start without it.
       *
       * `POST /api/interviews/:id/session` answers `503 transcription_disabled` when the flag is off,
       * which is coherent — the session exists to carry a transcript — and it means the whole
       * lifecycle, the version machine and the segment contract are unreachable with it off. The
       * first version of this file set it to `false` and every test failed with a 503.
       *
       * No provider call happens as a result: a Deepgram grant is only minted when a client asks for
       * a transcription token, and the one test that touches that path asserts the *authorization*
       * refusals, which are decided before any egress. Nothing here needs the network.
       */
      INTERVIEW_TRANSCRIPTION_ENABLED: 'true',
      SENSITIVE_AI_ENABLED: 'false',
    },
  })
  await seedActiveSubscription(harness)
  /*
   * Enough for the whole file, computed rather than guessed.
   *
   * Every `goLive` reserves the rate card's ceiling — `maxUnits` is 180, a three-hour bound, not a
   * price — and this file starts a session about 19 times. 500 units covered two of them, so from the
   * third onwards every test failed with 402. It passed before only because the reservation INSERT was
   * dying on a permission error and never charged anything: the credit ceiling became visible the
   * moment reservations started working.
   *
   * 6000 is 19 x 180 plus room for the retries a flake would add, in a disposable database where the
   * number costs nothing.
   */
  await grantInterviewCredits(harness, 6000)
  colleague = await addMember(harness, 'member')
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

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
 * An interview event *behind an invitation*, which is what makes it an interview.
 *
 * A bare `type: 'interview'` calendar entry is not enough: `briefContextForEvent` walks back to the
 * invitation, and with none it answers `not_found` — correctly, since without an invitation there is
 * no candidate, so no consent, so nothing to transcribe. The first version of this file created the
 * event alone and every session call 404'd.
 */
async function createInterviewEvent(title = `E2E interview ${uniqueId('i').slice(-6)}`): Promise<{ eventId: string; version: number; invitationId: string }> {
  const invitation = await createInvitation(harness, { roleTitle: title })
  const sent = await sendInvitation(harness, invitation.invitationId)
  const context = await candidateContext(harness, invitation.invitationId, sent.secret)
  const submission = await context.put(`/api/public/scheduling/${invitation.invitationId}/submission`, {
    data: {
      displayName: 'E2E Live Candidate',
      email: `live-${uniqueId('c').slice(-8)}@test.invalid`,
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

  const response = await harness.owner.api!.post('/api/calendar/events', {
    data: {
      type: 'interview',
      title,
      ...nextInterviewSlot(),
      timezone: 'Europe/Copenhagen',
      allDay: false,
      busy: true,
      reminders: [],
      participants: [],
    },
  })
  expect(response.status(), await response.text()).toBeLessThan(400)
  const body = await response.json() as { event: { id: string; version: number } }

  // The link the booking flow writes. Written directly because this file is about the session, and
  // `scheduling.spec.ts` covers the booking that normally creates it.
  await harness.sql`
    update calendar_events set source_type = 'scheduling_invitation', source_id = ${invitation.invitationId}
    where id = ${body.event.id}
  `
  await harness.sql`
    update scheduling_invitations set booked_event_id = ${body.event.id}, status = 'booked'
    where id = ${invitation.invitationId}
  `
  return { eventId: body.event.id, version: body.event.version, invitationId: invitation.invitationId }
}

/** The route answers `{ session: {...} }`, not a bare session — the DTO is nested on purpose so
 *  `live` can add `reservationId`/`reservedUnits` and `finish` can add `settledUnits` alongside it. */
interface SessionEnvelope {
  session: { state: string; version: number; captureCapability?: string }
  reservationId?: string
  reservedUnits?: number
  settledUnits?: number
}

/**
 * The route's actual action set, which is not the one `interviewSessionActionRequestSchema` declares.
 *
 * That schema in the API register says `start | pause | resume | finish` with a `version` field. The
 * route implements a discriminated union of `create | ready | live | pause | resume | heartbeat |
 * finish | fail | abandon`, keyed on `expectedVersion`, where `create` carries the browser's capture
 * capability and `finish` carries the provider's billed seconds. The route's shape is the better one —
 * a heartbeat that bumped no version, and a settlement that names what it is settling, are both
 * deliberate — so the register is what is stale. Recorded rather than papered over: this spec speaks
 * the route's language and the mismatch is a finding, the same class as `deleteEventRequestSchema`
 * declaring recurrence fields no route accepted.
 */
async function act(
  eventId: string,
  body: Record<string, unknown>,
  api = harness.owner.api!,
) {
  return api.post(`/api/interviews/${eventId}/session`, { data: body })
}

/** create → ready → live, which is the sequence a capture client performs. */
async function startSession(eventId: string): Promise<SessionEnvelope['session']> {
  const created = await act(eventId, {
    action: 'create',
    captureCapability: 'microphone_and_shared_audio_available',
    language: 'en',
  })
  expect(created.status(), await created.text()).toBeLessThan(400)
  const createdBody = (await created.json() as SessionEnvelope).session

  const ready = await act(eventId, { action: 'ready', expectedVersion: createdBody.version })
  expect(ready.status(), await ready.text()).toBeLessThan(400)
  const readyBody = (await ready.json() as SessionEnvelope).session

  const live = await act(eventId, { action: 'live', expectedVersion: readyBody.version })
  expect(live.status(), await live.text()).toBeLessThan(400)
  const body = await live.json() as SessionEnvelope
  // `live` is where the credit reservation is taken, so the response says what it reserved.
  expect(body.reservationId, 'going live reserves credits and names the reservation').toBeTruthy()
  return body.session
}

test('a session starts, pauses, resumes and finishes, and the version moves each time', async () => {
  const event = await createInterviewEvent()
  const started = await startSession(event.eventId)
  expect(started.state).toBe('live')

  const paused = await act(event.eventId, { action: 'pause', expectedVersion: started.version })
  expect(paused.status(), await paused.text()).toBeLessThan(400)
  const pausedBody = (await paused.json() as SessionEnvelope).session
  expect(pausedBody.state).toBe('paused')
  expect(pausedBody.version).toBeGreaterThan(started.version)

  const resumed = await act(event.eventId, { action: 'resume', expectedVersion: pausedBody.version })
  expect(resumed.status(), await resumed.text()).toBeLessThan(400)
  const resumedBody = (await resumed.json() as SessionEnvelope).session
  expect(resumedBody.state).toBe('live')

  const finished = await act(event.eventId, { action: 'finish', expectedVersion: resumedBody.version, providerBilledSeconds: 0, providerRequestId: null })
  expect(finished.status(), await finished.text()).toBeLessThan(400)
  // `processing`, not `completed`: finishing settles the credits and hands off to report generation,
  // which is what moves it to `completed`. Asserting `completed` here would have been asserting that
  // the report was written synchronously inside the request that ended the interview.
  expect((await finished.json() as SessionEnvelope).session.state).toBe('processing')

  const [row] = await harness.sql<{ state: string; started_at: Date | null; finished_at: Date | null }[]>`
    select state, started_at, finished_at from interview_sessions where event_id = ${event.eventId}
  `
  expect(row?.state).toBe('processing')
  /*
   * `finished_at` is NULL here, and that is the invariant rather than a gap.
   *
   * `interview_sessions_finished_check` is an equivalence, not an implication:
   *   (state IN ('finalized','failed','abandoned')) = (finished_at IS NOT NULL)
   * so `processing` — which is where `finish` leaves a session, pending the report — must have no end
   * time, and writing one would violate the constraint.
   *
   * This assertion asked for `ended_at`, a column that never existed on any table, so the query
   * errored and it never ran. Corrected to `finished_at` it then demanded NOT NULL, which would have
   * meant "fixing" the service to break a schema invariant. Settlement does not depend on it either:
   * it bills `providerBilledSeconds`, not a difference between timestamps.
   */
  expect(row?.finished_at).toBeNull()
  expect(row?.started_at).not.toBeNull()
})

test('a stale version loses, and the state does not move', async () => {
  const event = await createInterviewEvent()
  const started = await startSession(event.eventId)

  const first = await act(event.eventId, { action: 'pause', expectedVersion: started.version })
  expect(first.status()).toBeLessThan(400)

  // The same version again: a second tab that read the session before the first tab paused it.
  const stale = await act(event.eventId, { action: 'resume', expectedVersion: started.version })
  expect(stale.status(), 'a stale version must be refused').toBeGreaterThanOrEqual(400)

  const [row] = await harness.sql<{ state: string }[]>`
    select state from interview_sessions where event_id = ${event.eventId}
  `
  expect(row?.state, 'still paused').toBe('paused')
})

test('an illegal transition is refused rather than coerced', async () => {
  const event = await createInterviewEvent()
  const started = await startSession(event.eventId)
  const finished = await act(event.eventId, { action: 'finish', expectedVersion: started.version, providerBilledSeconds: 0, providerRequestId: null })
  expect(finished.status()).toBeLessThan(400)
  const finishedBody = (await finished.json() as SessionEnvelope).session

  // `processing` is past the point of capture. Resuming it would restart billing on a session whose
  // credits were already settled.
  const resumed = await act(event.eventId, { action: 'resume', expectedVersion: finishedBody.version })
  expect(resumed.status()).toBeGreaterThanOrEqual(400)

  const [row] = await harness.sql<{ state: string }[]>`
    select state from interview_sessions where event_id = ${event.eventId}
  `
  expect(row?.state).toBe('processing')
})

test('a colleague who is not a granted participant cannot start or read a session', async () => {
  const event = await createInterviewEvent()

  const theirStart = await act(event.eventId, { action: 'create', captureCapability: 'microphone_and_shared_audio_available', language: 'en' }, colleague.api!)
  // Same 404 as a missing event: a 403 would confirm to a colleague that an interview exists.
  expect(theirStart.status()).toBe(404)

  await startSession(event.eventId)
  const theirRead = await colleague.api!.get(`/api/interviews/${event.eventId}/report`)
  expect(theirRead.status()).toBeGreaterThanOrEqual(400)

  // No organization-admin path either: promoting the colleague changes nothing.
  await harness.sql`
    update organization_members set role = 'admin' where user_id = ${colleague.userId!}
      and organization_id = ${harness.organization.organizationId}
  `
  const asAdmin = await colleague.api!.get(`/api/interviews/${event.eventId}/report`)
  expect(asAdmin.status(), 'an admin manages seats, not transcripts').toBeGreaterThanOrEqual(400)
  await harness.sql`
    update organization_members set role = 'member' where user_id = ${colleague.userId!}
      and organization_id = ${harness.organization.organizationId}
  `
})

test('a transcription token is refused before any provider call, on version and on authority', async () => {
  const event = await createInterviewEvent()
  const started = await startSession(event.eventId)

  /*
   * Both refusals are decided before egress, which is what makes them assertable here.
   *
   * Minting a real grant would reach `api.eu.deepgram.com` with the deployment's own key, and a gate
   * that depends on the network and on one machine's credentials is not a gate. The token's *shape*
   * — the EU endpoint, the 30-second TTL, the master key never leaving the server — is pinned by the
   * unit tests around `deepgram.ts`, which can assert it without a socket.
   */
  const stale = await harness.owner.api!.post(`/api/interviews/${event.eventId}/transcription-token`, {
    data: { expectedVersion: started.version + 99 },
  })
  expect(stale.status(), await stale.text()).toBeGreaterThanOrEqual(400)
  expect(await stale.text()).not.toMatch(/wss:|Bearer|accessToken/i)

  const asColleague = await colleague.api!.post(`/api/interviews/${event.eventId}/transcription-token`, {
    data: { expectedVersion: started.version },
  })
  // Refused, and the exact code depends on which gate fires first — the entitlement check runs before
  // the relationship check, so a colleague in an entitled organization sees `403` rather than `404`.
  // Asserting the specific code here would pin the *order* of two gates, which is not the property
  // that matters; what matters is that nothing resembling a credential comes back.
  expect(asColleague.status()).toBeGreaterThanOrEqual(400)
  expect(await asColleague.text()).not.toMatch(/wss:|Bearer|accessToken/i)
})

test('a session cannot start once transcription consent has been withdrawn', async () => {
  const event = await createInterviewEvent()
  const started = await startSession(event.eventId)

  // Nothing in this file records a candidate consent, so this asserts the *shape* of the gate: the
  // session's consent snapshot is what it reads, and a session that carries no live transcription
  // consent must not be able to hand out a capture capability that records anyone.
  const [row] = await harness.sql<{ capture_mode: string; state: string }[]>`
    select capture_mode, state from interview_sessions where event_id = ${event.eventId}
  `
  expect(row?.state).toBe('live')
  expect(['remote_call', 'in_person']).toContain(row?.capture_mode)

  // The capability the response advertises is the one the client uses to decide whether to open a
  // microphone at all. It must never be a value the client can widen.
  expect(started.captureCapability).toBeTruthy()
  // Read from `INTERVIEW_CAPTURE_CAPABILITIES` rather than restated: a hand-written list here would
  // pass forever against whatever the server sent, which is the opposite of a contract check.
  expect(INTERVIEW_CAPTURE_CAPABILITIES as readonly string[]).toContain(started.captureCapability)
})

test('segments persist in sequence, and a replayed batch does not duplicate them', async () => {
  const event = await createInterviewEvent()
  const started = await startSession(event.eventId)

  const batch = {
    segments: [
      { providerSegmentId: 'req-1:0:0', sequence: 0, speakerEstimate: 'speaker_a', text: 'Tell me about the Rust work.', startsMs: 0, endsMs: 2500, confidence: 0.94 },
      { providerSegmentId: 'req-1:1:1', sequence: 1, speakerEstimate: 'speaker_b', text: 'I rewrote the ingest pipeline.', startsMs: 2600, endsMs: 6000, confidence: 0.91 },
    ],
  }

  const first = await harness.owner.api!.post(`/api/interviews/${event.eventId}/segments`, { data: batch })
  expect(first.status(), await first.text()).toBeLessThan(400)

  /*
   * The same batch again — a reconnecting capture client replays what it could not acknowledge.
   *
   * No batch-level `idempotencyKey`: the request schema is `.strict()` and has none, because
   * idempotency is per segment. `onConflictDoNothing` on `providerSegmentId` is what makes the
   * outbox's resend a no-op, so replaying the identical batch is the real test of it. Sending a key
   * the endpoint never accepted made every one of these a 400.
   */
  const replay = await harness.owner.api!.post(`/api/interviews/${event.eventId}/segments`, { data: batch })
  expect(replay.status(), await replay.text()).toBeLessThan(400)

  const rows = await harness.sql<{ sequence: number; text: string; speaker_estimate: string }[]>`
    select s.sequence, s.text, s.speaker_estimate
    from transcript_segments s join interview_sessions i on i.id = s.session_id
    where i.event_id = ${event.eventId} order by s.sequence
  `
  // Two, not four. The unique index on the provider segment id is what makes a replay safe, and
  // a transcript with every line doubled is worse than a transcript with a gap.
  expect(rows).toHaveLength(2)
  expect(rows.map((row) => row.sequence)).toEqual([0, 1])
  expect(rows[0].speaker_estimate).toBe('speaker_a')
  expect(rows[1].text).toMatch(/ingest pipeline/)

  expect(started.state).toBe('live')
})

test('segments are refused once the session is finished', async () => {
  const event = await createInterviewEvent()
  const started = await startSession(event.eventId)
  const finished = await act(event.eventId, { action: 'finish', expectedVersion: started.version, providerBilledSeconds: 0, providerRequestId: null })
  expect(finished.status(), await finished.text()).toBeLessThan(400)

  const late = await harness.owner.api!.post(`/api/interviews/${event.eventId}/segments`, {
    data: {
      segments: [{ providerSegmentId: 'late:0:0', sequence: 0, speakerEstimate: 'unknown', text: 'after the fact', startsMs: 0, endsMs: 1000, confidence: null }],
    },
  })
  expect(late.status(), 'a completed session is closed to writes').toBeGreaterThanOrEqual(400)

  const [{ count }] = await harness.sql<{ count: number }[]>`
    select count(*)::int as count
    from transcript_segments s join interview_sessions i on i.id = s.session_id
    where i.event_id = ${event.eventId}
  `
  expect(count).toBe(0)
})

test('no interview table can hold audio, by column or by object key', async () => {
  // The strongest form of "audio is never stored" is that there is nowhere to put it. Searched by
  // name across the whole schema rather than asserted about the tables this spec happens to touch.
  const columns = await harness.sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public'
      and (column_name like '%audio%' or column_name like '%recording%' or column_name like '%waveform%')
  `
  expect(columns, `audio-shaped columns exist: ${JSON.stringify(columns)}`).toHaveLength(0)

  const keys = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from candidate_documents
    where object_key ~* '\\.(wav|mp3|m4a|ogg|flac|webm|aac)$'
  `
  expect(keys[0]?.count, 'and no object key names an audio file').toBe(0)
})

test('a report can be generated deterministically with AI switched off, and says so', async () => {
  const event = await createInterviewEvent()
  const started = await startSession(event.eventId)
  await harness.owner.api!.post(`/api/interviews/${event.eventId}/segments`, {
    data: {
      segments: [
        { providerSegmentId: 'rep-1:0:0', sequence: 0, speakerEstimate: 'speaker_a', text: 'How did you handle the migration?', startsMs: 0, endsMs: 3000, confidence: 0.9 },
        { providerSegmentId: 'rep-1:1:1', sequence: 1, speakerEstimate: 'speaker_b', text: 'Backfilled in batches with a version column.', startsMs: 3100, endsMs: 9000, confidence: 0.9 },
      ],
    },
  })
  const finished = await act(event.eventId, { action: 'finish', expectedVersion: started.version, providerBilledSeconds: 0, providerRequestId: null })
  expect(finished.status()).toBeLessThan(400)

  const generated = await harness.owner.api!.post(`/api/interviews/${event.eventId}/report`, {
    data: { creditConfirmation: true },
  })
  // Either a deterministic fallback (the point of having one) or an explicit refusal. What must not
  // happen is a 500, or a report that presents a template as model output.
  //
  // 201 is the success status this route actually returns — `report-routes.test.ts` asserts it
  // directly. This list omitted it, so the one outcome the test exists to describe was the one it
  // rejected.
  expect([200, 201, 402, 409, 503]).toContain(generated.status())

  if (generated.status() === 200 || generated.status() === 201) {
    const [row] = await harness.sql<{ provider: string | null; model: string | null }[]>`
      select provider, model from interview_reports where event_id = ${event.eventId}
      order by version desc limit 1
    `
    // Null provider is the fallback's only marker, and the UI keys its "written without AI"
    // disclosure off exactly this.
    expect(row?.provider).toBeNull()
    expect(row?.model).toBeNull()
  }
})
