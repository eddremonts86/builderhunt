import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import {
  changeSuggestionState,
  listRecordedSuggestions,
  recordSuggestionAction,
  suggestFollowups,
} from '~/lib/interviews/suggestion-service'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { briefContextForEvent } from '~/lib/interviews/brief-context'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { interviewFollowupSuggestionSchema } from '~/shared/lib/interviews'
import { rateLimit } from '~/shared/lib/rate-limit'
import { findSessionByEvent } from '~/shared/lib/repositories/interviews'
import { assertJsonRequest, assertSameOrigin, CrossOriginError } from '~/shared/lib/security/same-origin'

/**
 * Contextual follow-up questions (plan:
 * calendar-scheduling-interview-intelligence, Phase 10).
 *
 * ## `POST` asks, `PATCH` records, `GET` lists what was kept
 *
 * Asking is a `POST` because it spends a provider call, even though it writes nothing to this
 * organization's tables. A `GET` that consumed a completion would be prefetchable and retried by every
 * intermediary between the browser and here.
 *
 * ## The route never reports why a suggestion was refused
 *
 * The service degrades silently to the prepared questions and returns a `reason`. That reason reaches the
 * client so the panel can be quiet about it — a banner saying "the AI provider is unavailable" during an
 * interview helps nobody and is visible on a shared screen. The status stays 200 for every degradation,
 * because the client got something usable.
 *
 * The exceptions are the two the organizer can act on afterwards: a tier that does not include the feature
 * and a session that is not live. Both are still 200 with a reason, because interrupting an interview with
 * an error dialog is worse than a quiet fallback — the UI decides how loud to be.
 */

const actionSchema = z.object({
  action: z.enum(['used', 'saved', 'dismissed']),
  /** The ephemeral proposal being acted on. Absent for a suggestion already recorded. */
  suggestion: interviewFollowupSuggestionSchema.optional(),
  /** The stored row being moved between states. */
  suggestionId: z.string().uuid().optional(),
}).strict().refine(
  (body) => (body.suggestion === undefined) !== (body.suggestionId === undefined),
  { message: 'supply exactly one of suggestion or suggestionId', path: ['suggestion'] },
)

/** Well above the thirty-second service throttle, so this bounds a loop rather than shaping normal use. */
const SUGGESTION_LIMIT = 30
const SUGGESTION_WINDOW_SECONDS = 60

export const Route = createFileRoute('/api/interviews/$interviewId/suggestions')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const suggestions = await withTenantContext(principal, async (transaction) => {
            /*
             * Authorize before reading, even though RLS already decides *visibility*.
             *
             * RLS returning nothing became `200 {suggestions: []}`, which tells another tenant its
             * request was fine. The row filter and the status are different questions: the policy
             * protects the data, this protects the answer.
             */
            const context = await briefContextForEvent(transaction, principal, params.interviewId)
            if (!context) return 'not_found' as const
            const session = await findSessionByEvent(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
            })
            if (!session) return null
            // RLS decides visibility. `interview_suggestions` inherits through the session, so a granted
            // participant reads them and nobody else does.
            return listRecordedSuggestions(transaction, principal, session.id)
          })
          if (suggestions === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 })
          // A relationship but no session yet is a legitimate empty answer.
          if (!suggestions) return Response.json({ suggestions: [] }, { status: 200 })
          return Response.json({ suggestions: suggestions.map(toSuggestionDto) })
        } catch (error) {
          return errorResponse(error, 'interview suggestions read')
        }
      },

      POST: async ({ request, params }) => {
        try {
          assertSameOrigin(request)
          if (env.INTERVIEW_CONTEXTUAL_QUESTIONS_ENABLED !== 'true') {
            return Response.json({ error: 'contextual_questions_disabled' }, { status: 503 })
          }
          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit('interview-suggestions', principal.userId, SUGGESTION_LIMIT, SUGGESTION_WINDOW_SECONDS)
          if (!limit.allowed) {
            return Response.json({ error: 'rate_limited' }, {
              status: 429,
              headers: { 'retry-after': String(Math.ceil(limit.resetMs / 1000)) },
            })
          }

          const outcome = await withTenantContext(principal, async (transaction) => {
            const session = await findSessionByEvent(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
            })
            if (!session) return null
            if (session.ownerUserId !== principal.userId) return 'not_owner' as const
            return suggestFollowups(transaction, principal, { session })
          })

          if (outcome === null) return Response.json({ error: 'not_found' }, { status: 404 })
          if (outcome === 'not_owner') {
            // A granted participant reads the interview; they do not spend the organizer's provider calls.
            return Response.json({ error: 'not_owner' }, { status: 403 })
          }

          // 200 for every degradation. The client got something usable, and an error status during a live
          // interview would surface as a failure banner on a screen the candidate may be able to see.
          return Response.json({
            source: outcome.kind,
            suggestions: outcome.suggestions,
            ...(outcome.kind === 'prepared' ? { reason: outcome.reason } : {}),
            // Provenance, so the panel can say whether a model wrote these.
            ...(outcome.kind === 'suggested' ? { provider: outcome.provider, model: outcome.model } : {}),
          })
        } catch (error) {
          return errorResponse(error, 'interview suggestions generate')
        }
      },

      PATCH: async ({ request, params }) => {
        try {
          assertSameOrigin(request)
          assertJsonRequest(request)
          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit('interview-suggestions', principal.userId, SUGGESTION_LIMIT, SUGGESTION_WINDOW_SECONDS)
          if (!limit.allowed) return Response.json({ error: 'rate_limited' }, { status: 429 })

          const parsed = actionSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const outcome = await withTenantContext(principal, async (transaction) => {
            const session = await findSessionByEvent(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
            })
            if (!session) return { kind: 'not_found' as const }
            if (session.ownerUserId !== principal.userId) return { kind: 'not_owner' as const }

            if (parsed.data.suggestion) {
              const recorded = await recordSuggestionAction(transaction, principal, {
                session,
                suggestion: parsed.data.suggestion,
                action: parsed.data.action,
                retentionExpiresAt: new Date(Date.now() + env.INTERVIEW_TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60_000),
              })
              return { kind: 'ok' as const, ...recorded }
            }

            const changed = await changeSuggestionState(transaction, principal, {
              session,
              suggestionId: parsed.data.suggestionId!,
              action: parsed.data.action,
            })
            // A suggestion that was never recorded is the normal case for an ephemeral proposal, not an
            // error — but a client naming a *uuid* meant a stored row, so a miss here is a 404.
            return changed ? { kind: 'ok' as const, ...changed } : { kind: 'not_found' as const }
          })

          if (outcome.kind === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 })
          if (outcome.kind === 'not_owner') return Response.json({ error: 'not_owner' }, { status: 403 })
          return Response.json({ id: outcome.id, state: outcome.state })
        } catch (error) {
          return errorResponse(error, 'interview suggestion action')
        }
      },
    },
  },
})

/**
 * A recorded suggestion as a client sees it.
 *
 * `promptVersion` is included: a reader deciding whether a saved question is still relevant benefits from
 * knowing which prompt produced it, the same way a brief names its model.
 */
export function toSuggestionDto(row: {
  id: string
  sequence: number
  question: string
  rationale: string
  evidenceSegmentIds: string[]
  state: string
  promptVersion: string
  createdAt: Date
}) {
  return {
    id: row.id,
    sequence: row.sequence,
    question: row.question,
    rationale: row.rationale,
    evidenceSegmentIds: row.evidenceSegmentIds,
    state: row.state,
    promptVersion: row.promptVersion,
    createdAt: row.createdAt.toISOString(),
  }
}

function errorResponse(error: unknown, context: string): Response {
  if (error instanceof CrossOriginError) return Response.json({ error: 'bad_request' }, { status: 400 })
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: 'forbidden' }, { status: error.status })
  }
  console.error(`${context} error:`, (error as Error)?.name)
  return Response.json({ error: 'failed' }, { status: 500 })
}
