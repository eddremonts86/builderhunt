/**
 * Real disposable Postgres, real billing platform, real consent ledger.
 *
 * Every claim this service makes is database-shaped: whether a version guard actually stops the second
 * tab, whether a withdrawal is visible to the next heartbeat, whether a reservation is left holding
 * credits after a session dies. A mocked repository would let all four pass while none of them held.
 *
 * The two things that *are* faked are time and the provider's billed duration — both are inputs the
 * caller supplies, and both need to take values a real clock and a real interview will not produce on
 * demand (a heartbeat two minutes stale, a session that billed zero seconds).
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({
  INTERVIEW_TRANSCRIPTION_ENABLED: 'true' as 'true' | 'false',
  INTERVIEW_TRANSCRIPT_RETENTION_DAYS: 90,
  CREDIT_FIRST_PAYER_CAP_UNITS: 100000,
}))
vi.mock('~/shared/lib/env', () => ({ env: mockEnv }))

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const schema = await import('~/shared/lib/db/schema')
const { grantCredits } = await import('~/shared/lib/billing/credits')
const { settleReservation } = await import('~/shared/lib/billing/feature-authorization')
const service = await import('~/lib/interviews/session-service')
const { listSessionSegments } = await import('~/shared/lib/repositories/interviews')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'ss-org'
const OWNER = 'ss-owner'
const PARTICIPANT = 'ss-participant'
/** A separate organization with no subscription: the tier-refusal case cannot be faked on the first. */
const POOR_ORG = 'ss-poor-org'
const POOR_OWNER = 'ss-poor-owner'

const NOW = new Date('2027-08-02T09:00:00.000Z')
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`

let eventId = ''
let invitationId = ''
let poorEventId = ''
let poorInvitationId = ''

const principal = { organizationId: ORG, userId: OWNER, role: 'owner', requestId: 'r1' } as never
const participantPrincipal = { organizationId: ORG, userId: PARTICIPANT, role: 'member', requestId: 'r2' } as never
const poorPrincipal = { organizationId: POOR_ORG, userId: POOR_OWNER, role: 'owner', requestId: 'r3' } as never

const context = {
  eventId: '',
  invitationId: '',
  captureMode: 'remote_call' as const,
  language: 'en' as const,
  captureCapability: 'microphone_and_shared_audio_available',
}

/** 180 credits: the whole reservation ceiling, which is what one live session holds. */
const FULL_RESERVATION_UNITS = 180

async function seedOrganization(orgId: string, userId: string, email: string, withSubscription: boolean) {
  await db.insert(schema.organizations).values({ id: orgId, name: orgId, slug: orgId })
  await db.insert(schema.authUsers).values({
    id: userId, name: userId, email, emailVerified: true, createdAt: NOW, updatedAt: NOW,
  })
  if (withSubscription) {
    const customerId = uniqueId('cus')
    await db.insert(schema.billingCustomers).values({
      id: customerId, organizationId: orgId, livemode: false,
      stripeCustomerId: `cus_${customerId}`, createdAt: NOW, updatedAt: NOW,
    })
    await db.insert(schema.billingSubscriptions).values({
      id: uniqueId('sub'), organizationId: orgId, customerId, livemode: false,
      catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: uniqueId('ssub'), stripeStatus: 'active', providerSyncedAt: NOW,
      createdAt: NOW, updatedAt: NOW,
    })
  }

  const [calendar] = await db.insert(schema.userCalendars).values({
    organizationId: orgId, ownerUserId: userId, name: 'Cal', timezone: 'UTC', isDefault: true,
  }).returning({ id: schema.userCalendars.id })
  const [event] = await db.insert(schema.calendarEvents).values({
    organizationId: orgId, calendarId: calendar.id, ownerUserId: userId, type: 'personal', status: 'scheduled',
    title: 'Interview', startsAt: NOW, endsAt: new Date(NOW.getTime() + 3_600_000),
    timezone: 'UTC', allDay: false, busy: true,
  }).returning({ id: schema.calendarEvents.id })
  const [invitation] = await db.insert(schema.schedulingInvitations).values({
    organizationId: orgId, ownerUserId: userId, roleTitle: 'Engineer', roleContext: 'Backend',
    durationMinutes: 45, timezone: 'UTC', modality: 'remote_call', policyVersion: 'v1',
  }).returning({ id: schema.schedulingInvitations.id })

  return { eventId: event.id, invitationId: invitation.id }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('session_service')
  db = disposable.db
  drop = disposable.drop

  const main = await seedOrganization(ORG, OWNER, 'ss@test.invalid', true)
  eventId = main.eventId
  invitationId = main.invitationId
  context.eventId = eventId
  context.invitationId = invitationId

  await db.insert(schema.authUsers).values({
    id: PARTICIPANT, name: 'Participant', email: 'ssp@test.invalid',
    emailVerified: true, createdAt: NOW, updatedAt: NOW,
  })
  await db.insert(schema.eventParticipants).values({
    organizationId: ORG, eventId, eventOwnerUserId: OWNER, userId: PARTICIPANT,
    role: 'attendee', accessGranted: true,
  })

  const poor = await seedOrganization(POOR_ORG, POOR_OWNER, 'ssq@test.invalid', false)
  poorEventId = poor.eventId
  poorInvitationId = poor.invitationId
}, 180_000)

afterAll(async () => {
  await drop()
})

beforeEach(async () => {
  // Leaf-first along the FK chain. Reservations must go before the grants they drew from, or a
  // "nothing was held" assertion would read a previous test's row.
  await db.delete(schema.privacyConsents)
  await resetBillingAndSessions()
  mockEnv.INTERVIEW_TRANSCRIPTION_ENABLED = 'true'
})

/**
 * Leaf-first along the FK chain, and in one place: ledger entries reference reservations, allocations
 * reference both, and reservations must go before the grants they drew from. Retyping this order per
 * test is how a cleanup starts failing on a constraint instead of cleaning up.
 */
async function resetBillingAndSessions() {
  await db.delete(schema.transcriptSegments)
  await db.delete(schema.interviewSessions)
  await db.delete(schema.billingCreditAllocations)
  await db.delete(schema.billingLedgerEntries)
  await db.delete(schema.billingCreditReservations)
  await db.delete(schema.billingCreditGrants)
  await grantUnits(ORG, 500)
}

async function grantUnits(organizationId: string, units: number) {
  await db.transaction((tx) => grantCredits(tx, {
    grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId,
    source: 'promotional', units, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
  }))
}

async function acceptConsent(
  invitation = invitationId,
  organizationId = ORG,
  noticeVersion = '2027-08-01.1',
  decidedAt = NOW,
) {
  await db.insert(schema.privacyConsents).values({
    organizationId, invitationId: invitation, subjectEmailHash: 'h'.repeat(64),
    purpose: 'live_audio_transcription', noticeVersion, decision: 'accepted',
    decidedAt, requestEvidenceHash: 'e'.repeat(64),
  })
}

async function declineConsent(decidedAt: Date) {
  await db.insert(schema.privacyConsents).values({
    organizationId: ORG, invitationId, subjectEmailHash: 'h'.repeat(64),
    purpose: 'live_audio_transcription', noticeVersion: '2027-08-01.1', decision: 'declined',
    decidedAt, requestEvidenceHash: 'f'.repeat(64),
  })
}

async function withdrawConsent() {
  await db.update(schema.privacyConsents)
    .set({ withdrawnAt: new Date(NOW.getTime() + 60_000) })
    .where(eq(schema.privacyConsents.invitationId, invitationId))
}

const tx = <T>(work: (transaction: never) => Promise<T>): Promise<T> =>
  db.transaction((transaction) => work(transaction as never))

/** Walks the session to `live` and returns it, so each test starts from the state it cares about. */
async function toLive() {
  await acceptConsent()
  const started = await tx((t) => service.startSession(t, principal, context, { now: NOW }))
  const ready = await tx((t) => service.markSessionReady(t, principal, {
    eventId, invitationId, expectedVersion: started.version,
  }))
  return tx((t) => service.goLive(t, principal, {
    eventId, invitationId, expectedVersion: ready.version, now: NOW,
  }))
}

async function reservations() {
  return db.select().from(schema.billingCreditReservations)
}

describe('consent is read from the ledger, latest decision winning', () => {
  it('refuses a session with no consent row at all', async () => {
    const started = await tx((t) => service.startSession(t, principal, context, { now: NOW }))
    await expect(tx((t) => service.markSessionReady(t, principal, {
      eventId, invitationId, expectedVersion: started.version,
    }))).rejects.toMatchObject({ code: 'consent_missing' })
  })

  it('treats a later decline as superseding an earlier accept', async () => {
    // The failure this guards: reading consent as "some row says accepted" would transcribe a candidate
    // who accepted at booking and changed their mind before the interview.
    await acceptConsent()
    await declineConsent(new Date(NOW.getTime() + 60_000))

    const state = await tx((t) => service.readTranscriptionConsent(t, {
      organizationId: ORG, invitationId,
    }))
    expect(state.granted).toBe(false)
  })

  it('treats a later accept as re-consent after a withdrawal', async () => {
    await acceptConsent()
    await withdrawConsent()
    // A day later, against a newer notice. Re-consent is a separate act at a separate time — giving both
    // rows the same `decided_at` would leave the ordering resting on a random uuid tiebreak.
    await acceptConsent(invitationId, ORG, '2027-08-01.2', new Date(NOW.getTime() + 86_400_000))

    const state = await tx((t) => service.readTranscriptionConsent(t, {
      organizationId: ORG, invitationId,
    }))
    expect(state.granted).toBe(true)
    expect(state.noticeVersion).toBe('2027-08-01.2')
  })

  it('reports a withdrawal distinctly from an absence', async () => {
    await acceptConsent()
    await withdrawConsent()
    const state = await tx((t) => service.readTranscriptionConsent(t, {
      organizationId: ORG, invitationId,
    }))
    expect(state.granted).toBe(false)
    expect(state.withdrawnAt).toBeInstanceOf(Date)

    await expect(tx((t) => service.assertTranscriptionAllowed(t, {
      organizationId: ORG, invitationId,
    }))).rejects.toMatchObject({ code: 'consent_withdrawn' })
  })

  it('records the notice version the candidate actually consented against', async () => {
    // Not this deployment's current notice: stamping today's version onto a consent given to an older
    // one would make the audit trail claim something untrue.
    await acceptConsent(invitationId, ORG, '2026-01-01.7')
    const started = await tx((t) => service.startSession(t, principal, context, { now: NOW }))
    expect(started.consentNoticeVersion).toBe('2026-01-01.7')
  })
})

describe('the transition machine', () => {
  it('walks not_started → consent_pending → ready → live → paused → live → processing', async () => {
    const live = await toLive()
    expect(live.session.state).toBe('live')
    expect(live.session.startedAt).toEqual(NOW)

    const paused = await tx((t) => service.pauseSession(t, principal, {
      eventId, expectedVersion: live.session.version, now: NOW,
    }))
    expect(paused.state).toBe('paused')
    expect(paused.pausedAt).toEqual(NOW)

    const resumed = await tx((t) => service.resumeSession(t, principal, {
      eventId, invitationId, expectedVersion: paused.version,
    }))
    expect(resumed.state).toBe('live')
    expect(resumed.pausedAt).toBeNull()
    // Preserved: `started_at` is when this interview began, not when it last resumed.
    expect(resumed.startedAt).toEqual(NOW)

    const finished = await tx((t) => service.finishSession(t, principal, {
      eventId, expectedVersion: resumed.version, providerBilledSeconds: 1_800, providerRequestId: 'req-1',
    }))
    expect(finished.session.state).toBe('processing')
    // `finished_at` is null on purpose: `interview_sessions_finished_check` ties it to the terminal
    // states, and the database would reject it here.
    expect(finished.session.finishedAt).toBeNull()
  })

  it('refuses live directly from consent_pending', async () => {
    await acceptConsent()
    const started = await tx((t) => service.startSession(t, principal, context, { now: NOW }))
    await expect(tx((t) => service.goLive(t, principal, {
      eventId, invitationId, expectedVersion: started.version, now: NOW,
    }))).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('refuses to reopen a finished session', async () => {
    const live = await toLive()
    const finished = await tx((t) => service.finishSession(t, principal, {
      eventId, expectedVersion: live.session.version, providerBilledSeconds: 60, providerRequestId: 'r',
    }))
    await expect(tx((t) => service.resumeSession(t, principal, {
      eventId, invitationId, expectedVersion: finished.session.version,
    }))).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('takes failed and abandoned from live, stamping finished_at', async () => {
    for (const state of ['failed', 'abandoned'] as const) {
      // Consents too: `toLive` grants one, and the unique index refuses an identical second grant.
      await db.delete(schema.privacyConsents)
      await resetBillingAndSessions()
      const live = await toLive()
      const ended = await tx((t) => service.endSessionUnsuccessfully(t, principal, {
        eventId, expectedVersion: live.session.version, state, providerBilledSeconds: 0, now: NOW,
      }))
      expect(ended.session.state).toBe(state)
      expect(ended.session.finishedAt).toEqual(NOW)
    }
  })

  it('stops the second tab with the version guard', async () => {
    const live = await toLive()
    const paused = await tx((t) => service.pauseSession(t, principal, {
      eventId, expectedVersion: live.session.version, now: NOW,
    }))
    // A tab still holding the pre-pause version. It must be told to reload — not told it attempted
    // `paused → paused`, which is a transition it never requested and cannot act on.
    await expect(tx((t) => service.pauseSession(t, principal, {
      eventId, expectedVersion: live.session.version, now: NOW,
    }))).rejects.toMatchObject({ code: 'version_conflict' })
    expect(paused.version).toBe(live.session.version + 1)
  })

  it('does not bump the version on a heartbeat', async () => {
    // A beat that bumped the version would invalidate every open tab's expected version several times a
    // minute, and every real transition would then fail with a spurious conflict.
    const live = await toLive()
    const beat = await tx((t) => service.heartbeat(t, principal, {
      eventId, invitationId, now: new Date(NOW.getTime() + 5_000),
    }))
    expect(beat.action).toBe('continue')
    const [row] = await db.select().from(schema.interviewSessions)
    expect(row.version).toBe(live.session.version)
    expect(row.heartbeatAt).toEqual(new Date(NOW.getTime() + 5_000))
  })
})

describe('the feature switch and the deployment', () => {
  it('refuses to create a session when transcription is not enabled here', async () => {
    mockEnv.INTERVIEW_TRANSCRIPTION_ENABLED = 'false'
    await acceptConsent()
    await expect(tx((t) => service.startSession(t, principal, context, { now: NOW })))
      .rejects.toMatchObject({ code: 'transcription_disabled' })
    expect(await db.select().from(schema.interviewSessions)).toHaveLength(0)
  })
})

describe('participants read, owners drive', () => {
  it('refuses a participant every state change', async () => {
    const live = await toLive()
    await expect(tx((t) => service.pauseSession(t, participantPrincipal, {
      eventId, expectedVersion: live.session.version, now: NOW,
    }))).rejects.toMatchObject({ code: 'not_owner' })

    await expect(tx((t) => service.finishSession(t, participantPrincipal, {
      eventId, expectedVersion: live.session.version, providerBilledSeconds: 10, providerRequestId: null,
    }))).rejects.toMatchObject({ code: 'not_owner' })

    await expect(tx((t) => service.appendSegments(t, participantPrincipal, {
      eventId, segments: [segment(1)],
    }))).rejects.toMatchObject({ code: 'not_owner' })
  })

  it('lets a participant heartbeat without their tab keeping a dead session alive', async () => {
    const live = await toLive()
    const beat = await tx((t) => service.heartbeat(t, participantPrincipal, {
      eventId, invitationId, now: new Date(NOW.getTime() + 30_000),
    }))
    expect(beat.action).toBe('continue')
    const [row] = await db.select().from(schema.interviewSessions)
    // Untouched. Only the owner's client is capturing, so only the owner's beat is evidence the
    // capture is alive — otherwise a participant's forgotten tab would keep a crashed session out of
    // reclaim indefinitely.
    expect(row.heartbeatAt).toEqual(live.session.heartbeatAt)
  })
})

describe('a withdrawal mid-interview', () => {
  it('answers the next heartbeat with stop_now and the ten-second deadline', async () => {
    await toLive()
    await withdrawConsent()

    const beat = await tx((t) => service.heartbeat(t, principal, {
      eventId, invitationId, now: new Date(NOW.getTime() + 120_000),
    }))
    expect(beat.action).toBe('stop_now')
    expect(beat.hardStopMs).toBe(10_000)
    // Still live in the database: the client stops capture, and the organizer then finishes the session
    // deliberately. Flipping the state here would end an interview from inside a polling endpoint.
    expect(beat.session.state).toBe('live')
  })

  it('refuses a new provider grant, which is the actual enforcement', async () => {
    // A client that ignores stop_now keeps its current socket for the rest of a 30-second grant and then
    // cannot get another. That is the guarantee — not the client's cooperation.
    await toLive()
    await withdrawConsent()
    await expect(tx((t) => service.assertTranscriptionAllowed(t, {
      organizationId: ORG, invitationId,
    }))).rejects.toMatchObject({ code: 'consent_withdrawn' })
  })

  it('refuses to resume after a withdrawal during the pause', async () => {
    const live = await toLive()
    const paused = await tx((t) => service.pauseSession(t, principal, {
      eventId, expectedVersion: live.session.version, now: NOW,
    }))
    await withdrawConsent()
    await expect(tx((t) => service.resumeSession(t, principal, {
      eventId, invitationId, expectedVersion: paused.version,
    }))).rejects.toMatchObject({ code: 'consent_withdrawn' })
  })
})

describe('the reservation lifecycle', () => {
  it('holds the full ceiling before the session is live', async () => {
    const live = await toLive()
    const rows = await reservations()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(service.sessionReservationId(live.session.id))
    expect(rows[0].maximumUnits).toBe(FULL_RESERVATION_UNITS)
    expect(rows[0].state).toBe('reserved')
    expect(live.reservedUnits).toBe(FULL_RESERVATION_UNITS)
  })

  it('does not go live when credits are short, and holds nothing', async () => {
    await db.delete(schema.billingCreditAllocations)
    await db.delete(schema.billingLedgerEntries)
    await db.delete(schema.billingCreditReservations)
    await db.delete(schema.billingCreditGrants)
    // Ten credits against a 180-credit ceiling.
    await grantUnits(ORG, 10)

    await acceptConsent()
    const started = await tx((t) => service.startSession(t, principal, context, { now: NOW }))
    const ready = await tx((t) => service.markSessionReady(t, principal, {
      eventId, invitationId, expectedVersion: started.version,
    }))
    await expect(tx((t) => service.goLive(t, principal, {
      eventId, invitationId, expectedVersion: ready.version, now: NOW,
    }))).rejects.toMatchObject({ code: 'insufficient_credits' })

    const [row] = await db.select().from(schema.interviewSessions)
    // The transition is last for exactly this reason: a session that went live and then failed to
    // reserve would be capturing against nothing.
    expect(row.state).toBe('ready')
    expect(await reservations()).toHaveLength(0)
  })

  it('separates a tier refusal from a balance refusal', async () => {
    // An organization with no subscription cannot reach the feature at all. Routing that to a top-up
    // page would send someone to buy credits that would not help them.
    await acceptConsent(poorInvitationId, POOR_ORG)
    await grantUnits(POOR_ORG, 500)
    const poorContext = { ...context, eventId: poorEventId, invitationId: poorInvitationId }
    const started = await tx((t) => service.startSession(t, poorPrincipal, poorContext, { now: NOW }))
    const ready = await tx((t) => service.markSessionReady(t, poorPrincipal, {
      eventId: poorEventId, invitationId: poorInvitationId, expectedVersion: started.version,
    }))
    await expect(tx((t) => service.goLive(t, poorPrincipal, {
      eventId: poorEventId, invitationId: poorInvitationId, expectedVersion: ready.version, now: NOW,
    }))).rejects.toMatchObject({ code: 'not_entitled' })
  })

  it('replays rather than double-holding when goLive is retried', async () => {
    const live = await toLive()
    // The same derived reservation id, so a retry — or a second tab racing the first — replays the
    // existing hold instead of taking a second 180 credits against one conversation.
    await expect(tx((t) => service.goLive(t, principal, {
      eventId, invitationId, expectedVersion: live.session.version - 1, now: NOW,
    }))).rejects.toMatchObject({ code: 'version_conflict' })
    expect(await reservations()).toHaveLength(1)
  })

  it('settles what the provider billed, not the wall clock', async () => {
    const live = await toLive()
    // Thirty-one minutes of provider-billed audio in a session whose row has existed far longer. A
    // wall-clock settlement would bill for every minute the tab was open.
    const finished = await tx((t) => service.finishSession(t, principal, {
      eventId, expectedVersion: live.session.version, providerBilledSeconds: 1_860, providerRequestId: 'req-9',
    }))
    expect(finished.settledUnits).toBe(31)
    expect(finished.session.providerBilledSeconds).toBe(1_860)
    expect(finished.session.providerRequestId).toBe('req-9')

    const rows = await reservations()
    expect(rows[0].state).toBe('settled')
    expect(rows[0].settledUnits).toBe(31)
  })

  it('rounds a part-minute up, because the provider does', async () => {
    const live = await toLive()
    const finished = await tx((t) => service.finishSession(t, principal, {
      eventId, expectedVersion: live.session.version, providerBilledSeconds: 61, providerRequestId: null,
    }))
    // Rounding down would systematically under-bill every session — a slow accounting error rather
    // than a visible bug.
    expect(finished.settledUnits).toBe(2)
  })

  it('releases the whole hold when the provider transcribed nothing', async () => {
    const live = await toLive()
    const ended = await tx((t) => service.endSessionUnsuccessfully(t, principal, {
      eventId, expectedVersion: live.session.version, state: 'failed', providerBilledSeconds: 0, now: NOW,
    }))
    expect(ended.settledUnits).toBe(0)
    const rows = await reservations()
    // Charging for a connection that never carried audio is charging for nothing.
    expect(rows[0].state).toBe('released')
    // Zero, not null: `releaseReservation` records that nothing was consumed rather than leaving the
    // column unanswered. `released` is what distinguishes it from a settlement that came to zero.
    expect(rows[0].settledUnits).toBe(0)
  })

  it('settles the partial audio when a session fails part-way', async () => {
    const live = await toLive()
    const ended = await tx((t) => service.endSessionUnsuccessfully(t, principal, {
      eventId, expectedVersion: live.session.version, state: 'failed', providerBilledSeconds: 600, now: NOW,
    }))
    expect(ended.settledUnits).toBe(10)
    const rows = await reservations()
    expect(rows[0].state).toBe('settled')
  })

  it('closes the reservation of a session that never went live', async () => {
    await acceptConsent()
    const started = await tx((t) => service.startSession(t, principal, context, { now: NOW }))
    // No reservation was ever taken. Abandoning must still succeed — a tolerant close is what stops a
    // session getting stuck one state short of terminal.
    const ended = await tx((t) => service.endSessionUnsuccessfully(t, principal, {
      eventId, expectedVersion: started.version, state: 'abandoned', now: NOW,
    }))
    expect(ended.session.state).toBe('abandoned')
    expect(ended.settledUnits).toBe(0)
  })

  it('survives a settlement that already happened', async () => {
    const live = await toLive()
    // The reservation is settled out from under the service, as a crashed retry would leave it.
    await db.transaction((t) => settleReservation(t as never, principal, {
      reservationId: service.sessionReservationId(live.session.id),
      actualUnits: 5,
      idempotencyKey: 'external-settle',
    }))
    const finished = await tx((t) => service.finishSession(t, principal, {
      eventId, expectedVersion: live.session.version, providerBilledSeconds: 600, providerRequestId: null,
    }))
    // The transition still lands. Losing it to protect a settlement that already happened would leave
    // the session live forever, which is strictly worse.
    expect(finished.session.state).toBe('processing')
    const rows = await reservations()
    expect(rows[0].settledUnits).toBe(5)
  })
})

describe('extension and low balance', () => {
  it('extends a live session and reports the new ceiling', async () => {
    await toLive()
    const outcome = await tx((t) => service.extendLiveReservation(t, principal, {
      eventId, additionalMinutes: 30,
    }))
    expect(outcome.extended).toBe(true)
    expect(outcome.reservedUnits).toBe(FULL_RESERVATION_UNITS + 30)
  })

  it('replays an identical extension instead of stacking a second grant', async () => {
    await toLive()
    await tx((t) => service.extendLiveReservation(t, principal, { eventId, additionalMinutes: 30 }))
    const again = await tx((t) => service.extendLiveReservation(t, principal, { eventId, additionalMinutes: 30 }))
    expect(again.reservedUnits).toBe(FULL_RESERVATION_UNITS + 30)
  })

  it('reports a refused extension rather than throwing', async () => {
    // 500 granted, 180 held: an extension of 400 cannot be covered. Throwing here would most likely
    // become a 5xx and end an interview that should keep running unpaid.
    await toLive()
    const outcome = await tx((t) => service.extendLiveReservation(t, principal, {
      eventId, additionalMinutes: 400,
    }))
    expect(outcome.extended).toBe(false)
    expect(outcome.refusal).toBe('insufficient_credits')
    expect(outcome.reservedUnits).toBe(FULL_RESERVATION_UNITS)
  })

  it('refuses to extend anything but a live session', async () => {
    const live = await toLive()
    await tx((t) => service.pauseSession(t, principal, {
      eventId, expectedVersion: live.session.version, now: NOW,
    }))
    await expect(tx((t) => service.extendLiveReservation(t, principal, {
      eventId, additionalMinutes: 10,
    }))).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('warns as the reservation runs down, most severe last', () => {
    const at = (minutes: number) => service.lowBalanceWarningsForSession({
      reservedUnits: 100, elapsedSeconds: minutes * 60,
    }).map((warning) => warning.level)

    expect(at(50)).toEqual([])
    expect(at(80)).toContain('eighty_percent')
    expect(at(92)).toEqual(expect.arrayContaining(['eighty_percent', 'ninety_percent', 'ten_minutes_remaining']))
  })

  it('carries the warnings on a heartbeat when the caller supplies the ceiling', async () => {
    await toLive()
    const beat = await tx((t) => service.heartbeat(t, principal, {
      eventId, invitationId, reservedUnits: 100, now: new Date(NOW.getTime() + 95 * 60_000),
    }))
    expect(beat.warnings.map((warning) => warning.level)).toContain('ninety_percent')
  })
})

describe('heartbeat staleness', () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: 'x', organizationId: ORG, eventId, ownerUserId: OWNER, state: 'live',
    captureMode: 'remote_call', language: 'en', provider: 'deepgram',
    consentNoticeVersion: 'v', captureCapability: 'microphone_only',
    startedAt: NOW, pausedAt: null, finishedAt: null, heartbeatAt: NOW,
    providerRequestId: null, providerBilledSeconds: 0, version: 1,
    ...overrides,
  }) as never

  it('is not stale within the window', () => {
    expect(service.isHeartbeatStale(row({}), new Date(NOW.getTime() + 60_000))).toBe(false)
  })

  it('is stale past it', () => {
    expect(service.isHeartbeatStale(row({}), new Date(NOW.getTime() + 120_000))).toBe(true)
  })

  it('measures from the start when no beat has arrived at all', () => {
    // A client that connected and died before its first beat. With `heartbeatAt` null and no fallback
    // this would never be reclaimed.
    expect(service.isHeartbeatStale(row({ heartbeatAt: null }), new Date(NOW.getTime() + 120_000))).toBe(true)
  })

  it('is stale immediately when there is neither', () => {
    expect(service.isHeartbeatStale(row({ heartbeatAt: null, startedAt: null }), NOW)).toBe(true)
  })

  it('never calls a paused session stale', () => {
    // A pause is quiet on purpose. Reclaiming it would end an interview during a break.
    expect(service.isHeartbeatStale(
      row({ state: 'paused', heartbeatAt: null, startedAt: null }),
      new Date(NOW.getTime() + 86_400_000),
    )).toBe(false)
  })
})

const segment = (sequenceNumber: number) => ({
  providerSegmentId: `req:0:${sequenceNumber}`,
  sequence: sequenceNumber,
  speakerEstimate: 'speaker_a',
  text: `Turn ${sequenceNumber}.`,
  startsMs: sequenceNumber * 1_000,
  endsMs: sequenceNumber * 1_000 + 900,
  confidence: 0.97,
})

describe('segments', () => {
  it('accepts a batch on a live session', async () => {
    await toLive()
    const result = await tx((t) => service.appendSegments(t, principal, {
      eventId, segments: [segment(1), segment(2)], now: NOW,
    }))
    expect(result.inserted).toBe(2)
    expect(result.accepted).toHaveLength(2)
  })

  it('acknowledges a resend without inserting it twice', async () => {
    const live = await toLive()
    await tx((t) => service.appendSegments(t, principal, { eventId, segments: [segment(1)], now: NOW }))
    const again = await tx((t) => service.appendSegments(t, principal, {
      eventId, segments: [segment(1)], now: NOW,
    }))
    // The outbox needs "accepted, already had it" to be distinguishable from "accepted, new" — the
    // first is what lets it stop resending.
    expect(again.accepted).toHaveLength(1)
    expect(again.inserted).toBe(0)

    const stored = await tx((t) => listSessionSegments(t, {
      organizationId: ORG, sessionId: live.session.id,
    }))
    expect(stored).toHaveLength(1)
  })

  it('refuses a paused session', async () => {
    const live = await toLive()
    await tx((t) => service.pauseSession(t, principal, {
      eventId, expectedVersion: live.session.version, now: NOW,
    }))
    // Recording audio captured while the organizer believed capture had stopped.
    await expect(tx((t) => service.appendSegments(t, principal, {
      eventId, segments: [segment(1)], now: NOW,
    }))).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('refuses a finished session', async () => {
    const live = await toLive()
    await tx((t) => service.finishSession(t, principal, {
      eventId, expectedVersion: live.session.version, providerBilledSeconds: 60, providerRequestId: null,
    }))
    // Extending a transcript after it was handed to a report.
    await expect(tx((t) => service.appendSegments(t, principal, {
      eventId, segments: [segment(1)], now: NOW,
    }))).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('does not open a write for an empty batch', async () => {
    await toLive()
    const result = await tx((t) => service.appendSegments(t, principal, { eventId, segments: [], now: NOW }))
    expect(result).toEqual({ accepted: [], inserted: 0 })
  })
})

describe('a missing session', () => {
  it('answers not_found rather than naming what it cannot see', async () => {
    await expect(tx((t) => service.heartbeat(t, principal, { eventId, invitationId, now: NOW })))
      .rejects.toMatchObject({ code: 'not_found' })
  })
})
