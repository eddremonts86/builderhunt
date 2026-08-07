import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { briefContextForEvent } from '~/lib/interviews/brief-context'
import {
  endSessionUnsuccessfully,
  finishSession,
  goLive,
  heartbeat,
  isHeartbeatStale,
  markSessionReady,
  pauseSession,
  readTranscriptionConsent,
  resumeSession,
  SessionServiceError,
  sessionReservationId,
  startSession,
  WITHDRAWAL_HARD_STOP_MS,
} from '~/lib/interviews/session-service'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { INTERVIEW_CAPTURE_CAPABILITIES } from '~/shared/lib/interview-config'
import { rateLimit } from '~/shared/lib/rate-limit'
import {
  findSessionByEvent,
  InterviewBriefError,
  type InterviewSessionRow,
} from '~/shared/lib/repositories/interviews'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import { assertJsonRequest, assertSameOrigin, CrossOriginError } from '~/shared/lib/security/same-origin'
import { interviewIdGuard } from '~/shared/lib/api/interview-id'

/**
 * The live interview session: read it, drive it, keep it alive (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## One route, one resource, several verbs on it
 *
 * `GET` reads the session — that is also the candidate-withdrawal poll, since `stopNow` comes back with
 * every read. `POST` carries an `action`, because create/ready/live/pause/resume/finish/heartbeat are all
 * transitions of the same row and giving each its own file would duplicate every guard seven times.
 *
 * ## No audio reaches this endpoint, structurally
 *
 * `assertJsonRequest` refuses any body that is not `application/json`, so `audio/webm`,
 * `multipart/form-data` and `application/octet-stream` are rejected before a handler runs. The action
 * schemas are `.strict()`, so an `audio` *field* is refused too. Neither is a filter that could be
 * widened by accident: the first rejects a content type and the second rejects an unknown key.
 *
 * ## Authorization is RLS plus one thing RLS cannot express
 *
 * `withTenantContext` pins the tenant and user, and `interview_sessions`' policies decide visibility: the
 * owner, or a colleague with `event_participants.material_access_granted = true`. What they cannot express is that
 * a granted participant may *read* and *heartbeat* but not transition — the policy allows a participant
 * only SELECT, so a transition would surface as an empty UPDATE rather than a refusal. The service names
 * it instead.
 *
 * An organization admin has no path here at all. Managing seats and billing is not reading what a
 * candidate said in an interview.
 */

const captureCapability = z.enum(INTERVIEW_CAPTURE_CAPABILITIES)

const createSchema = z.object({
  action: z.literal('create'),
  captureCapability,
  language: z.enum(['en', 'da']),
}).strict()

const versionedSchema = <T extends string>(action: T) => z.object({
  action: z.literal(action),
  /** The version the client believes it is acting on. A stale one is refused, not applied. */
  expectedVersion: z.number().int().positive(),
}).strict()

const finishSchema = z.object({
  action: z.literal('finish'),
  expectedVersion: z.number().int().positive(),
  /**
   * The provider's own billed duration. Bounded at three hours and a bit: this is a *client-supplied*
   * number that decides a charge, and an unbounded one would let a broken client bill an organization for
   * a year of audio. The reservation ceiling clamps the settlement regardless, so this bound is the second
   * line rather than the only one.
   */
  providerBilledSeconds: z.number().int().min(0).max(11_000),
  providerRequestId: z.string().min(1).max(200).nullable(),
}).strict()

const terminalSchema = z.object({
  action: z.enum(['fail', 'abandon']),
  expectedVersion: z.number().int().positive(),
  providerBilledSeconds: z.number().int().min(0).max(11_000).optional(),
}).strict()

/**
 * No `expectedVersion`, deliberately.
 *
 * A beat transitions nothing and does not bump the version — that is the whole point, since a version
 * that moved several times a minute would make every real transition fail with a spurious conflict.
 * Requiring one here would also mean a client whose version had drifted could not beat at all, and the
 * beat is what keeps a live session out of reclaim.
 */
const heartbeatSchema = z.object({ action: z.literal('heartbeat') }).strict()

const requestSchema = z.discriminatedUnion('action', [
  createSchema,
  versionedSchema('ready'),
  versionedSchema('live'),
  versionedSchema('pause'),
  versionedSchema('resume'),
  heartbeatSchema,
  finishSchema,
  terminalSchema,
])

/**
 * Sixty writes a minute per user.
 *
 * A heartbeat is expected roughly every fifteen seconds and a transition is a human pressing a button, so
 * this is far above any real client and still bounds a loop. Keyed on the user rather than the session: a
 * client stuck in a retry loop across several interviews is the case worth bounding.
 */
const SESSION_WRITE_LIMIT = 60
const SESSION_WRITE_WINDOW_SECONDS = 60

export const Route = createFileRoute('/api/interviews/$interviewId/session')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request, params }) => {
        const guard = interviewIdGuard(params.interviewId)
        if (guard) return guard
        try {
          const principal = await requireTenantPrincipal(request)
          const result = await withTenantContext(principal, async (transaction) => {
            // The context first: it is what says this event is an interview at all, and a session that
            // somehow existed without one still could not be transcribed.
            const context = await briefContextForEvent(transaction, principal, params.interviewId)
            if (!context) return null
            const session = await findSessionByEvent(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
            })
            const consent = await readTranscriptionConsent(transaction, {
              organizationId: principal.organizationId,
              invitationId: context.invitationId,
            })
            return { session, consent, context }
          })

          // Everything the workspace needs to render its preflight, in one round trip. Three requests for
          // the consent receipt, the booked modality and the session would each need the same tenant
          // context and the same RLS decision.
          if (!result) return Response.json({ error: 'not_found' }, { status: 404 })
          const bootstrap = {
            userId: principal.userId,
            captureMode: result.context.modality === 'in_person' ? 'in_person' : 'remote_call',
            // A booking carries no language of its own yet, so the deployment default stands until it does.
            language: 'en' as const,
            consent: result.consent.noticeVersion === null ? null : {
              purpose: 'live_audio_transcription',
              noticeVersion: result.consent.noticeVersion,
              // The real date from the ledger. A receipt showing the epoch would be worse than one showing
              // no date at all: it reads as a fact and is not one.
              decidedAt: (result.consent.decidedAt ?? new Date()).toISOString(),
              withdrawnAt: result.consent.withdrawnAt?.toISOString() ?? null,
            },
          }

          if (!result.session) return Response.json({ session: null, ...bootstrap }, { status: 200 })
          return Response.json({
            ...bootstrap,
            session: toSessionDto(result.session, principal.userId),
            // The withdrawal poll. Reported on every read so a client that is only listening still learns
            // it must stop, without a separate endpoint it might not be calling.
            //
            // A read, not a beat: `GET` is reachable cross-site without CSRF protection, and stamping
            // `heartbeat_at` from it would be a write wearing a read's verb — one that could keep a dead
            // session out of reclaim from any page on the internet. The beat is `POST action: 'heartbeat'`.
            stopNow: result.session.state === 'live' && result.consent?.granted === false,
            hardStopMs: WITHDRAWAL_HARD_STOP_MS,
            stale: isHeartbeatStale(result.session, new Date()),
          })
        } catch (error) {
          return errorResponse(error, 'interview session read')
        }
      },

      POST: async ({ request, params }) => {
        const guard = interviewIdGuard(params.interviewId)
        if (guard) return guard
        try {
          assertSameOrigin(request)
          assertJsonRequest(request)
          if (env.INTERVIEW_TRANSCRIPTION_ENABLED !== 'true') {
            return Response.json({ error: 'transcription_disabled' }, { status: 503 })
          }

          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit(
            'interview-session-write',
            principal.userId,
            SESSION_WRITE_LIMIT,
            SESSION_WRITE_WINDOW_SECONDS,
          )
          if (!limit.allowed) {
            return Response.json({ error: 'rate_limited' }, {
              status: 429,
              headers: { 'retry-after': String(Math.ceil(limit.resetMs / 1000)) },
            })
          }

          const parsed = requestSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }
          const body = parsed.data

          const outcome = await withTenantContext(principal, async (transaction) => {
            const context = await briefContextForEvent(transaction, principal, params.interviewId)
            // No invitation behind the event means this is a personal calendar entry, not an interview.
            // There is no candidate, so there is no consent, so there is nothing to transcribe.
            if (!context) return { kind: 'not_found' as const }
            /*
             * Writes are the owner's alone.
             *
             * A granted participant watches and reads; starting, pausing or finishing someone else's
             * interview is not theirs to do, and `finish` also settles credits. Same `not_found` as an
             * absent interview, so a colleague cannot distinguish "not allowed" from "does not exist".
             *
             * Found by the Phase 12 e2e: an ungranted colleague created a session and got a 200, because
             * the only check on this path was RLS and a developer's `DATABASE_URL` is the superuser.
             */
            if (!context.isOwner) return { kind: 'not_found' as const }
            const invitationId = context.invitationId

            switch (body.action) {
              case 'create': {
                const session = await startSession(transaction, principal, {
                  eventId: params.interviewId,
                  invitationId,
                  // From the booked modality, never from the request. A client that could choose this
                  // would choose `in_person` for a remote call and get diarization over a mixed stream.
                  captureMode: context.modality === 'in_person' ? 'in_person' : 'remote_call',
                  language: body.language,
                  captureCapability: body.captureCapability,
                })
                return { kind: 'ok' as const, session }
              }
              case 'ready':
                return {
                  kind: 'ok' as const,
                  session: await markSessionReady(transaction, principal, {
                    eventId: params.interviewId, invitationId, expectedVersion: body.expectedVersion,
                  }),
                }
              case 'live': {
                const live = await goLive(transaction, principal, {
                  eventId: params.interviewId, invitationId, expectedVersion: body.expectedVersion,
                })
                return { kind: 'live' as const, session: live.session, reservedUnits: live.reservedUnits }
              }
              case 'pause':
                return {
                  kind: 'ok' as const,
                  session: await pauseSession(transaction, principal, {
                    eventId: params.interviewId, expectedVersion: body.expectedVersion,
                  }),
                }
              case 'resume':
                return {
                  kind: 'ok' as const,
                  session: await resumeSession(transaction, principal, {
                    eventId: params.interviewId, invitationId, expectedVersion: body.expectedVersion,
                  }),
                }
              case 'heartbeat': {
                const beat = await heartbeat(transaction, principal, {
                  eventId: params.interviewId, invitationId,
                })
                return { kind: 'beat' as const, beat }
              }
              case 'finish': {
                const finished = await finishSession(transaction, principal, {
                  eventId: params.interviewId,
                  expectedVersion: body.expectedVersion,
                  providerBilledSeconds: body.providerBilledSeconds,
                  providerRequestId: body.providerRequestId,
                })
                return { kind: 'settled' as const, session: finished.session, settledUnits: finished.settledUnits }
              }
              case 'fail':
              case 'abandon': {
                const ended = await endSessionUnsuccessfully(transaction, principal, {
                  eventId: params.interviewId,
                  expectedVersion: body.expectedVersion,
                  state: body.action === 'fail' ? 'failed' : 'abandoned',
                  providerBilledSeconds: body.providerBilledSeconds,
                })
                return { kind: 'settled' as const, session: ended.session, settledUnits: ended.settledUnits }
              }
            }
          })

          if (outcome.kind === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 })

          if (outcome.kind !== 'beat') {
            await emitSecurityAudit({
              organizationId: principal.organizationId,
              actorUserId: principal.userId,
              action: `interview.session.${body.action}`,
              targetType: 'calendar_event',
              targetId: params.interviewId,
              result: 'allowed',
              requestId: principal.requestId,
              // The state and the action only. What was said in the interview, who the candidate is and
              // what the transcript contains have no business in an audit line.
              details: { state: outcome.session.state, version: outcome.session.version },
            }, consoleSecurityAuditSink)
          }

          if (outcome.kind === 'beat') {
            return Response.json({
              action: outcome.beat.action,
              hardStopMs: outcome.beat.hardStopMs,
              warnings: outcome.beat.warnings,
              session: toSessionDto(outcome.beat.session, principal.userId),
            })
          }

          return Response.json({
            session: toSessionDto(outcome.session, principal.userId),
            ...(outcome.kind === 'live'
              ? { reservationId: sessionReservationId(outcome.session.id), reservedUnits: outcome.reservedUnits }
              : {}),
            ...(outcome.kind === 'settled' ? { settledUnits: outcome.settledUnits } : {}),
          })
        } catch (error) {
          return errorResponse(error, 'interview session write')
        }
      },
    },
  },
})

/**
 * The session a client receives.
 *
 * An explicit field list, not a spread of the row. `retentionExpiresAt` and `ownerUserId` are internal,
 * and a spread would ship whatever column a future migration adds without anyone deciding to.
 */
export function toSessionDto(session: InterviewSessionRow, viewerUserId: string) {
  return {
    id: session.id,
    eventId: session.eventId,
    state: session.state,
    captureMode: session.captureMode,
    language: session.language,
    provider: session.provider,
    consentNoticeVersion: session.consentNoticeVersion,
    captureCapability: session.captureCapability,
    startedAt: session.startedAt?.toISOString() ?? null,
    pausedAt: session.pausedAt?.toISOString() ?? null,
    finishedAt: session.finishedAt?.toISOString() ?? null,
    heartbeatAt: session.heartbeatAt?.toISOString() ?? null,
    providerBilledSeconds: session.providerBilledSeconds,
    version: session.version,
    // Answered by the server so a client never infers it from a role string. A participant must not be
    // shown a finish button the API will refuse.
    canControl: session.ownerUserId === viewerUserId,
  }
}

/**
 * Maps a service failure to a status a client can act on.
 *
 * Deliberately several codes rather than one: a withdrawal needs a hard stop, a version conflict needs a
 * reload, insufficient credits needs a top-up and a missing tier needs an upgrade. Collapsing them into
 * "failed" would leave a client with no correct response to any of them.
 */
function errorResponse(error: unknown, context: string): Response {
  if (error instanceof CrossOriginError) {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: 'forbidden' }, { status: error.status })
  }
  if (error instanceof InterviewBriefError && error.code === 'version_conflict') {
    // `requireVersion` catches a stale client, but two requests that both read the same version race
    // into the UPDATE and only one can win. The loser must be told to reload, not handed a 500.
    return Response.json({ error: 'version_conflict' }, { status: 409 })
  }
  if (error instanceof SessionServiceError) {
    const status = {
      not_found: 404,
      not_owner: 403,
      consent_missing: 409,
      consent_withdrawn: 409,
      invalid_transition: 409,
      version_conflict: 409,
      insufficient_credits: 402,
      not_entitled: 403,
      transcription_disabled: 503,
    }[error.code]
    return Response.json({ error: error.code }, { status })
  }
  // The name only. A driver error message can carry parameter values, and these queries carry a
  // candidate's transcript.
  //
  // Under E2E_MODE the message and stack are forwarded instead, because the data is fixture data and
  // the name alone is undiagnosable: nine e2e failures reported `Error` and nothing else, and finding
  // the cause needed a temporary patch to this very line.
  if (process.env.E2E_MODE === 'true') {
    console.error(`${context} error (E2E_MODE, full detail):`, error)
  } else {
    console.error(`${context} error:`, (error as Error)?.name)
  }
  return Response.json({ error: 'failed' }, { status: 500 })
}
