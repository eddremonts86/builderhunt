/**
 * Journey 6's second half: a candidate moves an interview that is already confirmed.
 *
 * `scheduling.spec.ts` covers the first booking — the capability, the consent set, the race, the
 * idempotency key. None of it covers the move, and the word "reschedule" appeared in no e2e spec while
 * the feature was marked complete (plans/UI/tasks.md, Wave 3 task 8). This file is that gap.
 *
 * ## Why the assertions are mostly about what did *not* change
 *
 * `rescheduleBooking` releases the old appointment before it recomputes availability, deliberately: the
 * organizer's own outgoing slot must not block the candidate from picking a time that overlaps it,
 * including the same time. That release is the dangerous part. If the new slot then turns out to be
 * unavailable, a candidate who had a perfectly good appointment must not be left with a released one —
 * so the service throws instead of returning, the transaction rolls back, and the original row is
 * untouched. The only way to observe that is to force the failure and then read the original event's
 * status and `busy` flag straight out of Postgres, which is what the middle test does.
 *
 * ## Why this is API-level
 *
 * Atomicity is a property of one transaction under an advisory lock. A browser can show that the portal
 * offers the move and that the confirmation reads back the new time, and `scheduling.spec.ts` already
 * drives the portal; it cannot show that a rolled-back release left the row as it was. The rollback is
 * the thing that was untested, so it is the thing this file tests.
 */
import { expect, test } from 'playwright/test'

import { publicSlotRange } from './harness/clock'
import { uniqueId } from './harness/ids'
import {
  candidateContext,
  createInvitation,
  sendInvitation,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from './harness/fixtures/interviews'

let harness: InterviewHarness

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'resched',
    flags: { SCHEDULING_ENABLED: 'true', CANDIDATE_UPLOADS_ENABLED: 'false' },
  })

  // Without an availability policy every slots query answers with an empty list, and every assertion
  // below would fail for that reason rather than a real one.
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
        // Zero notice: the fixed clock sits inside the window these tests book in, and a two-hour
        // notice would filter out the very slots they ask for.
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
type CandidateContext = Awaited<ReturnType<typeof candidateContext>>

const ALL_ACCEPTED = [
  'terms_and_privacy',
  'candidate_document_processing',
  'public_web_import',
  'ai_interview_assistance',
  'live_audio_transcription',
].map((purpose) => ({ purpose, decision: 'accepted' as const }))

async function readSlots(context: CandidateContext, invitationId: string): Promise<Slot[]> {
  const response = await context.get(
    `/api/public/scheduling/${invitationId}/slots?${new URLSearchParams({ ...SLOT_RANGE, timezone: 'Europe/Copenhagen' })}`,
  )
  expect(response.status(), await response.text()).toBe(200)
  const { slots } = await response.json() as { slots: Slot[] }
  return slots
}

interface Booked {
  context: CandidateContext
  invitationId: string
  eventId: string
  slots: Slot[]
  chosen: Slot
  receiptIds: string[]
  submissionVersion: number
}

/** A confirmed interview — the state every test here starts from rather than the one they assert. */
async function bookOne(roleTitle: string): Promise<Booked> {
  const invitation = await createInvitation(harness, { roleTitle })
  const sent = await sendInvitation(harness, invitation.invitationId)
  const context = await candidateContext(harness, invitation.invitationId, sent.secret)

  const slots = await readSlots(context, invitation.invitationId)
  expect(slots.length, 'the availability policy produces slots').toBeGreaterThan(1)

  const submitted = await context.put(`/api/public/scheduling/${invitation.invitationId}/submission`, {
    data: {
      displayName: 'E2E Candidate',
      email: `cand-${uniqueId('c').slice(-8)}@test.invalid`,
      links: [],
      consentDecisions: ALL_ACCEPTED,
    },
  })
  expect(submitted.status(), await submitted.text()).toBe(200)
  const submission = await submitted.json() as {
    submissionVersion: number
    consentReceipts: Array<{ id: string; purpose: string }>
  }
  const receiptIds = submission.consentReceipts.map((receipt) => receipt.id)

  const chosen = slots[0]
  const booking = await context.post(`/api/public/scheduling/${invitation.invitationId}/book`, {
    data: {
      slotId: chosen.slotId,
      slotStartsAt: chosen.startsAt,
      submissionVersion: submission.submissionVersion,
      consentReceiptIds: receiptIds,
      idempotencyKey: `book-${invitation.invitationId}`,
    },
  })
  expect(booking.status(), await booking.text()).toBe(200)
  const { eventId } = await booking.json() as { eventId: string }

  return {
    context,
    invitationId: invitation.invitationId,
    eventId,
    slots,
    chosen,
    receiptIds,
    submissionVersion: submission.submissionVersion,
  }
}

interface EventRow { id: string; status: string; busy: boolean; starts_at: Date }

async function readEvent(eventId: string): Promise<EventRow | undefined> {
  const [row] = await harness.sql<EventRow[]>`
    select id, status, busy, starts_at from calendar_events where id = ${eventId}
  `
  return row
}

async function readInvitation(invitationId: string) {
  const [row] = await harness.sql<{ status: string; booked_event_id: string | null; reschedule_count: number }[]>`
    select status, booked_event_id, reschedule_count
    from scheduling_invitations where id = ${invitationId}
  `
  return row
}

test('a booked invitation still offers times, or the move has nowhere to go', async () => {
  /**
   * The defect this file found. `/slots` short-circuited to an empty list for any invitation in
   * `booked`, on the reasoning that a booked candidate's next action is cancel or reschedule rather
   * than pick — but `CandidatePortal.startReschedule()` fills its new-time picker from this exact
   * endpoint. The result was an empty picker with no error, and a reschedule endpoint no candidate
   * could reach. Everything else in this file passes through the API, so this is the one assertion
   * standing in for the UI's dependency on it.
   */
  const booked = await bookOne('E2E reschedule picker')
  const offered = await readSlots(booked.context, booked.invitationId)
  expect(offered.length, 'the reschedule picker has times to show').toBeGreaterThan(0)
  expect(
    offered.some((slot) => slot.startsAt === booked.chosen.startsAt),
    'the time the candidate already holds is not offered as somewhere else to go',
  ).toBe(false)
})

test('a confirmed interview moves to a new time, and the old appointment stops holding one', async () => {
  const booked = await bookOne('E2E reschedule move')

  // Read availability again rather than reusing the first list: the booking removed the taken slot,
  // and picking from a stale list would be picking a time the server has already ruled out.
  const after = await readSlots(booked.context, booked.invitationId)
  const target = after.find((slot) => slot.startsAt !== booked.chosen.startsAt)
  expect(target, 'a second free slot to move to').toBeTruthy()

  const moved = await booked.context.post(`/api/public/scheduling/${booked.invitationId}/reschedule`, {
    data: {
      slotId: target!.slotId,
      slotStartsAt: target!.startsAt,
      submissionVersion: booked.submissionVersion,
      consentReceiptIds: booked.receiptIds,
      idempotencyKey: `reschedule-${booked.invitationId}`,
    },
  })
  expect(moved.status(), await moved.text()).toBe(200)
  const result = await moved.json() as { eventId: string; startsAt: string }
  expect(result.startsAt).toBe(target!.startsAt)
  expect(result.eventId, 'the move creates a replacement event, it does not edit in place')
    .not.toBe(booked.eventId)

  const replacement = await readEvent(result.eventId)
  expect(replacement?.status).toBe('confirmed')
  expect(replacement?.busy).toBe(true)
  expect(replacement?.starts_at.toISOString()).toBe(target!.startsAt)

  // The old row survives as history — an interview that moved is not an interview that never
  // happened — but it must stop occupying the organizer's calendar.
  const original = await readEvent(booked.eventId)
  expect(original?.status).toBe('rescheduled')
  expect(original?.busy, 'a released appointment must not keep blocking the organizer').toBe(false)

  const invitation = await readInvitation(booked.invitationId)
  expect(invitation?.status).toBe('booked')
  expect(invitation?.booked_event_id).toBe(result.eventId)
  expect(invitation?.reschedule_count).toBe(1)

  // Exactly one live appointment for this invitation. The bug this guards against is a move that
  // leaves both events confirmed and double-books the organizer against themselves.
  const live = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from calendar_events
    where source_type = 'scheduling_invitation'
      and source_id = ${booked.invitationId}
      and status = 'confirmed'
  `
  expect(live[0]?.count).toBe('1')
})

/**
 * The delivery ledger across a move and a cancellation.
 *
 * Two things only a real move can prove, both found by writing this:
 *
 * 1. **A reschedule creates a replacement event**, so the notice must be keyed on the event id and not
 *    only its version — a version-only key repeats across successive moves of one invitation and the
 *    second candidate is never told.
 * 2. **A cancellation must carry `kind = 'cancellation'`**, which is what makes the outbound ICS a
 *    CANCEL and removes the entry from both calendars rather than leaving it there forever.
 */
async function deliveriesFor(invitationId: string) {
  return harness.sql<{ kind: string; state: string; idempotency_key: string; event_id: string; error_code: string | null }[]>`
    select kind, state, idempotency_key, event_id, error_code
    from calendar_notification_deliveries
    where invitation_id = ${invitationId} order by created_at, idempotency_key
  `
}

test('each move notifies both parties again, keyed on the replacement appointment', async () => {
  const booked = await bookOne('E2E reschedule notices')

  const bookingNotices = await deliveriesFor(booked.invitationId)
  expect(bookingNotices.length, 'the booking itself notified both parties').toBe(2)

  async function moveTo(index: number, key: string) {
    const available = await readSlots(booked.context, booked.invitationId)
    const target = available.find((slot) => slot.startsAt !== booked.chosen.startsAt)
    expect(target, `a free slot for move ${index}`).toBeTruthy()
    const response = await booked.context.post(`/api/public/scheduling/${booked.invitationId}/reschedule`, {
      data: {
        slotId: target!.slotId,
        slotStartsAt: target!.startsAt,
        submissionVersion: booked.submissionVersion,
        consentReceiptIds: booked.receiptIds,
        idempotencyKey: key,
      },
    })
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { eventId: string }).eventId
  }

  const firstMoveEvent = await moveTo(1, `reschedule-1-${booked.invitationId}`)

  const afterFirst = (await deliveriesFor(booked.invitationId)).filter((row) => row.kind === 'reschedule')
  expect(afterFirst.length, 'the move notified both parties').toBe(2)
  expect(afterFirst.map((row) => row.state)).toEqual(['sent', 'sent'])
  expect(afterFirst.map((row) => row.error_code)).toEqual([null, null])
  // Keyed on the replacement event, which is the whole point: the move did not edit the original.
  expect(afterFirst.every((row) => row.event_id === firstMoveEvent)).toBe(true)
  expect(afterFirst.every((row) => row.idempotency_key.includes(firstMoveEvent))).toBe(true)
  expect(firstMoveEvent).not.toBe(booked.eventId)
})

test('a cancellation is recorded as a cancellation, which is what sends a CANCEL', async () => {
  const booked = await bookOne('E2E cancellation notice')

  const cancelled = await booked.context.post(`/api/public/scheduling/${booked.invitationId}/cancel`, { data: {} })
  expect(cancelled.status(), await cancelled.text()).toBe(200)

  const notices = (await deliveriesFor(booked.invitationId)).filter((row) => row.kind === 'cancellation')
  expect(notices.length, 'both parties are told the interview is off').toBe(2)
  expect(notices.map((row) => row.state)).toEqual(['sent', 'sent'])
  expect(notices.every((row) => row.idempotency_key.includes(':cancellation:'))).toBe(true)
})

test('a move onto a time that is gone is refused, and the original appointment survives it', async () => {
  const booked = await bookOne('E2E reschedule conflict')

  /**
   * A slot id the server will not recognise when it recomputes.
   *
   * This is the honest shape of the failure: slot ids are derived from the availability computation,
   * so a candidate holding a stale page — or two tabs, or a retry after the organizer narrowed their
   * hours — sends one that no longer exists. The service has already released the old appointment by
   * the time it finds out, which is precisely the state this test exists to check.
   */
  const stale = await booked.context.post(`/api/public/scheduling/${booked.invitationId}/reschedule`, {
    data: {
      slotId: `${booked.chosen.slotId}-gone`,
      slotStartsAt: booked.slots[1].startsAt,
      submissionVersion: booked.submissionVersion,
      consentReceiptIds: booked.receiptIds,
      idempotencyKey: `reschedule-stale-${booked.invitationId}`,
    },
  })
  expect(stale.status(), await stale.text()).toBe(409)
  const body = await stale.json() as { error: string; alternatives?: Array<{ slotId: string }> }
  expect(body.error).toBe('slot_unavailable')
  expect(body.alternatives?.length, 'a refusal offers somewhere else to go').toBeGreaterThan(0)

  // The rollback. Without it the candidate is left holding a released appointment and no new one.
  const original = await readEvent(booked.eventId)
  expect(original?.status, 'the failed move rolled back the release').toBe('confirmed')
  expect(original?.busy).toBe(true)
  expect(original?.starts_at.toISOString()).toBe(booked.chosen.startsAt)

  const invitation = await readInvitation(booked.invitationId)
  expect(invitation?.status).toBe('booked')
  expect(invitation?.booked_event_id).toBe(booked.eventId)
  expect(invitation?.reschedule_count, 'a refused move is not a move').toBe(0)
})

test('a move that drops a required consent is refused, and changes nothing', async () => {
  const booked = await bookOne('E2E reschedule consent')

  const after = await readSlots(booked.context, booked.invitationId)
  const target = after.find((slot) => slot.startsAt !== booked.chosen.startsAt)!

  // Consent is re-verified on every move rather than inherited from the first booking, so a request
  // that presents fewer receipts than the purposes require is refused — the same answer a first
  // booking would get.
  const refused = await booked.context.post(`/api/public/scheduling/${booked.invitationId}/reschedule`, {
    data: {
      slotId: target.slotId,
      slotStartsAt: target.startsAt,
      submissionVersion: booked.submissionVersion,
      consentReceiptIds: booked.receiptIds.slice(0, 1),
      idempotencyKey: `reschedule-consent-${booked.invitationId}`,
    },
  })
  expect(refused.status(), await refused.text()).toBe(422)
  const body = await refused.json() as { error: string; missingPurposes?: string[] }
  expect(body.error).toBe('consent_required')
  expect(body.missingPurposes?.length, 'the refusal names what is missing').toBeGreaterThan(0)

  const original = await readEvent(booked.eventId)
  expect(original?.status).toBe('confirmed')
  expect(original?.busy).toBe(true)

  const invitation = await readInvitation(booked.invitationId)
  expect(invitation?.booked_event_id).toBe(booked.eventId)
  expect(invitation?.reschedule_count).toBe(0)
})

test("another invitation's capability cannot move this booking", async () => {
  // The move is the highest-value write a stranger can reach, so the capability boundary gets the
  // same assertion the read path does in `scheduling.spec.ts`.
  const mine = await bookOne('E2E reschedule mine')
  const neighbour = await createInvitation(harness, { roleTitle: 'E2E reschedule neighbour' })
  const sent = await sendInvitation(harness, neighbour.invitationId)
  const theirs = await candidateContext(harness, neighbour.invitationId, sent.secret)

  const after = await readSlots(mine.context, mine.invitationId)
  const target = after.find((slot) => slot.startsAt !== mine.chosen.startsAt)!

  const crossed = await theirs.post(`/api/public/scheduling/${mine.invitationId}/reschedule`, {
    data: {
      slotId: target.slotId,
      slotStartsAt: target.startsAt,
      submissionVersion: mine.submissionVersion,
      consentReceiptIds: mine.receiptIds,
      idempotencyKey: `reschedule-crossed-${mine.invitationId}`,
    },
  })
  expect(crossed.status(), 'a capability must not cross to another invitation').toBe(404)

  const invitation = await readInvitation(mine.invitationId)
  expect(invitation?.booked_event_id).toBe(mine.eventId)
  expect(invitation?.reschedule_count).toBe(0)
})
