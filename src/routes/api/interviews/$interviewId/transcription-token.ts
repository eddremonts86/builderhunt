import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { briefContextForEvent } from '~/lib/interviews/brief-context'
import { assertTranscriptionAllowed, SessionServiceError } from '~/lib/interviews/session-service'
import { buildSessionConfig, createSessionToken, DeepgramError } from '~/lib/interviews/transcription/deepgram'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import type { InterviewCaptureMode, InterviewSupportedLanguage } from '~/shared/lib/interview-config'
import { rateLimit } from '~/shared/lib/rate-limit'
import { findSessionByEvent } from '~/shared/lib/repositories/interviews'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import { assertSameOrigin, CrossOriginError } from '~/shared/lib/security/same-origin'

/**
 * Mints a 30-second Deepgram EU grant for a live session (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## This endpoint is the enforcement point for a withdrawal
 *
 * A client that ignores the heartbeat's `stop_now` keeps its current socket for the remainder of a
 * 30-second grant and then cannot get another, because every reconnect comes back here and consent is
 * re-read. That is what makes the ten-second hard stop a guarantee rather than a request: the ceiling on
 * how long a non-cooperating client can keep transcribing is the grant's TTL, not the client's goodwill.
 *
 * ## Only the owner, and only while the session is live or ready
 *
 * A granted participant watches an interview; they do not open a capture socket. Two clients streaming
 * into one session would produce interleaved sequences nobody could reconcile and two provider bills for
 * one conversation.
 *
 * A paused session is refused for a different reason: the organizer has told the candidate that capture
 * has stopped, and a token issued during a pause is a socket that could contradict that.
 *
 * ## `POST`, not `GET`
 *
 * Minting a credential is a side effect. A `GET` would be prefetchable, loggable in a referrer chain, and
 * reachable cross-site without the origin check this route applies.
 */

/** Twenty grants a minute: a reconnect storm is bounded, a normal session asks for one or two. */
const TOKEN_LIMIT = 20
const TOKEN_WINDOW_SECONDS = 60

export const Route = createFileRoute('/api/interviews/$interviewId/transcription-token')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        try {
          assertSameOrigin(request)
          if (env.INTERVIEW_TRANSCRIPTION_ENABLED !== 'true') {
            return Response.json({ error: 'transcription_disabled' }, { status: 503 })
          }

          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit('interview-token', principal.userId, TOKEN_LIMIT, TOKEN_WINDOW_SECONDS)
          if (!limit.allowed) {
            return Response.json({ error: 'rate_limited' }, {
              status: 429,
              headers: { 'retry-after': String(Math.ceil(limit.resetMs / 1000)) },
            })
          }

          const gate = await withTenantContext(principal, async (transaction) => {
            const session = await findSessionByEvent(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
            })
            if (!session) return { kind: 'not_found' as const }
            if (session.ownerUserId !== principal.userId) return { kind: 'not_owner' as const }
            // `ready` as well as `live`: the client asks for a grant so it can connect, and the
            // connection is what makes the session live. Requiring `live` first would mean going live
            // before there was any socket to go live with.
            if (session.state !== 'live' && session.state !== 'ready') {
              return { kind: 'wrong_state' as const, state: session.state }
            }

            const context = await briefContextForEvent(transaction, principal, params.interviewId)
            if (!context) return { kind: 'not_found' as const }
            // Re-read, every single grant. This is the line a withdrawal has to cross.
            await assertTranscriptionAllowed(transaction, {
              organizationId: principal.organizationId,
              invitationId: context.invitationId,
            })

            return {
              kind: 'ok' as const,
              captureMode: session.captureMode as InterviewCaptureMode,
              language: session.language as InterviewSupportedLanguage,
              sessionId: session.id,
            }
          })

          if (gate.kind === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 })
          if (gate.kind === 'not_owner') return Response.json({ error: 'not_owner' }, { status: 403 })
          if (gate.kind === 'wrong_state') {
            return Response.json({ error: 'invalid_transition', state: gate.state }, { status: 409 })
          }

          const token = await createSessionToken()
          const config = buildSessionConfig({ captureMode: gate.captureMode, language: gate.language })

          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'interview.transcription_token.mint',
            targetType: 'interview_session',
            targetId: gate.sessionId,
            result: 'allowed',
            requestId: principal.requestId,
            // The capture mode and the TTL. Never the token — an audit sink is a log, and a log is the
            // last place a credential should be recoverable from, however short-lived.
            details: { captureMode: gate.captureMode, expiresInSeconds: token.expiresInSeconds },
          }, consoleSecurityAuditSink)

          return Response.json({
            accessToken: token.accessToken,
            expiresInSeconds: token.expiresInSeconds,
            url: token.url,
            parameters: config.parameters,
            channelLabels: config.channelLabels,
            diarize: config.diarize,
          }, {
            // A credential with a 30-second life must not sit in any cache, shared or private.
            headers: { 'cache-control': 'no-store' },
          })
        } catch (error) {
          if (error instanceof CrossOriginError) {
            return Response.json({ error: 'bad_request' }, { status: 400 })
          }
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: 'forbidden' }, { status: error.status })
          }
          if (error instanceof SessionServiceError) {
            // 409 for both consent cases: the client's response is the same — stop, and tell the
            // organizer why — and the two codes distinguish which sentence to show.
            return Response.json({ error: error.code }, { status: 409 })
          }
          if (error instanceof DeepgramError) {
            const status = error.code === 'not_configured' ? 503 : 502
            return Response.json({ error: error.code }, { status })
          }
          console.error('interview transcription token error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
