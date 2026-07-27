import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations } from '~/shared/lib/db/schema'
import {
  findEventById,
  insertCalendar,
  listEventsInRange,
  listParticipants,
  listRemindersForEvent,
} from '~/shared/lib/repositories/calendar'
import {
  findInvitationForOwner,
  insertInvitation,
  replaceAvailabilityPolicy,
  updateInvitationStateWithVersion,
  upsertAvailabilityPolicyWithVersion,
  upsertSubmission,
} from '~/shared/lib/repositories/scheduling'
import { bookSlot, cancelBooking, rescheduleBooking } from '~/lib/scheduling/booking-service'
import { hashCapability } from '~/lib/scheduling/capability'
import { recordDecisions } from '~/lib/scheduling/consent-service'
import { querySlots } from '~/lib/scheduling/slot-service'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'booking-org'
const OWNER = 'booking-owner'
const NOTICE = '2026-07-01'
const REQUIRED = ['terms_and_privacy', 'live_audio_transcription'] as const

/** A Monday well clear of any DST boundary in Europe/Copenhagen. */
const MONDAY = new Date(Date.UTC(2027, 5, 7, 0, 0, 0))
const NOW = new Date(MONDAY.getTime() - 24 * 60 * 60_000)

let invitationCounter = 0

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('scheduling_booking_service')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values({ id: ORG, name: 'Booking', slug: 'booking-org' })
  await db.insert(authUsers).values({
    id: OWNER, name: 'Owner', email: 'booking-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
  await db.transaction((tx) => insertCalendar(tx, {
    organizationId: ORG, ownerUserId: OWNER, name: 'Cal', timezone: 'Europe/Copenhagen', isDefault: true,
  }))

  await db.transaction((tx) => upsertAvailabilityPolicyWithVersion(tx, ORG, OWNER, 1, {
    defaultReminderOffsets: [60],
    defaultReminderChannels: ['email'],
  }))
  await db.transaction((tx) => replaceAvailabilityPolicy(tx, ORG, OWNER, {
    rules: [{
      timezone: 'Europe/Copenhagen',
      weekdays: [1, 2, 3, 4, 5],
      localStart: '09:00',
      localEnd: '17:00',
      slotMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      horizonDays: 60,
      enabled: true,
    }],
    overrides: [],
  }))
}, 60_000)

afterAll(async () => {
  await drop()
})

/** A `sent` invitation with candidate details and every required purpose accepted — the state a real booking starts from. */
async function readyInvitation(overrides: { requiredAccepted?: readonly string[] } = {}) {
  invitationCounter += 1
  const invitation = await db.transaction((tx) => insertInvitation(tx, {
    organizationId: ORG,
    ownerUserId: OWNER,
    roleTitle: 'Staff Engineer',
    roleContext: 'Platform team',
    durationMinutes: 30,
    timezone: 'Europe/Copenhagen',
    modality: 'remote_call',
    meetingUrl: 'https://meet.test.invalid/room',
    capabilityHash: hashCapability(`booking-secret-${invitationCounter}`),
    policyVersion: 'v1',
  }))

  // draft -> sent -> opened. The shared state machine only allows `booked` from `opened`, which is
  // the real flow: the candidate follows the link, which marks it opened, and books from there. The
  // fixture walks the same path rather than forcing the end state.
  const sent = await db.transaction((tx) => updateInvitationStateWithVersion(
    tx, ORG, OWNER, invitation.id, invitation.version, { status: 'sent' },
  ))
  if (!sent) throw new Error('fixture could not send the invitation')
  const opened = await db.transaction((tx) => updateInvitationStateWithVersion(
    tx, ORG, OWNER, invitation.id, sent.version, { status: 'opened', openedAt: NOW },
  ))
  if (!opened) throw new Error('fixture could not open the invitation')

  await db.transaction((tx) => upsertSubmission(tx, {
    organizationId: ORG,
    invitationId: invitation.id,
    displayName: 'Casey Candidate',
    emailNormalized: `candidate-${invitationCounter}@test.invalid`,
    retentionExpiresAt: new Date(Date.UTC(2028, 0, 1)),
  }))

  const purposes = overrides.requiredAccepted ?? REQUIRED
  const receipts = purposes.length === 0 ? [] : await db.transaction(async (tx) => {
    const result = await recordDecisions(tx, {
      organizationId: ORG,
      invitationId: invitation.id,
      subjectEmail: `candidate-${invitationCounter}@test.invalid`,
      noticeVersion: NOTICE,
      decisions: purposes.map((purpose) => ({ purpose: purpose as 'terms_and_privacy', decision: 'accepted' as const })),
      requestFingerprint: 'test',
    })
    if (!result.ok) throw new Error(result.reason)
    return result.receipts
  })

  return { invitation: opened, consentReceiptIds: receipts.map((receipt) => receipt.id) }
}

async function firstSlot() {
  const result = await db.transaction((tx) => querySlots(tx, {
    organizationId: ORG,
    ownerUserId: OWNER,
    durationMinutes: 30,
    from: MONDAY,
    to: new Date(MONDAY.getTime() + 24 * 60 * 60_000),
    now: NOW,
  }))
  const slot = result.slots[0]
  if (!slot) throw new Error('fixture produced no slots')
  return slot
}

function bookInput(
  invitationId: string,
  consentReceiptIds: readonly string[],
  slot: { slotId: string; startsAt: Date },
) {
  return {
    organizationId: ORG,
    ownerUserId: OWNER,
    invitationId,
    slotId: slot.slotId,
    consentReceiptIds,
    requiredPurposes: REQUIRED,
    noticeVersion: NOTICE,
    slotStartsAtHint: slot.startsAt,
    now: NOW,
  }
}

describe('atomic booking', () => {
  it('creates the event, both participants, and marks the invitation booked in one transaction', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slot = await firstSlot()

    const result = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, slot)))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.startsAt.toISOString()).toBe(slot.startsAt.toISOString())
    expect(result.alreadyBooked).toBe(false)
    expect(result.candidate.displayName).toBe('Casey Candidate')

    const event = await db.transaction((tx) => findEventById(tx, ORG, result.eventId))
    expect(event?.type).toBe('interview')
    expect(event?.status).toBe('confirmed')
    // A confirmed interview must occupy the organizer's time, or a later booking would not see it.
    expect(event?.busy).toBe(true)
    expect(event?.sourceType).toBe('scheduling_invitation')
    expect(event?.sourceId).toBe(invitation.id)

    const participants = await db.transaction((tx) => listParticipants(tx, ORG, result.eventId))
    expect(participants).toHaveLength(2)
    const candidate = participants.find((p) => p.role === 'attendee')
    expect(candidate?.userId).toBeNull()
    // The candidate has no account; their reach is the capability, not a participant row.
    expect(candidate?.accessGranted).toBe(false)

    const refreshed = await db.transaction((tx) => findInvitationForOwner(tx, ORG, OWNER, invitation.id))
    expect(refreshed?.status).toBe('booked')
    expect(refreshed?.bookedEventId).toBe(result.eventId)
  })

  it('arms the organizer reminders from the policy defaults', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slot = await firstSlot()
    const result = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, slot)))
    if (!result.ok) throw new Error(result.reason)

    const reminders = await db.transaction((tx) => listRemindersForEvent(tx, ORG, result.eventId))
    expect(reminders).toHaveLength(1)
    expect(reminders[0]?.offsetMinutes).toBe(60)
    expect((reminders[0]?.nextFireAt as Date).toISOString())
      .toBe(new Date(slot.startsAt.getTime() - 60 * 60_000).toISOString())
  })

  it('refuses to book without every required consent, and names what is missing', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation({ requiredAccepted: ['terms_and_privacy'] })
    const slot = await firstSlot()

    const result = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, slot)))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('consent_required')
    expect(result.missingPurposes).toEqual(['live_audio_transcription'])
  })

  it('writes nothing when consent is incomplete', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation({ requiredAccepted: [] })
    const slot = await firstSlot()
    const before = await db.transaction((tx) => listEventsInRange(tx, ORG, OWNER, { from: MONDAY, to: new Date(MONDAY.getTime() + 86_400_000) }))

    await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, slot)))

    const after = await db.transaction((tx) => listEventsInRange(tx, ORG, OWNER, { from: MONDAY, to: new Date(MONDAY.getTime() + 86_400_000) }))
    expect(after).toHaveLength(before.length)
    const refreshed = await db.transaction((tx) => findInvitationForOwner(tx, ORG, OWNER, invitation.id))
    expect(refreshed?.status).toBe('opened')
  })

  it('rejects a slot id that no longer exists and offers refreshed alternatives', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slot = await firstSlot()

    const result = await db.transaction((tx) => bookSlot(tx, {
      ...bookInput(invitation.id, consentReceiptIds, slot),
      slotId: 'not-a-slot-we-issued',
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('slot_unavailable')
    // Losing must not dead-end the candidate on a page with no way forward.
    expect(result.alternatives?.length).toBeGreaterThan(0)
  })

  it('refuses to book a revoked invitation', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slot = await firstSlot()
    await db.transaction((tx) => updateInvitationStateWithVersion(tx, ORG, OWNER, invitation.id, invitation.version, {
      status: 'revoked', revokedAt: NOW,
    }))

    const result = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, slot)))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invitation_unavailable')
  })

  it('refuses to book an expired invitation', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slot = await firstSlot()
    await db.transaction((tx) => updateInvitationStateWithVersion(tx, ORG, OWNER, invitation.id, invitation.version, {
      expiresAt: new Date(NOW.getTime() - 60_000),
    }))

    const result = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, slot)))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invitation_unavailable')
  })

  it('refuses to book before the candidate has submitted their details', async () => {
    invitationCounter += 1
    const invitation = await db.transaction((tx) => insertInvitation(tx, {
      organizationId: ORG,
      ownerUserId: OWNER,
      roleTitle: 'Engineer',
      roleContext: 'Team',
      durationMinutes: 30,
      timezone: 'Europe/Copenhagen',
      modality: 'remote_call',
      capabilityHash: hashCapability(`booking-nosub-${invitationCounter}`),
      policyVersion: 'v1',
    }))
    const sent = await db.transaction((tx) => updateInvitationStateWithVersion(
      tx, ORG, OWNER, invitation.id, invitation.version, { status: 'sent' },
    ))
    await db.transaction((tx) => updateInvitationStateWithVersion(
      tx, ORG, OWNER, invitation.id, sent!.version, { status: 'opened', openedAt: NOW },
    ))
    const slot = await firstSlot()

    const result = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, [], slot)))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid_input')
  })

  it('treats a retry of the same slot as the same booking rather than a second one', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slot = await firstSlot()
    const input = bookInput(invitation.id, consentReceiptIds, slot)

    const first = await db.transaction((tx) => bookSlot(tx, input))
    const second = await db.transaction((tx) => bookSlot(tx, input))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.eventId).toBe(first.eventId)
    // The caller uses this to avoid sending a second confirmation email.
    expect(second.alreadyBooked).toBe(true)
  })

  it('tells a candidate whose invitation was booked for a different time that the slot is gone', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slots = await db.transaction((tx) => querySlots(tx, {
      organizationId: ORG, ownerUserId: OWNER, durationMinutes: 30,
      from: MONDAY, to: new Date(MONDAY.getTime() + 86_400_000), now: NOW,
    }))
    const [taken, other] = slots.slots
    if (!taken || !other) throw new Error('fixture produced too few slots')

    const booked = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, taken)))
    expect(booked.ok).toBe(true)

    const late = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, other)))
    expect(late.ok).toBe(false)
    if (late.ok) return
    expect(late.code).toBe('slot_unavailable')
  })

  it('a confirmed booking removes its own time from the slots offered to the next candidate', async () => {
    const first = await readyInvitation()
    const slot = await firstSlot()
    const booked = await db.transaction((tx) => bookSlot(tx, bookInput(first.invitation.id, first.consentReceiptIds, slot)))
    expect(booked.ok).toBe(true)

    const after = await db.transaction((tx) => querySlots(tx, {
      organizationId: ORG, ownerUserId: OWNER, durationMinutes: 30,
      from: MONDAY, to: new Date(MONDAY.getTime() + 86_400_000), now: NOW,
    }))
    expect(after.slots.map((s) => s.slotId)).not.toContain(slot.slotId)
  })
})

describe('the race', () => {
  it('two candidates booking the same slot concurrently produce exactly one confirmed event', async () => {
    // The whole point of the advisory lock, proven against real Postgres rather than reasoned about.
    // Two separate invitations, so neither is blocked by the other's invitation state -- the only
    // thing that can stop the loser is the recomputation seeing the winner's event.
    const a = await readyInvitation()
    const b = await readyInvitation()
    const slot = await firstSlot()

    const [resultA, resultB] = await Promise.all([
      db.transaction((tx) => bookSlot(tx, bookInput(a.invitation.id, a.consentReceiptIds, slot))),
      db.transaction((tx) => bookSlot(tx, bookInput(b.invitation.id, b.consentReceiptIds, slot))),
    ])

    const winners = [resultA, resultB].filter((result) => result.ok)
    const losers = [resultA, resultB].filter((result) => !result.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0] && !losers[0].ok && losers[0].code).toBe('slot_unavailable')

    // And the database agrees: one confirmed interview starting at that instant, not two. Matched on
    // the exact start rather than by range overlap, because `listEventsInRange` treats an event that
    // ends exactly when this one begins as overlapping, and an earlier test's adjacent booking would
    // otherwise be counted here.
    const events = await db.transaction((tx) => listEventsInRange(
      tx, ORG, OWNER, { from: slot.startsAt, to: new Date(slot.startsAt.getTime() + 60_000) },
    ))
    const confirmed = events.filter((event) =>
      event.status === 'confirmed'
      && event.type === 'interview'
      && (event.startsAt as Date).getTime() === slot.startsAt.getTime())
    expect(confirmed).toHaveLength(1)
  })
})

describe('cancellation', () => {
  it('cancels the appointment and its reminders while preserving the booking history', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slot = await firstSlot()
    const booked = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, slot)))
    if (!booked.ok) throw new Error(booked.reason)

    const cancelled = await db.transaction((tx) => cancelBooking(tx, {
      organizationId: ORG, ownerUserId: OWNER, invitationId: invitation.id, now: NOW,
    }))
    expect(cancelled.ok).toBe(true)

    const event = await db.transaction((tx) => findEventById(tx, ORG, booked.eventId))
    // Not deleted: the interview happened on the calendar and then was called off.
    expect(event?.status).toBe('cancelled')
    expect(event?.busy).toBe(false)

    const reminders = await db.transaction((tx) => listRemindersForEvent(tx, ORG, booked.eventId))
    expect(reminders.every((reminder) => reminder.state === 'cancelled')).toBe(true)

    // The invitation was booked, and that stays true. There is no `cancelled` invitation status and
    // inventing one would rewrite what happened.
    const refreshed = await db.transaction((tx) => findInvitationForOwner(tx, ORG, OWNER, invitation.id))
    expect(refreshed?.status).toBe('booked')
    expect(refreshed?.bookedEventId).toBe(booked.eventId)
  })

  it('cancelling twice is not an error', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slot = await firstSlot()
    const booked = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, slot)))
    expect(booked.ok).toBe(true)

    const args = { organizationId: ORG, ownerUserId: OWNER, invitationId: invitation.id, now: NOW }
    expect((await db.transaction((tx) => cancelBooking(tx, args))).ok).toBe(true)
    expect((await db.transaction((tx) => cancelBooking(tx, args))).ok).toBe(true)
  })

  it('refuses to cancel an invitation that was never booked', async () => {
    const { invitation } = await readyInvitation()
    const result = await db.transaction((tx) => cancelBooking(tx, {
      organizationId: ORG, ownerUserId: OWNER, invitationId: invitation.id, now: NOW,
    }))
    expect(result.ok).toBe(false)
  })

  it('a cancelled slot becomes bookable again', async () => {
    const first = await readyInvitation()
    const slot = await firstSlot()
    const booked = await db.transaction((tx) => bookSlot(tx, bookInput(first.invitation.id, first.consentReceiptIds, slot)))
    expect(booked.ok).toBe(true)
    await db.transaction((tx) => cancelBooking(tx, {
      organizationId: ORG, ownerUserId: OWNER, invitationId: first.invitation.id, now: NOW,
    }))

    const after = await db.transaction((tx) => querySlots(tx, {
      organizationId: ORG, ownerUserId: OWNER, durationMinutes: 30,
      from: MONDAY, to: new Date(MONDAY.getTime() + 86_400_000), now: NOW,
    }))
    expect(after.slots.map((s) => s.slotId)).toContain(slot.slotId)
  })
})

describe('rescheduling', () => {
  it('creates a linked replacement, retires the old event, and never leaves the invitation without one', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slots = await db.transaction((tx) => querySlots(tx, {
      organizationId: ORG, ownerUserId: OWNER, durationMinutes: 30,
      from: MONDAY, to: new Date(MONDAY.getTime() + 86_400_000), now: NOW,
    }))
    const [original, moved] = slots.slots
    if (!original || !moved) throw new Error('fixture produced too few slots')

    const booked = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, original)))
    if (!booked.ok) throw new Error(booked.reason)

    const result = await db.transaction((tx) => rescheduleBooking(tx, bookInput(invitation.id, consentReceiptIds, moved)))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eventId).not.toBe(booked.eventId)
    expect(result.startsAt.toISOString()).toBe(moved.startsAt.toISOString())

    const old = await db.transaction((tx) => findEventById(tx, ORG, booked.eventId))
    expect(old?.status).toBe('rescheduled')
    expect(old?.busy).toBe(false)

    const refreshed = await db.transaction((tx) => findInvitationForOwner(tx, ORG, OWNER, invitation.id))
    expect(refreshed?.bookedEventId).toBe(result.eventId)
    expect(refreshed?.rescheduleCount).toBe(1)
    // Still booked throughout: there is no instant at which this invitation has no appointment.
    expect(refreshed?.status).toBe('booked')
  })

  it('cancels the old reminders and arms new ones', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slots = await db.transaction((tx) => querySlots(tx, {
      organizationId: ORG, ownerUserId: OWNER, durationMinutes: 30,
      from: MONDAY, to: new Date(MONDAY.getTime() + 86_400_000), now: NOW,
    }))
    const [original, moved] = slots.slots
    if (!original || !moved) throw new Error('fixture produced too few slots')

    const booked = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, original)))
    if (!booked.ok) throw new Error(booked.reason)
    const result = await db.transaction((tx) => rescheduleBooking(tx, bookInput(invitation.id, consentReceiptIds, moved)))
    if (!result.ok) throw new Error(result.reason)

    const oldReminders = await db.transaction((tx) => listRemindersForEvent(tx, ORG, booked.eventId))
    expect(oldReminders.every((reminder) => reminder.state === 'cancelled')).toBe(true)

    const newReminders = await db.transaction((tx) => listRemindersForEvent(tx, ORG, result.eventId))
    expect(newReminders).toHaveLength(1)
    expect((newReminders[0]?.nextFireAt as Date).toISOString())
      .toBe(new Date(moved.startsAt.getTime() - 60 * 60_000).toISOString())
  })

  it('re-verifies consent, so a purpose withdrawn after booking blocks the move', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slots = await db.transaction((tx) => querySlots(tx, {
      organizationId: ORG, ownerUserId: OWNER, durationMinutes: 30,
      from: MONDAY, to: new Date(MONDAY.getTime() + 86_400_000), now: NOW,
    }))
    const [original, moved] = slots.slots
    if (!original || !moved) throw new Error('fixture produced too few slots')

    const booked = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, original)))
    if (!booked.ok) throw new Error(booked.reason)

    const result = await db.transaction((tx) => rescheduleBooking(tx, {
      ...bookInput(invitation.id, consentReceiptIds, moved),
      // Same receipts, but the portal now renders a newer notice: those receipts consent to text the
      // candidate has not seen.
      noticeVersion: '2026-12-01',
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('consent_required')

    // And the original appointment is untouched.
    const old = await db.transaction((tx) => findEventById(tx, ORG, booked.eventId))
    expect(old?.status).toBe('confirmed')
  })

  it('rolls the release back when the new slot is gone, leaving the original appointment intact', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slot = await firstSlot()
    const booked = await db.transaction((tx) => bookSlot(tx, bookInput(invitation.id, consentReceiptIds, slot)))
    if (!booked.ok) throw new Error(booked.reason)

    await expect(db.transaction((tx) => rescheduleBooking(tx, {
      ...bookInput(invitation.id, consentReceiptIds, slot),
      slotId: 'a-slot-that-does-not-exist',
    }))).rejects.toThrow(/no longer available/)

    // A failed reschedule must not cost the candidate the appointment they already had.
    const old = await db.transaction((tx) => findEventById(tx, ORG, booked.eventId))
    expect(old?.status).toBe('confirmed')
    expect(old?.busy).toBe(true)
    const refreshed = await db.transaction((tx) => findInvitationForOwner(tx, ORG, OWNER, invitation.id))
    expect(refreshed?.bookedEventId).toBe(booked.eventId)
    expect(refreshed?.rescheduleCount).toBe(0)
  })

  it('refuses to reschedule an invitation that was never booked', async () => {
    const { invitation, consentReceiptIds } = await readyInvitation()
    const slot = await firstSlot()
    const result = await db.transaction((tx) => rescheduleBooking(tx, bookInput(invitation.id, consentReceiptIds, slot)))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invitation_unavailable')
  })
})
