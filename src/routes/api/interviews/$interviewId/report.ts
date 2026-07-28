import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { editReport, generateReport, ReportServiceError } from '~/lib/interviews/report-service'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { interviewReportContentSchema } from '~/shared/lib/interviews'
import { rateLimit } from '~/shared/lib/rate-limit'
import {
  findLatestReport,
  findReportVersion,
  findSessionByEvent,
  listReportVersions,
  type InterviewReportRow,
} from '~/shared/lib/repositories/interviews'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import { assertJsonRequest, assertSameOrigin, CrossOriginError } from '~/shared/lib/security/same-origin'

/**
 * The interview report: read it, generate it, edit it (plan:
 * calendar-scheduling-interview-intelligence, Phase 10).
 *
 * ## Generation is explicit about cost, and a failure is not free of consequence
 *
 * `creditConfirmation: true` is required. It is not security — a client can always send it — but five
 * credits should not be spent by a retried request nobody intended.
 *
 * A provider failure returns **201 with a template**, not an error: the interview happened and the
 * organizer needs somewhere to write it up. A *credit* failure returns 402, because a blank form handed to
 * someone whose balance ran out would hide the reason.
 *
 * ## The evidence list is never accepted from a request
 *
 * `PATCH` takes content only. An editable evidence list would let a citation be pointed at a segment that
 * was never in the transcript, which is precisely what the citation check exists to stop — and a report is
 * the artifact a hiring decision is argued from weeks later.
 */

const generateSchema = z.object({
  creditConfirmation: z.literal(true),
  /** Considered by the model in its own region, never merged into the transcript. */
  organizerNotes: z.string().max(20_000).nullable().optional(),
}).strict()

const editSchema = z.object({
  expectedVersion: z.number().int().positive(),
  content: interviewReportContentSchema,
}).strict()

const REPORT_LIMIT = 10
const REPORT_WINDOW_SECONDS = 60

export const Route = createFileRoute('/api/interviews/$interviewId/report')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const url = new URL(request.url)
          const requested = url.searchParams.get('version')

          const result = await withTenantContext(principal, async (transaction) => {
            const scope = { organizationId: principal.organizationId, eventId: params.interviewId }
            const versions = await listReportVersions(transaction, scope)
            if (requested === 'versions') return { kind: 'list' as const, versions }
            const report = requested === null
              ? await findLatestReport(transaction, scope)
              : await findReportVersion(transaction, { ...scope, version: Number(requested) })
            return { kind: 'one' as const, report, versions }
          })

          if (result.kind === 'list') {
            return Response.json({
              versions: result.versions.map((row) => ({
                version: row.version,
                status: row.status,
                provider: row.provider,
                model: row.model,
                editedByUserId: row.editedByUserId,
                finalizedAt: row.finalizedAt?.toISOString() ?? null,
                createdAt: row.createdAt.toISOString(),
              })),
            })
          }

          if (!result.report) return Response.json({ report: null, latestVersion: null }, { status: 200 })
          return Response.json({
            report: toReportDto(result.report),
            latestVersion: result.versions[0]?.version ?? result.report.version,
            // Answered by the server so a participant is never offered an edit the API refuses.
            canEdit: result.report.ownerUserId === principal.userId && result.report.status !== 'final',
          })
        } catch (error) {
          return errorResponse(error, 'interview report read')
        }
      },

      POST: async ({ request, params }) => {
        try {
          assertSameOrigin(request)
          assertJsonRequest(request)
          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit('interview-report', principal.userId, REPORT_LIMIT, REPORT_WINDOW_SECONDS)
          if (!limit.allowed) {
            return Response.json({ error: 'rate_limited' }, {
              status: 429,
              headers: { 'retry-after': String(Math.ceil(limit.resetMs / 1000)) },
            })
          }

          const parsed = generateSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const outcome = await withTenantContext(principal, async (transaction) => {
            const session = await findSessionByEvent(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
            })
            if (!session) return null
            return generateReport(transaction, principal, {
              session,
              organizerNotes: parsed.data.organizerNotes ?? null,
            })
          })

          if (!outcome) return Response.json({ error: 'not_found' }, { status: 404 })
          if (outcome.kind === 'no_transcript') {
            return Response.json({ error: 'no_transcript' }, { status: 409 })
          }

          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'interview.report.generate',
            targetType: 'calendar_event',
            targetId: params.interviewId,
            result: 'allowed',
            requestId: principal.requestId,
            // The outcome kind and the version. A report's content is an assessment of a named person and
            // has no business in an audit line.
            details: { outcome: outcome.kind, version: outcome.report.version },
          }, consoleSecurityAuditSink)

          return Response.json({
            report: toReportDto(outcome.report),
            source: outcome.kind,
            // Named plainly, so the client can say a template was produced rather than implying a model
            // wrote it.
            ...(outcome.kind === 'template' ? { fallbackReason: outcome.reason } : {}),
          }, { status: 201 })
        } catch (error) {
          return errorResponse(error, 'interview report generate')
        }
      },

      PATCH: async ({ request, params }) => {
        try {
          assertSameOrigin(request)
          assertJsonRequest(request)
          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit('interview-report', principal.userId, REPORT_LIMIT, REPORT_WINDOW_SECONDS)
          if (!limit.allowed) return Response.json({ error: 'rate_limited' }, { status: 429 })

          const parsed = editSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const report = await withTenantContext(principal, async (transaction) => {
            const session = await findSessionByEvent(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
            })
            if (!session) return null
            return editReport(transaction, principal, {
              session,
              expectedVersion: parsed.data.expectedVersion,
              content: parsed.data.content,
            })
          })

          if (!report) return Response.json({ error: 'not_found' }, { status: 404 })
          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'interview.report.edit',
            targetType: 'calendar_event',
            targetId: params.interviewId,
            result: 'allowed',
            requestId: principal.requestId,
            details: { version: report.version },
          }, consoleSecurityAuditSink)

          return Response.json({ report: toReportDto(report) })
        } catch (error) {
          return errorResponse(error, 'interview report edit')
        }
      },
    },
  },
})

/**
 * The report a client receives.
 *
 * `ownerUserId` and `retentionExpiresAt` are internal; `canEdit` above is the only thing that conveys
 * permission. A spread of the row would ship whatever column a future migration adds.
 */
export function toReportDto(report: InterviewReportRow) {
  return {
    id: report.id,
    eventId: report.eventId,
    version: report.version,
    status: report.status,
    content: report.content,
    // Needed by the client to render a timestamp link, and it is the list every citation must resolve
    // against — so a reader can tell a resolvable citation from a broken one.
    evidenceSegmentIds: report.evidenceSegmentIds,
    provider: report.provider,
    model: report.model,
    promptVersion: report.promptVersion,
    editedByUserId: report.editedByUserId,
    finalizedAt: report.finalizedAt?.toISOString() ?? null,
  }
}

/**
 * Maps a service failure to something the client can act on.
 *
 * `dangling_reference` gets its own 422 rather than a generic 400: the organizer's edit was well-formed and
 * the problem is one specific citation, which is a fixable and *nameable* thing rather than "invalid input".
 */
export function errorResponse(error: unknown, context: string): Response {
  if (error instanceof CrossOriginError) return Response.json({ error: 'bad_request' }, { status: 400 })
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: 'forbidden' }, { status: error.status })
  }
  if (error instanceof ReportServiceError) {
    const status = {
      not_found: 404,
      not_owner: 403,
      no_transcript: 409,
      insufficient_credits: 402,
      not_entitled: 403,
      version_conflict: 409,
      invalid_content: 400,
      dangling_reference: 422,
      already_final: 409,
    }[error.code]
    return Response.json({ error: error.code }, { status })
  }
  console.error(`${context} error:`, (error as Error)?.name)
  return Response.json({ error: 'failed' }, { status: 500 })
}
