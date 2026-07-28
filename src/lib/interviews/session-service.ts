import {
  estimateTranscriptionUnitsForSeconds,
  MAX_LIVE_TRANSCRIPTION_RESERVATION_MINUTES,
  resolveLowBalanceWarnings,
  type LowBalanceWarning,
} from '~/modules/interviews/billing'
import {
  extendReservation,
  FeatureBillingError,
  releaseReservation,
  reserveCredits,
  settleReservation,
} from '~/shared/lib/billing/feature-authorization'
import { ReservationError } from '~/shared/lib/billing/reservations'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { env } from '~/shared/lib/env'
import {
  assertValidInterviewSessionTransition,
  type InterviewSessionState,
} from '~/shared/lib/interviews'
import { INTERVIEW_RATE_CARD_KEYS } from '~/shared/lib/interview-config'
import {
  ensureSession,
  findSessionByEvent,
  insertTranscriptSegments,
  touchSessionHeartbeat,
  transitionSession,
  type InterviewSessionRow,
} from '~/shared/lib/repositories/interviews'
import { listConsentsForInvitation } from '~/shared/lib/repositories/scheduling'

/**
 * The live interview session lifecycle (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## Consent is re-read at every gate, never cached
 *
 * `live_audio_transcription` is checked when the session becomes ready, when it goes live, when it
 * resumes, and on every heartbeat. A candidate can withdraw mid-interview and spec.md gives a
 * ten-second hard stop — so a decision taken once at the start and remembered would keep transcribing
 * someone who has revoked permission, which is the failure this feature is riskiest for.
 *
 * The answer comes from the consent ledger, not from a flag on the session, because the ledger is where
 * a withdrawal lands. A cached boolean cannot become false.
 *
 * The client honouring `stop_now` is *not* the enforcement. The enforcement is that a Deepgram socket
 * needs a 30-second grant, every reconnect asks for a new one, and the token route calls
 * `assertTranscriptionAllowed` below. A client that ignores the heartbeat keeps its current socket for
 * at most the rest of that grant and then cannot get another.
 *
 * ## One reservation per session, and its id *is* the session id
 *
 * A live session spans many HTTP requests, so it cannot use `withInterviewCredits` — that wrapper
 * reserves, runs, and settles inside one call. It uses the primitives directly, and derives the
 * reservation id from the session id rather than storing a new column. That makes `reserveCredits`
 * idempotent by construction: a retried `goLive` replays the same reservation instead of holding a
 * second 180 credits against the same conversation.
 *
 * ## A refused extension stops paid capture, it does not end the interview
 *
 * spec.md is explicit that only *paid provider capture* stops at zero. Ending an interview because a
 * credit balance ran out would be a worse product than one that keeps taking notes, and the organizer
 * is mid-conversation with a real person. So `extendLiveReservation` reports the refusal and the session
 * stays live in manual-only.
 */

export class SessionServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'not_owner'
      | 'consent_missing'
      | 'consent_withdrawn'
      | 'invalid_transition'
      | 'version_conflict'
      | 'insufficient_credits'
      | 'not_entitled'
      | 'transcription_disabled',
  ) {
    super(message)
    this.name = 'SessionServiceError'
  }
}

/** How long a live session may go unheard from before it counts as abandoned. */
export const SESSION_HEARTBEAT_STALE_MS = 90_000

/** spec.md: a withdrawal must stop paid capture within ten seconds. */
export const WITHDRAWAL_HARD_STOP_MS = 10_000

/** The rate-card operation every session reserves against. */
const TRANSCRIPTION_OPERATION = INTERVIEW_RATE_CARD_KEYS.transcriptionPerMinute.operationKey

/**
 * The reservation id for a session.
 *
 * Derived, not stored. `billing_credit_reservations.id` is text, so the session's own uuid is a valid id
 * and it is already unique per session — which is exactly the uniqueness a reservation needs.
 */
export function sessionReservationId(sessionId: string): string {
  return `interview-session:${sessionId}`
}

function reservationIdempotencyKey(sessionId: string): string {
  return `interview-session:${sessionId}:transcription`
}

export interface ConsentState {
  granted: boolean
  withdrawnAt: Date | null
  noticeVersion: string | null
}

/**
 * The candidate's *current* position on live transcription.
 *
 * The latest row wins. Two things can change an earlier `accepted`: a withdrawal stamps `withdrawn_at`
 * on it, and a later decision supersedes it. Reading this as "some row says accepted and none is
 * withdrawn" would transcribe a candidate who accepted at booking and declined afterwards — the
 * supersession would be invisible.
 */
export async function readTranscriptionConsent(
  transaction: TenantTransaction,
  params: { organizationId: string; invitationId: string },
): Promise<ConsentState> {
  const consents = await listConsentsForInvitation(transaction, params.organizationId, params.invitationId)
  const current = consents
    .filter((consent) => consent.purpose === 'live_audio_transcription')
    // Sorted here rather than relying on the repository's ORDER BY. That query is shared, and a future
    // change to its ordering would silently invert this decision with nothing failing — which for a
    // consent check means transcribing someone who declined.
    .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime() || a.id.localeCompare(b.id))
    .at(-1)
  if (!current) return { granted: false, withdrawnAt: null, noticeVersion: null }

  return {
    granted: current.withdrawnAt === null && current.decision === 'accepted',
    withdrawnAt: current.withdrawnAt,
    noticeVersion: current.noticeVersion,
  }
}

/**
 * Throws unless the candidate currently permits transcription.
 *
 * Exported because the token route is the real enforcement point: no grant, no socket. Kept here so the
 * rule lives in one place rather than being restated in a handler.
 */
export async function assertTranscriptionAllowed(
  transaction: TenantTransaction,
  params: { organizationId: string; invitationId: string },
): Promise<void> {
  const consent = await readTranscriptionConsent(transaction, params)
  if (consent.withdrawnAt !== null) {
    throw new SessionServiceError('the candidate has withdrawn consent to live transcription', 'consent_withdrawn')
  }
  if (!consent.granted) {
    throw new SessionServiceError('the candidate has not consented to live transcription', 'consent_missing')
  }
}

function requireOwner(session: InterviewSessionRow, principal: TenantPrincipal): void {
  // A granted participant reads a session; they do not start, pause or finish someone else's interview.
  // RLS already refuses them the write, but failing here names the reason instead of surfacing an empty
  // UPDATE as a mysterious version conflict.
  if (session.ownerUserId !== principal.userId) {
    throw new SessionServiceError('only the interview owner can change the session state', 'not_owner')
  }
}

/**
 * Refuses a caller reasoning about a version that is no longer current.
 *
 * Checked *before* the transition machine, because a stale version means the state this service just
 * read is not the state the caller saw. Letting the machine run first turns a lost race into
 * `invalid_transition` — a transition the caller never requested, and one a client cannot act on. It
 * needs to be told to reload, which is what `version_conflict` says.
 */
function requireVersion(session: InterviewSessionRow, expectedVersion: number): void {
  if (session.version !== expectedVersion) {
    throw new SessionServiceError(
      `session is at version ${session.version}, not ${expectedVersion}; another client moved it`,
      'version_conflict',
    )
  }
}

function requireTransition(from: string, to: InterviewSessionState): void {
  try {
    assertValidInterviewSessionTransition(from as InterviewSessionState, to)
  } catch (error) {
    throw new SessionServiceError((error as Error).message, 'invalid_transition')
  }
}

function asServiceError(error: unknown): never {
  if (error instanceof FeatureBillingError) {
    // `insufficient_entitlement` is a tier problem and `insufficient_credits` is a balance problem. The
    // caller routes one to an upgrade page and the other to a top-up, so they must not collapse into a
    // single "billing failed" — and neither may be disguised as a transcription fault.
    throw new SessionServiceError(
      error.message,
      error.code === 'insufficient_credits' ? 'insufficient_credits' : 'not_entitled',
    )
  }
  throw error
}

export interface SessionContext {
  eventId: string
  invitationId: string
  captureMode: 'in_person' | 'remote_call'
  language: 'en' | 'da'
  captureCapability: string
}

function retentionExpiry(now: Date): Date {
  return new Date(now.getTime() + env.INTERVIEW_TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60_000)
}

/**
 * Creates or returns the session and moves it to `consent_pending`.
 *
 * `consent_pending` rather than straight to `ready`: the organizer still has to acknowledge that they
 * gave the verbal reminder. A session that jumped from creation to ready would let capture begin without
 * anyone having said out loud that it was about to.
 *
 * The notice version recorded on the session is the one the *candidate* consented against, read from the
 * ledger — not a constant from this deployment. Storing today's notice version against a consent given
 * to an older one would make the audit trail claim something untrue.
 */
export async function startSession(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  context: SessionContext,
  options: { now?: Date } = {},
): Promise<InterviewSessionRow> {
  const now = options.now ?? new Date()
  if (env.INTERVIEW_TRANSCRIPTION_ENABLED !== 'true') {
    throw new SessionServiceError('live transcription is not enabled in this deployment', 'transcription_disabled')
  }

  const consent = await readTranscriptionConsent(transaction, {
    organizationId: principal.organizationId,
    invitationId: context.invitationId,
  })

  const session = await ensureSession(transaction, {
    organizationId: principal.organizationId,
    eventId: context.eventId,
    ownerUserId: principal.userId,
    captureMode: context.captureMode,
    language: context.language,
    provider: 'deepgram',
    // `unknown` when there is no consent row at all: the column is NOT NULL, and inventing a version
    // here would be worse than recording that we do not have one. `markSessionReady` refuses to proceed
    // in that state anyway.
    consentNoticeVersion: consent.noticeVersion ?? 'unknown',
    captureCapability: context.captureCapability,
    retentionExpiresAt: retentionExpiry(now),
  })
  requireOwner(session, principal)

  if (session.state !== 'not_started') return session
  requireTransition(session.state, 'consent_pending')
  return transitionSession(transaction, {
    organizationId: principal.organizationId,
    sessionId: session.id,
    expectedVersion: session.version,
    state: 'consent_pending',
  })
}

/**
 * The organizer confirms they gave the verbal reminder, and the stored consent is re-read.
 *
 * Two separate things, both required. The candidate's recorded consent is the lawful basis; the verbal
 * reminder is what makes it informed *at the moment of recording* — a consent given three days ago in a
 * web form is not the same as being told "I am about to start transcribing this".
 */
export async function markSessionReady(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: { eventId: string; invitationId: string; expectedVersion: number },
): Promise<InterviewSessionRow> {
  const session = await requireSession(transaction, principal, params.eventId)
  requireOwner(session, principal)
  requireVersion(session, params.expectedVersion)
  await assertTranscriptionAllowed(transaction, {
    organizationId: principal.organizationId,
    invitationId: params.invitationId,
  })

  requireTransition(session.state, 'ready')
  return transitionSession(transaction, {
    organizationId: principal.organizationId,
    sessionId: session.id,
    expectedVersion: params.expectedVersion,
    state: 'ready',
  })
}

export interface LiveSession {
  session: InterviewSessionRow
  reservationId: string
  /** The reservation ceiling in credits, which is also its ceiling in provider-billed minutes. */
  reservedUnits: number
}

/**
 * Goes live, holding credits first.
 *
 * The reservation is taken before the session is live and therefore before the client is told it may
 * open a socket. A session that connected first and reserved afterwards would be spending on a
 * conversation the balance was about to refuse, and the refusal would arrive with the interview already
 * under way.
 *
 * The transition is last for the same reason in reverse: if reserving throws, nothing moved.
 */
export async function goLive(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: { eventId: string; invitationId: string; expectedVersion: number; now?: Date },
): Promise<LiveSession> {
  const now = params.now ?? new Date()
  const session = await requireSession(transaction, principal, params.eventId)
  requireOwner(session, principal)
  requireVersion(session, params.expectedVersion)
  await assertTranscriptionAllowed(transaction, {
    organizationId: principal.organizationId,
    invitationId: params.invitationId,
  })
  requireTransition(session.state, 'live')

  const reservationId = sessionReservationId(session.id)
  const reserved = await reserveCredits(transaction, principal, {
    reservationId,
    operation: TRANSCRIPTION_OPERATION,
    idempotencyKey: reservationIdempotencyKey(session.id),
  }).catch(asServiceError)

  const live = await transitionSession(transaction, {
    organizationId: principal.organizationId,
    sessionId: session.id,
    expectedVersion: params.expectedVersion,
    state: 'live',
    // Preserved across a pause/resume cycle: `started_at` is when this interview began, not when it
    // last resumed, and the settled duration is measured from the provider anyway.
    startedAt: session.startedAt ?? now,
    // Set here so a client that dies before its first beat is still reclaimable — with this null,
    // staleness would have nothing to measure from.
    heartbeatAt: now,
  })

  return { session: live, reservationId, reservedUnits: reserved.reservation.maximumUnits }
}

export async function pauseSession(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: { eventId: string; expectedVersion: number; now?: Date },
): Promise<InterviewSessionRow> {
  const session = await requireSession(transaction, principal, params.eventId)
  requireOwner(session, principal)
  requireVersion(session, params.expectedVersion)
  requireTransition(session.state, 'paused')
  return transitionSession(transaction, {
    organizationId: principal.organizationId,
    sessionId: session.id,
    expectedVersion: params.expectedVersion,
    state: 'paused',
    pausedAt: params.now ?? new Date(),
  })
}

/**
 * Resuming re-reads consent, because a candidate may have withdrawn during the pause.
 *
 * No second reservation: the first is still held. Reserving again would double the hold on one
 * conversation, and the derived id means the attempt would replay rather than fail loudly — which is
 * worse than either.
 */
export async function resumeSession(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: { eventId: string; invitationId: string; expectedVersion: number },
): Promise<InterviewSessionRow> {
  const session = await requireSession(transaction, principal, params.eventId)
  requireOwner(session, principal)
  requireVersion(session, params.expectedVersion)
  await assertTranscriptionAllowed(transaction, {
    organizationId: principal.organizationId,
    invitationId: params.invitationId,
  })

  requireTransition(session.state, 'live')
  return transitionSession(transaction, {
    organizationId: principal.organizationId,
    sessionId: session.id,
    expectedVersion: params.expectedVersion,
    state: 'live',
    pausedAt: null,
  })
}

export interface ExtensionOutcome {
  extended: boolean
  reservedUnits: number
  /** Set when the extension was refused, so a caller can tell a balance problem from a tier problem. */
  refusal?: 'insufficient_credits' | 'not_entitled'
}

/**
 * Asks for more headroom when a session approaches its reservation ceiling.
 *
 * The initial reservation covers `MAX_LIVE_TRANSCRIPTION_RESERVATION_MINUTES` (three hours), which is
 * past any real interview — so this is the escape hatch, not the normal path.
 *
 * Refusal is returned, not thrown. The distinction matters: a thrown error at this point would most
 * likely be turned into a 5xx and end an interview that should keep running unpaid.
 */
export async function extendLiveReservation(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: { eventId: string; additionalMinutes: number },
): Promise<ExtensionOutcome> {
  const session = await requireSession(transaction, principal, params.eventId)
  requireOwner(session, principal)
  if (session.state !== 'live') {
    throw new SessionServiceError(`session is ${session.state}, not live`, 'invalid_transition')
  }
  if (!Number.isInteger(params.additionalMinutes) || params.additionalMinutes <= 0) {
    throw new SessionServiceError('additionalMinutes must be a positive integer', 'invalid_transition')
  }

  const additionalUnits = params.additionalMinutes * INTERVIEW_RATE_CARD_KEYS.transcriptionPerMinute.units
  try {
    const extended = await extendReservation(transaction, principal, {
      reservationId: sessionReservationId(session.id),
      additionalMaximumUnits: additionalUnits,
      // Keyed on the amount, not on a counter this service would have to store. A retried request for
      // the same extra minutes replays; a genuine second extension asks for a different total and gets
      // its own key.
      idempotencyKey: `interview-session:${session.id}:extend:${additionalUnits}`,
    })
    return { extended: true, reservedUnits: extended.reservation.maximumUnits }
  } catch (error) {
    if (error instanceof FeatureBillingError) {
      return {
        extended: false,
        // Unchanged — the refused extension granted nothing.
        reservedUnits: MAX_LIVE_TRANSCRIPTION_RESERVATION_MINUTES * INTERVIEW_RATE_CARD_KEYS.transcriptionPerMinute.units,
        refusal: error.code === 'insufficient_credits' ? 'insufficient_credits' : 'not_entitled',
      }
    }
    throw error
  }
}

/**
 * The low-balance warnings for a session that has run `elapsedSeconds` so far.
 *
 * Against the reservation, not the account balance: what matters to an organizer mid-interview is how
 * much of *this* session's hold is left, because that is what runs out and stops capture.
 */
export function lowBalanceWarningsForSession(params: {
  reservedUnits: number
  elapsedSeconds: number
}): LowBalanceWarning[] {
  return resolveLowBalanceWarnings({
    reservedUnits: params.reservedUnits,
    consumedUnits: estimateTranscriptionUnitsForSeconds(params.elapsedSeconds),
  })
}

/**
 * Finishes capture and settles on what the provider actually billed.
 *
 * `providerBilledSeconds` comes from the provider's own metadata, never from wall-clock time between
 * start and finish. A session left open in a background tab would otherwise bill for the hours nobody
 * spoke into.
 *
 * The state becomes `processing`, not `finalized`: the transcript still has to be assembled and a report
 * generated. `finished_at` stays null for the same reason — the schema's
 * `interview_sessions_finished_check` ties it to the terminal states, and stamping it here would be
 * rejected by the database.
 */
export async function finishSession(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: {
    eventId: string
    expectedVersion: number
    providerBilledSeconds: number
    providerRequestId: string | null
  },
): Promise<{ session: InterviewSessionRow; settledUnits: number }> {
  const session = await requireSession(transaction, principal, params.eventId)
  requireOwner(session, principal)
  requireVersion(session, params.expectedVersion)
  requireTransition(session.state, 'processing')

  const billedSeconds = Math.max(0, Math.trunc(params.providerBilledSeconds))
  const settledUnits = await settleTranscription(transaction, principal, session.id, billedSeconds)

  const finished = await transitionSession(transaction, {
    organizationId: principal.organizationId,
    sessionId: session.id,
    expectedVersion: params.expectedVersion,
    state: 'processing',
    providerRequestId: params.providerRequestId,
    providerBilledSeconds: billedSeconds,
  })
  return { session: finished, settledUnits }
}

/**
 * A session that broke, or one the organizer walked away from.
 *
 * Both are terminal and both must close the reservation — a `reserved` row left behind holds credits an
 * organization cannot spend until it expires. Whatever the provider had already transcribed is settled;
 * a session that never captured anything releases the whole hold instead, because charging for a failed
 * connection is charging for nothing.
 */
export async function endSessionUnsuccessfully(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: {
    eventId: string
    expectedVersion: number
    state: 'failed' | 'abandoned'
    providerBilledSeconds?: number
    now?: Date
  },
): Promise<{ session: InterviewSessionRow; settledUnits: number }> {
  const now = params.now ?? new Date()
  const session = await requireSession(transaction, principal, params.eventId)
  requireOwner(session, principal)
  requireVersion(session, params.expectedVersion)
  requireTransition(session.state, params.state)

  const billedSeconds = Math.max(0, Math.trunc(params.providerBilledSeconds ?? session.providerBilledSeconds))
  const settledUnits = await settleTranscription(transaction, principal, session.id, billedSeconds)

  const ended = await transitionSession(transaction, {
    organizationId: principal.organizationId,
    sessionId: session.id,
    expectedVersion: params.expectedVersion,
    state: params.state,
    // Required by `interview_sessions_finished_check` for every terminal state.
    finishedAt: now,
    providerBilledSeconds: billedSeconds,
  })
  return { session: ended, settledUnits }
}

/**
 * Settles or releases the session's reservation.
 *
 * Tolerant of a missing or already-closed reservation: a session may reach a terminal state without ever
 * having gone live, and a retried finish must not turn a settled reservation into an error that leaves
 * the session stuck in `live` forever. The billing row is the record either way — losing the transition
 * to protect a settlement that already happened would be the wrong trade.
 */
async function settleTranscription(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  sessionId: string,
  billedSeconds: number,
): Promise<number> {
  const reservationId = sessionReservationId(sessionId)
  if (billedSeconds <= 0) {
    await releaseReservation(transaction, principal, {
      reservationId,
      reason: 'nothing_transcribed',
      idempotencyKey: `interview-session:${sessionId}:release`,
    }).catch(ignoreClosedReservation)
    return 0
  }

  const units = estimateTranscriptionUnitsForSeconds(billedSeconds)
  await settleReservation(transaction, principal, {
    reservationId,
    actualUnits: units,
    idempotencyKey: `interview-session:${sessionId}:settle`,
  }).catch(ignoreClosedReservation)
  return units
}

function ignoreClosedReservation(error: unknown): void {
  // `ReservationError`, not `FeatureBillingError`: the feature-authorization layer only translates
  // `insufficient_credits`, so a missing or already-closed reservation arrives as the raw error from
  // `reservations.ts`. Catching the translated type instead would be a guard that never fires.
  //
  // `reservation_not_found` is a session that never went live; `invalid_state` is a retried close.
  // Anything else — an over-settlement, a vanished grant — is a real billing fault and must surface.
  if (error instanceof ReservationError && (error.code === 'reservation_not_found' || error.code === 'invalid_state')) {
    return
  }
  throw error
}

export interface HeartbeatResult {
  /** What the client must do next. `stop_now` is a withdrawal; the client has `hardStopMs` to comply. */
  action: 'continue' | 'stop_now' | 'not_live'
  hardStopMs: number
  session: InterviewSessionRow
  warnings: LowBalanceWarning[]
}

/**
 * A heartbeat, plus the two things that can stop a live session between beats.
 *
 * The hard-stop deadline is returned rather than hard-coded in the client, so the number lives in one
 * place. A participant may beat as well as the owner — watching a session is what their access is for,
 * and the beat only records that someone is still there.
 */
export async function heartbeat(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: { eventId: string; invitationId: string; reservedUnits?: number; now?: Date },
): Promise<HeartbeatResult> {
  const now = params.now ?? new Date()
  const session = await requireSession(transaction, principal, params.eventId)

  if (session.ownerUserId === principal.userId) {
    // Only the owner's client is capturing, so only the owner's beat is evidence the capture is alive. A
    // participant's open tab must not keep a dead session out of reclaim.
    await touchSessionHeartbeat(transaction, {
      organizationId: principal.organizationId,
      sessionId: session.id,
      at: now,
    })
  }

  if (session.state !== 'live') {
    return { action: 'not_live', hardStopMs: WITHDRAWAL_HARD_STOP_MS, session, warnings: [] }
  }

  const consent = await readTranscriptionConsent(transaction, {
    organizationId: principal.organizationId,
    invitationId: params.invitationId,
  })
  // Re-read every beat. A cached boolean cannot become false, and this is the path a mid-interview
  // withdrawal travels.
  if (!consent.granted) {
    return { action: 'stop_now', hardStopMs: WITHDRAWAL_HARD_STOP_MS, session, warnings: [] }
  }

  const elapsedSeconds = session.startedAt ? Math.max(0, (now.getTime() - session.startedAt.getTime()) / 1000) : 0
  return {
    action: 'continue',
    hardStopMs: WITHDRAWAL_HARD_STOP_MS,
    session,
    warnings: params.reservedUnits === undefined
      ? []
      : lowBalanceWarningsForSession({ reservedUnits: params.reservedUnits, elapsedSeconds }),
  }
}

/** Whether a live session has gone quiet long enough to be reclaimed. */
export function isHeartbeatStale(session: InterviewSessionRow, now: Date): boolean {
  // Only a live session can be stale. A paused one is quiet on purpose, and reclaiming it would end an
  // interview during a break.
  if (session.state !== 'live') return false
  const last = session.heartbeatAt ?? session.startedAt
  // A live session with neither is stale by construction: nothing will ever make it less so.
  if (!last) return true
  return now.getTime() - last.getTime() > SESSION_HEARTBEAT_STALE_MS
}

/** Persists a batch of final segments. Refuses anything but a live session. */
export async function appendSegments(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: {
    eventId: string
    segments: ReadonlyArray<{
      providerSegmentId: string
      sequence: number
      speakerEstimate: string
      text: string
      startsMs: number
      endsMs: number
      confidence: number | null
    }>
    now?: Date
  },
): Promise<{ accepted: string[]; inserted: number }> {
  const session = await requireSession(transaction, principal, params.eventId)
  requireOwner(session, principal)

  // A paused or finished session must not accept segments: the first would record audio captured while
  // the organizer believed capture had stopped, and the second would extend a transcript after it was
  // handed to a report.
  if (session.state !== 'live') {
    throw new SessionServiceError(`session is ${session.state}, not live`, 'invalid_transition')
  }
  if (params.segments.length === 0) return { accepted: [], inserted: 0 }

  return insertTranscriptSegments(transaction, {
    organizationId: principal.organizationId,
    sessionId: session.id,
    retentionExpiresAt: retentionExpiry(params.now ?? new Date()),
    segments: params.segments,
  })
}

async function requireSession(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  eventId: string,
): Promise<InterviewSessionRow> {
  const session = await findSessionByEvent(transaction, {
    organizationId: principal.organizationId,
    eventId,
  })
  // Absent and not-visible give the same answer: RLS decided, and distinguishing them would tell a
  // caller that an interview exists which they cannot see.
  if (!session) throw new SessionServiceError('no session for this interview', 'not_found')
  return session
}
