import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { editReport, generateReport } from '~/lib/interviews/report-service'
import { briefContextForEvent } from '~/lib/interviews/brief-context'
import { requireTenantPrincipal } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { interviewReportContentSchema } from '~/shared/lib/interviews'
import { rateLimit } from '~/shared/lib/rate-limit'
import {
  findLatestReport,
  findReportVersion,
  findSessionByEvent,
  listReportVersions,
} from '~/shared/lib/repositories/interviews'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import { assertJsonRequest, assertSameOrigin } from '~/shared/lib/security/same-origin'
// Outside `src/routes` on purpose — see the note in that file. Exporting these from here put the postgres
// driver in the client bundle and killed every page.
import { errorResponse, toReportDto } from '~/lib/interviews/report-http'
import { interviewIdGuard } from '~/shared/lib/api/interview-id'

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
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST', 'PATCH']),

      GET: async ({ request, params }) => {
        const guard = interviewIdGuard(params.interviewId)
        if (guard) return guard
        try {
          const principal = await requireTenantPrincipal(request)
          const url = new URL(request.url)
          const requested = url.searchParams.get('version')

          const result = await withTenantContext(principal, async (transaction) => {
            /*
             * Authorize before reading. This route returned the report to any member of the
             * organization — the transcript of a candidate's interview — because membership was the
             * only check: `requireTenantPrincipal` proves the tenant, not a relationship to *this*
             * interview. An organization admin got it too.
             *
             * `briefContextForEvent` answers null unless the caller owns the interview or was
             * explicitly handed access (`event_participants.material_access_granted`), and null becomes the
             * same 404 as a missing interview so the response cannot confirm one exists.
             */
            const context = await briefContextForEvent(transaction, principal, params.interviewId)
            if (!context) return null
            const scope = { organizationId: principal.organizationId, eventId: params.interviewId }
            const versions = await listReportVersions(transaction, scope)
            if (requested === 'versions') return { kind: 'list' as const, versions }
            const report = requested === null
              ? await findLatestReport(transaction, scope)
              : await findReportVersion(transaction, { ...scope, version: Number(requested) })
            return { kind: 'one' as const, report, versions }
          })

          if (!result) return Response.json({ error: 'not_found' }, { status: 404 })
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
        const guard = interviewIdGuard(params.interviewId)
        if (guard) return guard
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
            /*
             * Writes are the owner's alone: a granted participant reads the material and does not
             * author it. Two different refusals, deliberately:
             *
             *   - no relationship at all -> `null` -> 404, so the response cannot confirm that an
             *     interview exists;
             *   - a granted participant -> 403, because they can already read it. Answering 404 to
             *     someone who just fetched the thing is a lie that reads as a bug.
             */
            const context = await briefContextForEvent(transaction, principal, params.interviewId)
            if (!context) return null
            if (!context.isOwner) return 'not_owner' as const
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
          if (outcome === 'not_owner') return Response.json({ error: 'not_owner' }, { status: 403 })
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
        const guard = interviewIdGuard(params.interviewId)
        if (guard) return guard
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
            /*
             * Writes are the owner's alone: a granted participant reads the material and does not
             * author it. Two different refusals, deliberately:
             *
             *   - no relationship at all -> `null` -> 404, so the response cannot confirm that an
             *     interview exists;
             *   - a granted participant -> 403, because they can already read it. Answering 404 to
             *     someone who just fetched the thing is a lie that reads as a bug.
             */
            const context = await briefContextForEvent(transaction, principal, params.interviewId)
            if (!context) return null
            if (!context.isOwner) return 'not_owner' as const
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
          if (report === 'not_owner') return Response.json({ error: 'not_owner' }, { status: 403 })
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
