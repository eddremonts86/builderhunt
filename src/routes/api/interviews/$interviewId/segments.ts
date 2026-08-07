import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { appendSegments, SessionServiceError } from '~/lib/interviews/session-service'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { briefContextForEvent } from '~/lib/interviews/brief-context'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { SPEAKER_ESTIMATES } from '~/shared/lib/interviews'
import { rateLimit } from '~/shared/lib/rate-limit'
import {
  correctSegmentSpeaker,
  findSessionByEvent,
  InterviewBriefError,
  listSessionSegments,
} from '~/shared/lib/repositories/interviews'
import { assertJsonRequest, assertSameOrigin, CrossOriginError } from '~/shared/lib/security/same-origin'
import { interviewIdGuard } from '~/shared/lib/api/interview-id'

/**
 * Final transcript segments: read them, append a batch, correct a speaker (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## Text only, and the refusal is structural in three places
 *
 * `assertJsonRequest` rejects any body that is not `application/json` — so `audio/webm`,
 * `multipart/form-data` and `application/octet-stream` never reach a handler. The schema is `.strict()`,
 * so an `audio`, `blob` or `objectKey` field is refused as an unknown key. And there is no audio column in
 * `transcript_segments` to put one in even if both were bypassed. Three independent layers, because the
 * consent a candidate gave is for transient transcription and a stored recording would make it untrue.
 *
 * ## Exactly-once is the unique index, not a check in this handler
 *
 * `transcript_segments` is unique on `(organization_id, session_id, provider_segment_id)` and the insert is
 * `onConflictDoNothing`. A resend from the outbox therefore acknowledges without duplicating, and the
 * response distinguishes "accepted, already had it" from "accepted, new" — the outbox needs the first to
 * stop resending. A handler-side "have I seen this?" would be a second answer to a question the database
 * settles, and it would be wrong under concurrency.
 *
 * ## Sequences must rise within a batch, and gaps are allowed
 *
 * A batch whose sequences go backwards is a client bug — most likely two capture loops writing into one
 * outbox — and accepting it would produce a transcript that reads out of order. Gaps, on the other hand,
 * are normal: a silent final is dropped before it ever gets here, so the sequence a client assigns is not
 * dense.
 */

const MAX_BATCH_SEGMENTS = 50
/** About two minutes of continuous speech in one segment. A final segment is a sentence or two. */
const MAX_SEGMENT_TEXT_LENGTH = 2_000

const segmentSchema = z.object({
  providerSegmentId: z.string().min(1).max(200),
  sequence: z.number().int().min(0),
  speakerEstimate: z.enum(SPEAKER_ESTIMATES),
  text: z.string().min(1).max(MAX_SEGMENT_TEXT_LENGTH),
  startsMs: z.number().int().min(0),
  endsMs: z.number().int().min(1),
  confidence: z.number().min(0).max(1).nullable(),
}).strict().refine((segment) => segment.endsMs > segment.startsMs, {
  message: 'endsMs must be greater than startsMs',
  path: ['endsMs'],
})

const appendSchema = z.object({
  segments: z.array(segmentSchema).min(1).max(MAX_BATCH_SEGMENTS),
}).strict().superRefine((body, context) => {
  for (let index = 1; index < body.segments.length; index += 1) {
    if (body.segments[index].sequence <= body.segments[index - 1].sequence) {
      context.addIssue({
        code: 'custom',
        path: ['segments', index, 'sequence'],
        message: 'sequences must increase within a batch',
      })
      return
    }
  }
})

const correctionSchema = z.object({
  /** The stored row's id, which the client already has from a read. */
  segmentId: z.string().uuid(),
  /** What the organizer says this voice actually is. Only meaningful for in-person diarization. */
  speakerMapping: z.enum(['organizer', 'candidate_or_remote']),
}).strict()

/**
 * Sixty batches a minute per user, fifty segments each.
 *
 * A live client sends a batch every few seconds, so this is well above normal and still bounds a client
 * looping on a rejected send — the case that would otherwise fill a transcript table at wire speed.
 */
const SEGMENT_WRITE_LIMIT = 60
const SEGMENT_WRITE_WINDOW_SECONDS = 60

export const Route = createFileRoute('/api/interviews/$interviewId/segments')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST', 'PATCH']),

      GET: async ({ request, params }) => {
        const guard = interviewIdGuard(params.interviewId)
        if (guard) return guard
        try {
          const principal = await requireTenantPrincipal(request)
          const segments = await withTenantContext(principal, async (transaction) => {
            // Same as the suggestions read: RLS protects the rows, this protects the status. An empty
            // 200 to another tenant is an answer it should not get.
            const context = await briefContextForEvent(transaction, principal, params.interviewId)
            if (!context) return 'not_found' as const
            const session = await findSessionByEvent(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
            })
            if (!session) return null
            // RLS decides whether a participant sees these. Nothing here re-checks it: the policy allows
            // the owner and a granted participant SELECT, and a second answer in application code would
            // eventually disagree with the first.
            return listSessionSegments(transaction, {
              organizationId: principal.organizationId,
              sessionId: session.id,
            })
          })

          if (segments === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 })
          // A relationship but no session yet is a legitimate empty answer.
          if (!segments) return Response.json({ segments: [] }, { status: 200 })
          return Response.json({ segments: segments.map(toSegmentDto) })
        } catch (error) {
          return errorResponse(error, 'interview segments read')
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
            'interview-segments',
            principal.userId,
            SEGMENT_WRITE_LIMIT,
            SEGMENT_WRITE_WINDOW_SECONDS,
          )
          if (!limit.allowed) {
            return Response.json({ error: 'rate_limited' }, {
              status: 429,
              headers: { 'retry-after': String(Math.ceil(limit.resetMs / 1000)) },
            })
          }

          const parsed = appendSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const result = await withTenantContext(principal, (transaction) => appendSegments(
            transaction,
            principal,
            { eventId: params.interviewId, segments: parsed.data.segments },
          ))

          // No audit line. A batch arrives every few seconds for the length of an interview, and an audit
          // entry per batch would bury the events that matter — the transitions and the token mints — under
          // thousands of routine writes. The segments themselves are the record.
          return Response.json({ accepted: result.accepted, inserted: result.inserted })
        } catch (error) {
          return errorResponse(error, 'interview segments append')
        }
      },

      PATCH: async ({ request, params }) => {
        const guard = interviewIdGuard(params.interviewId)
        if (guard) return guard
        try {
          assertSameOrigin(request)
          assertJsonRequest(request)
          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit(
            'interview-segments',
            principal.userId,
            SEGMENT_WRITE_LIMIT,
            SEGMENT_WRITE_WINDOW_SECONDS,
          )
          if (!limit.allowed) {
            return Response.json({ error: 'rate_limited' }, { status: 429 })
          }

          const parsed = correctionSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const outcome = await withTenantContext(principal, async (transaction) => {
            const session = await findSessionByEvent(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
            })
            if (!session) return { kind: 'not_found' as const }
            // Only the owner corrects. A participant reading the transcript must not be able to relabel
            // who said what in someone else's interview.
            if (session.ownerUserId !== principal.userId) return { kind: 'not_owner' as const }

            const [corrected] = await correctSegmentSpeaker(transaction, {
              organizationId: principal.organizationId,
              sessionId: session.id,
              segmentId: parsed.data.segmentId,
              speakerMapping: parsed.data.speakerMapping,
              // The author, from the session — never from the request. A client that could name the
              // corrector could attribute a relabelling to a colleague who never made it.
              correctedByUserId: principal.userId,
              at: new Date(),
            })
            return corrected
              ? { kind: 'ok' as const, id: corrected.id, speakerMapping: parsed.data.speakerMapping }
              : { kind: 'not_found' as const }
          })

          if (outcome.kind === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 })
          if (outcome.kind === 'not_owner') return Response.json({ error: 'not_owner' }, { status: 403 })
          // The two fields that changed. The client already holds the text and timings, and re-sending a
          // candidate's words to acknowledge a label change moves them across the wire for nothing.
          return Response.json({ segment: { id: outcome.id, speakerMapping: outcome.speakerMapping } })
        } catch (error) {
          return errorResponse(error, 'interview segment correction')
        }
      },
    },
  },
})

/**
 * A segment as a client sees it.
 *
 * `retentionExpiresAt` is deliberately absent: it is a deletion schedule, not something a transcript
 * reader acts on, and shipping it invites a client to build its own idea of when text expires.
 */
export function toSegmentDto(segment: {
  id: string
  providerSegmentId: string
  sequence: number
  speakerEstimate: string
  speakerMapping: string | null
  text: string
  startsMs: number
  endsMs: number
  /** `numeric` in Postgres, so drizzle hands back a string. Coerced here rather than shipped as one. */
  confidence: string | number | null
}) {
  return {
    id: segment.id,
    providerSegmentId: segment.providerSegmentId,
    sequence: segment.sequence,
    speakerEstimate: segment.speakerEstimate,
    // Null until a human confirms or corrects it. A client must show the estimate as an estimate, and
    // collapsing the two fields here would remove its ability to say so.
    speakerMapping: segment.speakerMapping,
    text: segment.text,
    startsMs: segment.startsMs,
    endsMs: segment.endsMs,
    confidence: segment.confidence === null ? null : Number(segment.confidence),
  }
}

function errorResponse(error: unknown, context: string): Response {
  if (error instanceof CrossOriginError) {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: 'forbidden' }, { status: error.status })
  }
  if (error instanceof InterviewBriefError && error.code === 'version_conflict') {
    return Response.json({ error: 'version_conflict' }, { status: 409 })
  }
  if (error instanceof SessionServiceError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'not_owner' ? 403 : 409
    return Response.json({ error: error.code }, { status })
  }
  console.error(`${context} error:`, (error as Error)?.name)
  return Response.json({ error: 'failed' }, { status: 500 })
}
