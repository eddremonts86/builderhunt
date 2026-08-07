/**
 * The candidate's half of scheduling, from the link in the email to a booked
 * interview (plan: calendar-scheduling-interview-intelligence, Phase 12).
 *
 * `scheduling-organizer.spec.ts` covers the panel a recruiter drives. This is the
 * side that a stranger reaches with nothing but a URL, which makes it the part
 * where a mistake is a data-protection incident rather than a bug: the capability
 * has to work exactly once for exactly one invitation, and every neighbouring
 * invitation has to be invisible to it.
 *
 * ## Why the secret comes from the send response
 *
 * It is minted at send and only its SHA-256 hash is persisted, so no query can
 * recover one — deliberately, and it is why there is no "resend". In `E2E_MODE` the
 * email sender routes into the outbox and hands the link back, which is the only
 * seam that exists. A spec that fabricated a secret would be testing its own
 * arithmetic.
 *
 * ## The invitation that was already revoked
 *
 * The first thing this file asserts is that a freshly sent invitation opens,
 * because the reported failure was an invitation reading as revoked within five
 * minutes of being created. The cause was `send.ts` discarding `devLink` — the
 * link the candidate received had no secret at all — and this is the assertion
 * that would have caught it.
 */
import { expect, test } from 'playwright/test'

import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'
import { publicSlotRange } from './harness/clock'
import { uniqueId } from './harness/ids'
import {
  anonymousContext,
  candidateContext,
  createInvitation,
  readInvitationVersion,
  sendInvitation,
  startInterviewHarness,
  stopInterviewHarness,
  trackBuilder,
  type InterviewHarness,
} from './harness/fixtures/interviews'

let harness: InterviewHarness

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'sched',
    flags: { SCHEDULING_ENABLED: 'true', CANDIDATE_UPLOADS_ENABLED: 'false' },
  })
  // An availability policy, or every slots query answers with an empty list and every
  // booking assertion below fails for that reason instead of a real one.
  const current = await harness.owner.api!.get('/api/calendar/availability')
  const { version } = await current.json() as { version: number }
  const write = await harness.owner.api!.put('/api/calendar/availability', {
    data: {
      version,
      rules: [{
        timeZone: 'Europe/Copenhagen',
        weekdays: [1, 2, 3, 4, 5],
        localStart: '09:00',
        localEnd: '17:00',
        slotMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        // Zero notice: the fixed clock sits inside the window this spec books in, and a
        // two-hour notice would filter out the very slots it asks for.
        minNoticeMinutes: 0,
        horizonDays: 60,
        enabled: true,
      }],
      overrides: [],
      defaultReminderOffsets: [60],
      defaultReminderChannels: ['email'],
    },
  })
  expect(write.status(), await write.text()).toBeLessThan(400)
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

// Anchored to the wall clock, not `E2E_FIXED_TIME` — see `publicSlotRange`.
const SLOT_RANGE = publicSlotRange()

interface Slot { slotId: string; startsAt: string; endsAt: string }

async function readSlots(
  context: Awaited<ReturnType<typeof candidateContext>>,
  invitationId: string,
): Promise<Slot[]> {
  const response = await context.get(
    `/api/public/scheduling/${invitationId}/slots?${new URLSearchParams({ ...SLOT_RANGE, timezone: 'Europe/Copenhagen' })}`,
  )
  expect(response.status(), await response.text()).toBe(200)
  const { slots } = await response.json() as { slots: Slot[] }
  return slots
}

/** The full consent set a booking requires, all accepted. */
interface ConsentDecisionInput { purpose: string; decision: 'accepted' | 'declined' }

const ALL_ACCEPTED: ConsentDecisionInput[] = [
  'terms_and_privacy',
  'candidate_document_processing',
  'public_web_import',
  'ai_interview_assistance',
  'live_audio_transcription',
].map((purpose) => ({ purpose, decision: 'accepted' }))

async function submitCandidate(
  context: Awaited<ReturnType<typeof candidateContext>>,
  invitationId: string,
  decisions: ConsentDecisionInput[] = ALL_ACCEPTED,
): Promise<{ submissionVersion: number; consentReceipts: Array<{ id: string; purpose: string }> }> {
  const response = await context.put(`/api/public/scheduling/${invitationId}/submission`, {
    data: {
      displayName: 'E2E Candidate',
      email: `cand-${uniqueId('c').slice(-8)}@test.invalid`,
      links: [],
      consentDecisions: decisions,
    },
  })
  expect(response.status(), await response.text()).toBe(200)
  return response.json() as Promise<{ submissionVersion: number; consentReceipts: Array<{ id: string; purpose: string }> }>
}

test('a freshly sent invitation opens, and does not read as already revoked', async () => {
  const invitation = await createInvitation(harness)
  const sent = await sendInvitation(harness, invitation.invitationId)

  // The link carries a usable secret. `sendInvitation` throws otherwise, which is the
  // whole point: the reported bug was a link with no fragment at all.
  expect(sent.link).toContain(`/schedule/${invitation.invitationId}#`)
  expect(sent.secret.length).toBeGreaterThanOrEqual(32)

  const context = await candidateContext(harness, invitation.invitationId, sent.secret)
  const details = await context.get(`/api/public/scheduling/${invitation.invitationId}`)
  expect(details.status(), await details.text()).toBe(200)
  const body = await details.json() as { roleTitle: string; durationMinutes: number }
  expect(body.roleTitle).toBe(invitation.roleTitle)

  // The exchange also marks it opened, which is the organizer's read receipt.
  const [row] = await harness.sql<{ status: string }[]>`
    select status from scheduling_invitations where id = ${invitation.invitationId}
  `
  expect(row?.status).toBe('opened')
})

test('the capability reaches exactly one invitation', async () => {
  const mine = await createInvitation(harness, { roleTitle: 'E2E capability mine' })
  const neighbour = await createInvitation(harness, { roleTitle: 'E2E capability neighbour' })
  const sent = await sendInvitation(harness, mine.invitationId)
  await sendInvitation(harness, neighbour.invitationId)

  const context = await candidateContext(harness, mine.invitationId, sent.secret)

  // The cookie is invitation-scoped. Pointing it at the neighbour must not read the
  // neighbour — the same organization, the same owner, a different capability.
  const crossed = await context.get(`/api/public/scheduling/${neighbour.invitationId}`)
  expect(crossed.status(), 'a capability must not cross to another invitation').toBe(404)
  expect(await crossed.text()).toMatch(/invitation_unavailable/)
})

test('no capability at all is refused, and reveals nothing about which ids exist', async () => {
  const real = await createInvitation(harness)
  await sendInvitation(harness, real.invitationId)
  const anonymous = await anonymousContext(harness)

  const existing = await anonymous.get(`/api/public/scheduling/${real.invitationId}`)
  const invented = await anonymous.get('/api/public/scheduling/00000000-0000-4000-8000-000000000000')

  // Identical answers. A different status for a real id would turn this endpoint into an
  // enumeration oracle for who is interviewing where.
  expect(existing.status()).toBe(invented.status())
  expect(await existing.text()).toBe(await invented.text())
  expect(existing.status()).toBe(404)
})

test('a revoked invitation stops answering, in the same words as one that never existed', async () => {
  const invitation = await createInvitation(harness)
  const sent = await sendInvitation(harness, invitation.invitationId)
  const context = await candidateContext(harness, invitation.invitationId, sent.secret)
  expect((await context.get(`/api/public/scheduling/${invitation.invitationId}`)).status()).toBe(200)

  const version = await readInvitationVersion(invitation.invitationId, harness.owner.api!)
  const revoke = await harness.owner.api!.post(`/api/scheduling/invitations/${invitation.invitationId}/revoke`, {
    data: { version, idempotencyKey: `revoke-${invitation.invitationId}` },
  })
  expect(revoke.status(), await revoke.text()).toBeLessThan(400)

  const after = await context.get(`/api/public/scheduling/${invitation.invitationId}`)
  expect(after.status(), 'the live session dies with the invitation').toBe(404)
  expect(await after.text()).toMatch(/invitation_unavailable/)
})

test('a candidate books a slot, and the booking creates the interview event', async () => {
  const invitation = await createInvitation(harness)
  const sent = await sendInvitation(harness, invitation.invitationId)
  const context = await candidateContext(harness, invitation.invitationId, sent.secret)

  const slots = await readSlots(context, invitation.invitationId)
  expect(slots.length, 'the availability policy produces slots').toBeGreaterThan(0)

  const submission = await submitCandidate(context, invitation.invitationId)
  const chosen = slots[0]
  const booking = await context.post(`/api/public/scheduling/${invitation.invitationId}/book`, {
    data: {
      slotId: chosen.slotId,
      slotStartsAt: chosen.startsAt,
      submissionVersion: submission.submissionVersion,
      consentReceiptIds: submission.consentReceipts.map((receipt) => receipt.id),
      idempotencyKey: `book-${invitation.invitationId}`,
    },
  })
  expect(booking.status(), await booking.text()).toBe(200)
  const booked = await booking.json() as { eventId: string; managementCapability: string }
  expect(booked.eventId).toBeTruthy()

  // The event exists, is an interview, and is bound back to the invitation — which is what
  // makes the organizer's calendar and the candidate's booking the same fact.
  const [event] = await harness.sql<{ type: string; source_type: string | null; source_id: string | null; starts_at: Date }[]>`
    select type, source_type, source_id, starts_at from calendar_events where id = ${booked.eventId}
  `
  expect(event?.type).toBe('interview')
  expect(event?.source_type).toBe('scheduling_invitation')
  expect(event?.source_id).toBe(invitation.invitationId)
  expect(event?.starts_at.toISOString()).toBe(chosen.startsAt)

  const [row] = await harness.sql<{ status: string }[]>`
    select status from scheduling_invitations where id = ${invitation.invitationId}
  `
  expect(row?.status).toBe('booked')
})

/**
 * The delivery ledger after a booking (plan: calendar-scheduling-interview-intelligence, Phase 5
 * "Add calendar invitation email and ICS generation").
 *
 * This is the assertion the unit tests cannot make. `notifyAppointmentChange` is mocked at the
 * repository boundary there, so nothing in that suite touches a role, a grant or a CHECK — and both of
 * those bit on the way in: the notice runs in a worker-role transaction because the candidate route
 * authorizes as `builderhunt_capability` (SELECT only), and its first version wrote a `kind` the
 * ledger's CHECK rejects, which the module's own catch swallowed while bookings kept succeeding.
 *
 * Reading the ledger rather than the outbox is deliberate: the app runs in a child process, so the
 * in-process outbox is unreachable from here. The rows are also the stronger evidence — they prove the
 * write happened under the real role.
 */
test('a booking writes one delivery per party, and booking again does not notify twice', async () => {
  const invitation = await createInvitation(harness)
  const sent = await sendInvitation(harness, invitation.invitationId)
  const context = await candidateContext(harness, invitation.invitationId, sent.secret)

  const slots = await readSlots(context, invitation.invitationId)
  const submission = await submitCandidate(context, invitation.invitationId)
  const chosen = slots[0]
  const bookBody = {
    slotId: chosen.slotId,
    slotStartsAt: chosen.startsAt,
    submissionVersion: submission.submissionVersion,
    consentReceiptIds: submission.consentReceipts.map((receipt) => receipt.id),
    idempotencyKey: `book-${invitation.invitationId}`,
  }

  const booking = await context.post(`/api/public/scheduling/${invitation.invitationId}/book`, { data: bookBody })
  expect(booking.status(), await booking.text()).toBe(200)
  const { eventId } = await booking.json() as { eventId: string }

  const deliveries = await harness.sql<{
    kind: string
    state: string
    idempotency_key: string
    recipient_user_id: string | null
    external_recipient_hash: string | null
    invitation_id: string | null
    error_code: string | null
  }[]>`
    select kind, state, idempotency_key, recipient_user_id, external_recipient_hash, invitation_id, error_code
    from calendar_notification_deliveries
    where event_id = ${eventId} order by idempotency_key
  `

  expect(deliveries.length, 'one notice for the candidate and one for the organizer').toBe(2)
  // `sent`, not `pending`: the send really ran. A `failed` row here would mean the notice was attempted
  // and rejected, which is the state the first version of this code produced on every booking.
  expect(deliveries.map((row) => row.state)).toEqual(['sent', 'sent'])
  expect(deliveries.map((row) => row.error_code)).toEqual([null, null])
  // The bare kind the CHECK allows. A prefixed one aborts the insert with 23514.
  expect(new Set(deliveries.map((row) => row.kind))).toEqual(new Set(['invitation']))
  expect(deliveries.every((row) => row.invitation_id === invitation.invitationId)).toBe(true)

  // Exactly one recipient identifier per row — `calendar_notification_deliveries_recipient_check`
  // enforces it, and it is what separates the organizer (a user) from the candidate (an address).
  const organizer = deliveries.find((row) => row.recipient_user_id !== null)
  const candidate = deliveries.find((row) => row.external_recipient_hash !== null)
  expect(organizer, 'the organizer is recorded as a user').toBeTruthy()
  expect(candidate?.external_recipient_hash, 'the candidate is recorded by address').toBe(invitation.candidateEmail)
  expect(candidate?.recipient_user_id).toBeNull()

  // The event version is in the key, which is what makes a reschedule a new notice instead of a
  // duplicate. Read the real version rather than assuming 1.
  const [event] = await harness.sql<{ version: number }[]>`select version from calendar_events where id = ${eventId}`
  expect(candidate?.idempotency_key).toBe(`scheduling:${invitation.invitationId}:invitation:${eventId}:${event.version}:candidate`)
  expect(organizer?.idempotency_key).toBe(`scheduling:${invitation.invitationId}:invitation:${eventId}:${event.version}:organizer`)

  // Re-POSTing the same idempotency key returns the same booking, and must not notify again.
  const repeat = await context.post(`/api/public/scheduling/${invitation.invitationId}/book`, { data: bookBody })
  expect(repeat.status(), await repeat.text()).toBe(200)
  const [{ count }] = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from calendar_notification_deliveries where event_id = ${eventId}
  `
  expect(count, 'a repeated booking adds no delivery rows').toBe(2)
})

test('the same idempotency key books once; a different key on a taken slot loses', async () => {
  const invitation = await createInvitation(harness)
  const sent = await sendInvitation(harness, invitation.invitationId)
  const context = await candidateContext(harness, invitation.invitationId, sent.secret)

  const slots = await readSlots(context, invitation.invitationId)
  const submission = await submitCandidate(context, invitation.invitationId)
  const chosen = slots[0]
  const body = {
    slotId: chosen.slotId,
    slotStartsAt: chosen.startsAt,
    submissionVersion: submission.submissionVersion,
    consentReceiptIds: submission.consentReceipts.map((receipt) => receipt.id),
    idempotencyKey: `book-idem-${invitation.invitationId}`,
  }

  const first = await context.post(`/api/public/scheduling/${invitation.invitationId}/book`, { data: body })
  expect(first.status(), await first.text()).toBe(200)
  const firstEvent = (await first.json() as { eventId: string }).eventId

  // A replay of the *same* key is the same booking, not a second one — a double-tap on a
  // phone must not produce two interviews.
  const replay = await context.post(`/api/public/scheduling/${invitation.invitationId}/book`, { data: body })
  expect(replay.status(), await replay.text()).toBe(200)
  expect((await replay.json() as { eventId: string }).eventId).toBe(firstEvent)

  const [{ count }] = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from calendar_events
    where source_type = 'scheduling_invitation' and source_id = ${invitation.invitationId}
  `
  expect(count, 'one event, not two').toBe(1)
})

test('two candidates racing for one slot produce exactly one booking', async () => {
  // Two invitations against the same organizer, so both see the same availability and the
  // same slot. Without the advisory lock in the booking service, both would win and the
  // organizer would be double-booked at the same minute.
  const a = await createInvitation(harness, { roleTitle: 'E2E race A' })
  const b = await createInvitation(harness, { roleTitle: 'E2E race B' })
  const sentA = await sendInvitation(harness, a.invitationId)
  const sentB = await sendInvitation(harness, b.invitationId)
  const contextA = await candidateContext(harness, a.invitationId, sentA.secret)
  const contextB = await candidateContext(harness, b.invitationId, sentB.secret)

  const slotsA = await readSlots(contextA, a.invitationId)
  const slotsB = await readSlots(contextB, b.invitationId)
  // The last slot in the window, to avoid colliding with events other tests booked.
  const contested = slotsA.at(-1)!
  const contestedForB = slotsB.find((slot) => slot.startsAt === contested.startsAt)
  expect(contestedForB, 'both candidates see the same slot').toBeDefined()

  const submissionA = await submitCandidate(contextA, a.invitationId)
  const submissionB = await submitCandidate(contextB, b.invitationId)

  const [resultA, resultB] = await Promise.all([
    contextA.post(`/api/public/scheduling/${a.invitationId}/book`, {
      data: {
        slotId: contested.slotId,
        slotStartsAt: contested.startsAt,
        submissionVersion: submissionA.submissionVersion,
        consentReceiptIds: submissionA.consentReceipts.map((receipt) => receipt.id),
        idempotencyKey: `race-a-${a.invitationId}`,
      },
    }),
    contextB.post(`/api/public/scheduling/${b.invitationId}/book`, {
      data: {
        slotId: contestedForB!.slotId,
        slotStartsAt: contestedForB!.startsAt,
        submissionVersion: submissionB.submissionVersion,
        consentReceiptIds: submissionB.consentReceipts.map((receipt) => receipt.id),
        idempotencyKey: `race-b-${b.invitationId}`,
      },
    }),
  ])

  const statuses = [resultA.status(), resultB.status()].sort()
  expect(statuses.filter((status) => status === 200), 'exactly one winner').toHaveLength(1)
  const loser = resultA.status() === 200 ? resultB : resultA
  // 409, not 500: losing a race is an expected outcome the portal has to explain, and a 500
  // would send the candidate to a generic error page for a slot someone simply took first.
  expect(loser.status()).toBe(409)

  const [{ count }] = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from calendar_events
    where type = 'interview' and starts_at = ${contested.startsAt}::timestamptz
      and organization_id = ${harness.organization.organizationId}
  `
  expect(count, 'one interview at that instant').toBe(1)
})

test('booking without the required consent receipts is refused', async () => {
  const invitation = await createInvitation(harness)
  const sent = await sendInvitation(harness, invitation.invitationId)
  const context = await candidateContext(harness, invitation.invitationId, sent.secret)

  const slots = await readSlots(context, invitation.invitationId)
  // Terms declined. The submission itself is allowed to record a refusal — that is what a
  // consent ledger is for — but the booking must not proceed on it.
  const submission = await submitCandidate(context, invitation.invitationId, [
    { purpose: 'terms_and_privacy', decision: 'declined' },
    ...ALL_ACCEPTED.slice(1),
  ]).catch(() => null)

  if (!submission) {
    // The route may refuse the submission outright, which is also a correct answer. Either
    // way the invariant holds: no booking exists.
    const [{ count }] = await harness.sql<{ count: number }[]>`
      select count(*)::int as count from calendar_events
      where source_type = 'scheduling_invitation' and source_id = ${invitation.invitationId}
    `
    expect(count).toBe(0)
    return
  }

  const chosen = slots.at(-2)!
  const booking = await context.post(`/api/public/scheduling/${invitation.invitationId}/book`, {
    data: {
      slotId: chosen.slotId,
      slotStartsAt: chosen.startsAt,
      submissionVersion: submission.submissionVersion,
      consentReceiptIds: submission.consentReceipts.map((receipt) => receipt.id),
      idempotencyKey: `no-consent-${invitation.invitationId}`,
    },
  })
  expect(booking.status(), 'a declined term cannot be booked past').toBeGreaterThanOrEqual(400)

  const [{ count }] = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from calendar_events
    where source_type = 'scheduling_invitation' and source_id = ${invitation.invitationId}
  `
  expect(count, 'and nothing was created').toBe(0)
})

test('the candidate portal renders from the fragment and then forgets it', async ({ browser }) => {
  await trackBuilder(harness, 'portal')
  const invitation = await createInvitation(harness, { roleTitle: 'E2E portal role' })
  const sent = await sendInvitation(harness, invitation.invitationId)

  const context = await browser.newContext()
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  try {
    await gotoHydrated(page, sent.link)
    await dismissOverlays(page)

    await expect(page.getByText('E2E portal role').first()).toBeVisible({ timeout: 20_000 })

    // The page replaces its own history entry after the exchange, so the secret is not in
    // the URL a screenshot, a shared link, or a browser history export would carry.
    const url = page.url()
    expect(url, 'the fragment is gone from the address bar').not.toContain(sent.secret)
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('a rate-limited candidate is throttled rather than served indefinitely', async () => {
  const invitation = await createInvitation(harness)
  const sent = await sendInvitation(harness, invitation.invitationId)
  // A fixed address, so every request below shares one bucket. The other tests deliberately
  // get their own — see `candidateContext`.
  const context = await candidateContext(harness, invitation.invitationId, sent.secret, { clientIp: '10.99.99.99' })
  const query = new URLSearchParams({ ...SLOT_RANGE, timezone: 'Europe/Copenhagen' })

  // Sequential, not parallel: a burst can be absorbed by a token bucket and prove nothing.
  // The read budget in `public-route-support.ts` is 120 per 60 seconds, so the loop has to
  // exceed it — the first version stopped at 40 and reported "no rate limit" about a limiter
  // that was working exactly as configured.
  const statuses: number[] = []
  for (let i = 0; i < 135; i++) {
    const response = await context.get(`/api/public/scheduling/${invitation.invitationId}/slots?${query}`)
    statuses.push(response.status())
    if (response.status() === 429) break
  }
  // Redis-backed in E2E mode — the in-memory fallback is refused outright — so this is the real
  // limiter and not a per-process counter that would reset on reload.
  expect(statuses, `no 429 in ${statuses.length} sequential slot reads (read budget is 120/60s)`).toContain(429)
})
