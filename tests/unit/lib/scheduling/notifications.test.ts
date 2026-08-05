import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `notifyAppointmentChange` — the confirmation/reschedule/cancellation notices for the transitions a
 * candidate drives from the portal (plan: calendar-scheduling-interview-intelligence, Phase 5).
 *
 * **What these mocks do and do not prove**, stated because this repository has been bitten by the
 * difference: they exercise the logic this module owns — idempotency-key composition, ICS method
 * selection, recipient resolution, and the best-effort contract. They prove nothing about roles or
 * grants. `withWorkerOrganization` is mocked here, so a test passing does not mean the delivery ledger
 * is actually writable by the role the route runs under; that is what the worker-role transaction is for
 * structurally, and what an e2e through the real portal would confirm.
 *
 * The three assertions worth having are the ones a future edit is most likely to break:
 * the version in the key (drop it and a reschedule notice is silently suppressed as a duplicate), the
 * CANCEL method (get it wrong and the interview stays in both calendars forever), and the absence of any
 * capability secret (put one in and the "no resend" design leaks a link nobody can revoke).
 */

const insertDeliveryIfAbsent = vi.fn()
const findDeliveryByIdempotencyKey = vi.fn()
const markDeliveryOutcome = vi.fn()
const findSchedulingNotificationContext = vi.fn()
const findUserEmail = vi.fn()
const sendCalendarEventEmail = vi.fn()

vi.mock('~/shared/lib/repositories/calendar', () => ({
  insertDeliveryIfAbsent: (...args: unknown[]) => insertDeliveryIfAbsent(...args),
}))

vi.mock('~/shared/lib/repositories/calendar-worker', () => ({
  findDeliveryByIdempotencyKey: (...args: unknown[]) => findDeliveryByIdempotencyKey(...args),
  findSchedulingNotificationContext: (...args: unknown[]) => findSchedulingNotificationContext(...args),
  findUserEmail: (...args: unknown[]) => findUserEmail(...args),
  markDeliveryOutcome: (...args: unknown[]) => markDeliveryOutcome(...args),
  withWorkerOrganization: (_organizationId: string, operation: (tx: unknown) => Promise<unknown>) =>
    operation({} as unknown),
}))

vi.mock('~/shared/lib/email', () => ({
  sendCalendarEventEmail: (...args: unknown[]) => sendCalendarEventEmail(...args),
}))

const { notifyAppointmentChange } = await import('~/lib/scheduling/notifications')

const CONTEXT = {
  invitationId: 'inv-1',
  ownerUserId: 'owner-1',
  roleTitle: 'Senior Backend Engineer',
  candidateEmail: 'candidate@test.invalid',
  invitationTimezone: 'Europe/Copenhagen',
  eventId: '11111111-1111-4111-8111-111111111111',
  eventVersion: 3,
  eventTitle: 'Interview: Senior Backend Engineer',
  eventStatus: 'confirmed',
  startsAt: new Date('2027-03-01T10:00:00.000Z'),
  endsAt: new Date('2027-03-01T10:30:00.000Z'),
  timezone: 'Europe/Copenhagen',
  location: null,
  meetingUrl: 'https://meet.test.invalid/abc',
}

beforeEach(() => {
  vi.clearAllMocks()
  findSchedulingNotificationContext.mockResolvedValue(CONTEXT)
  findUserEmail.mockResolvedValue('organizer@test.invalid')
  insertDeliveryIfAbsent.mockImplementation(async () => ({ id: `delivery-${insertDeliveryIfAbsent.mock.calls.length}` }))
  sendCalendarEventEmail.mockResolvedValue({ ok: true, id: 'provider-1' })
})

describe('notifyAppointmentChange', () => {
  it('notifies both the candidate and the organizer', async () => {
    const result = await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'invitation' })

    expect(result.outcomes).toEqual([
      { role: 'candidate', state: 'sent' },
      { role: 'organizer', state: 'sent' },
    ])
    expect(sendCalendarEventEmail.mock.calls.map((call) => call[0])).toEqual([
      'candidate@test.invalid',
      'organizer@test.invalid',
    ])
  })

  it('writes a kind the ledger CHECK accepts, not a prefixed one', async () => {
    // Regression. This module first wrote `scheduling_invitation`, which
    // `calendar_notification_deliveries_kind_check` rejects (`reminder|invitation|reschedule|cancellation`),
    // so every insert failed 23514, the module's own catch swallowed it, and nobody was ever notified while
    // bookings kept succeeding. A mocked repository cannot fail a CHECK — hence this asserts the value.
    for (const kind of ['invitation', 'reschedule', 'cancellation'] as const) {
      vi.clearAllMocks()
      findSchedulingNotificationContext.mockResolvedValue(CONTEXT)
      findUserEmail.mockResolvedValue('organizer@test.invalid')
      insertDeliveryIfAbsent.mockResolvedValue({ id: 'delivery-x' })
      sendCalendarEventEmail.mockResolvedValue({ ok: true })

      await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind })

      for (const call of insertDeliveryIfAbsent.mock.calls) {
        const row = call[1] as { kind: string; invitationId: string | null }
        expect(['reminder', 'invitation', 'reschedule', 'cancellation']).toContain(row.kind)
        expect(row.kind).toBe(kind)
        // The invitation id travels too: the column existed unwritten and it is the join an
        // organizer's "was this candidate told?" view needs.
        expect(row.invitationId).toBe('inv-1')
      }
    }
  })

  it('keys idempotency on the appointment, so a retry is suppressed and a replacement is not', async () => {
    await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'reschedule' })

    const keys = insertDeliveryIfAbsent.mock.calls.map((call) => (call[1] as { idempotencyKey: string }).idempotencyKey)
    expect(keys).toEqual([
      `scheduling:inv-1:reschedule:${CONTEXT.eventId}:3:candidate`,
      `scheduling:inv-1:reschedule:${CONTEXT.eventId}:3:organizer`,
    ])
  })

  it('gives a replacement appointment its own key, so a second reschedule still notifies', async () => {
    // The regression this pins: a reschedule creates a *replacement* event whose `version` starts at 1,
    // so a key built from the version alone repeats across successive reschedules of one invitation and
    // the second candidate is never told their interview moved.
    await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'reschedule' })
    const first = (insertDeliveryIfAbsent.mock.calls[0][1] as { idempotencyKey: string }).idempotencyKey

    vi.clearAllMocks()
    findSchedulingNotificationContext.mockResolvedValue({
      ...CONTEXT,
      eventId: '22222222-2222-4222-8222-222222222222',
      eventVersion: 1,
    })
    findUserEmail.mockResolvedValue('organizer@test.invalid')
    insertDeliveryIfAbsent.mockResolvedValue({ id: 'delivery-y' })
    sendCalendarEventEmail.mockResolvedValue({ ok: true })

    await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'reschedule' })
    const second = (insertDeliveryIfAbsent.mock.calls[0][1] as { idempotencyKey: string }).idempotencyKey

    expect(second).not.toBe(first)
  })

  it('sends a CANCEL for a cancellation and a REQUEST otherwise', async () => {
    await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'cancellation' })
    const cancelIcs = (sendCalendarEventEmail.mock.calls[0][1] as { icsContent: string }).icsContent
    expect(cancelIcs).toContain('METHOD:CANCEL')
    expect(cancelIcs).toContain('STATUS:CANCELLED')

    vi.clearAllMocks()
    findSchedulingNotificationContext.mockResolvedValue(CONTEXT)
    findUserEmail.mockResolvedValue('organizer@test.invalid')
    insertDeliveryIfAbsent.mockResolvedValue({ id: 'delivery-x' })
    sendCalendarEventEmail.mockResolvedValue({ ok: true })

    await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'invitation' })
    expect((sendCalendarEventEmail.mock.calls[0][1] as { icsContent: string }).icsContent).toContain('METHOD:REQUEST')
  })

  it('carries no capability secret and no portal link — there is no resend', async () => {
    await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'invitation' })

    const payload = JSON.stringify(sendCalendarEventEmail.mock.calls[0][1])
    expect(payload).not.toMatch(/\/schedule\//)
    expect(payload).not.toMatch(/#[0-9a-f]{32}/i)
  })

  it('records a failed send in the ledger and still reports rather than throwing', async () => {
    sendCalendarEventEmail.mockResolvedValue({ ok: false, error: 'Resend 500' })

    const result = await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'invitation' })

    expect(result.outcomes.every((outcome) => outcome.state === 'failed')).toBe(true)
    // A short code only: these rows are user-visible, and a provider message can carry an address.
    for (const call of markDeliveryOutcome.mock.calls) {
      expect(call[3]).toEqual({ state: 'failed', errorCode: 'send_failed' })
    }
  })

  it('skips a duplicate whose delivery row is already sent', async () => {
    insertDeliveryIfAbsent.mockResolvedValue(null)
    findDeliveryByIdempotencyKey.mockResolvedValue({ id: 'delivery-old', state: 'sent' })

    const result = await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'invitation' })

    expect(result.outcomes.every((outcome) => outcome.state === 'skipped_duplicate')).toBe(true)
    expect(sendCalendarEventEmail).not.toHaveBeenCalled()
  })

  it('retries a delivery row left failed', async () => {
    insertDeliveryIfAbsent.mockResolvedValue(null)
    findDeliveryByIdempotencyKey.mockResolvedValue({ id: 'delivery-old', state: 'failed' })

    await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'invitation' })

    expect(sendCalendarEventEmail).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the invitation has no booked event, which is a decline or an expiry', async () => {
    findSchedulingNotificationContext.mockResolvedValue(null)

    const result = await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'cancellation' })

    expect(result.outcomes).toEqual([])
    expect(sendCalendarEventEmail).not.toHaveBeenCalled()
  })

  it('reports no_address rather than failing when the invitation carries no candidate email', async () => {
    findSchedulingNotificationContext.mockResolvedValue({ ...CONTEXT, candidateEmail: null })

    const result = await notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'invitation' })

    expect(result.outcomes).toEqual([
      { role: 'candidate', state: 'no_address' },
      { role: 'organizer', state: 'sent' },
    ])
  })

  it('never throws, so a mail outage cannot undo a committed booking', async () => {
    findSchedulingNotificationContext.mockRejectedValue(new Error('database is on fire'))

    await expect(
      notifyAppointmentChange({ organizationId: 'org-1', invitationId: 'inv-1', kind: 'invitation' }),
    ).resolves.toEqual({ kind: 'invitation', outcomes: [] })
  })
})
