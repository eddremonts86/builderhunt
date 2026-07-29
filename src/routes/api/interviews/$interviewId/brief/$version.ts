import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { BriefServiceError, editBrief } from '~/lib/interviews/brief-service'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { briefContextForEvent } from '~/lib/interviews/brief-context'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { interviewBriefContentSchema, sourceManifestEntrySchema } from '~/shared/lib/interviews'
import { activateBriefVersion, findBriefVersion, listBriefVersions } from '~/shared/lib/repositories/interviews'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import { toBriefDto } from './index'

/**
 * One version of a brief: read it, edit it, or accept it (plan:
 * calendar-scheduling-interview-intelligence, Phase 8).
 *
 * ## The manifest is not editable
 *
 * `PATCH` takes content only. An organizer correcting a sentence must not be able to add a source id to
 * the manifest, because the manifest is the record of what was *actually supplied and read* — editing it
 * would let a citation be made to point at something that was never in evidence, which is precisely what
 * the dangling-reference check exists to prevent. The stored manifest is re-supplied to the repository
 * from the row, so the citation check still runs against reality rather than against the request.
 *
 * ## `versions` is a separate read, not a spread of the row
 *
 * The list returns metadata only — version, status, who edited, provenance — and no content. A version
 * picker needs to know what exists; shipping every version's full assessment to render a dropdown would
 * put four copies of a candidate's evaluation in a browser that asked for a list.
 */

const patchBriefRequestSchema = z.object({
  content: interviewBriefContentSchema,
  /** Set `active` to accept this version as the one the interview will use. */
  status: z.enum(['draft', 'active']).optional(),
}).strict()

function parseVersion(raw: string): number | null {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

export const Route = createFileRoute('/api/interviews/$interviewId/brief/$version')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          /*
           * Authorize before touching the brief. `requireTenantPrincipal` proves the tenant, not a
           * relationship to *this* interview, so without this any colleague — or an organization
           * admin — could read a candidate's brief. `briefContextForEvent` answers null unless the
           * caller owns it or holds `event_participants.material_access_granted`, and null is reported as the
           * same 404 as a missing interview so the response cannot confirm one exists.
           */
          const authorized = await withTenantContext(principal, (transaction) =>
            briefContextForEvent(transaction, principal, params.interviewId))
          if (!authorized) return Response.json({ error: 'not_found' }, { status: 404 })

          // `versions` as a literal path segment: the list is a different resource from a version, and
          // giving it its own route file would duplicate every guard in this one.
          if (params.version === 'versions') {
            const rows = await withTenantContext(principal, (transaction) => listBriefVersions(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
            }))
            return Response.json({
              versions: rows.map((row) => ({
                version: row.version,
                status: row.status,
                provider: row.provider,
                model: row.model,
                promptVersion: row.promptVersion,
                editedByUserId: row.editedByUserId,
              })),
            })
          }

          const version = parseVersion(params.version)
          if (version === null) return Response.json({ error: 'invalid_input' }, { status: 400 })

          const brief = await withTenantContext(principal, (transaction) => findBriefVersion(transaction, {
            organizationId: principal.organizationId,
            eventId: params.interviewId,
            version,
          }))
          // Absent and not-permitted are the same answer, decided by RLS rather than by a check here.
          if (!brief) return Response.json({ error: 'not_found' }, { status: 404 })

          return Response.json({ brief: toBriefDto(brief) })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) return Response.json({ error: 'forbidden' }, { status: 403 })
          console.error('interview brief version read error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },

      PATCH: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const version = parseVersion(params.version)
          if (version === null) return Response.json({ error: 'invalid_input' }, { status: 400 })

          /*
           * Authorize before touching the brief. `requireTenantPrincipal` proves the tenant, not a
           * relationship to *this* interview, so without this any colleague — or an organization
           * admin — could read a candidate's brief. `briefContextForEvent` answers null unless the
           * caller owns it. A granted participant reads the brief but does not rewrite it, so this one
           * requires ownership. Reported as 404 rather than 403, as everywhere else here.
           */
          const authorized = await withTenantContext(principal, (transaction) =>
            briefContextForEvent(transaction, principal, params.interviewId))
          if (!authorized?.isOwner) return Response.json({ error: 'not_found' }, { status: 404 })

          const parsed = patchBriefRequestSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const result = await withTenantContext(principal, async (transaction) => {
            const existing = await findBriefVersion(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
              version,
            })
            if (!existing) return { kind: 'not_found' as const }

            return {
              kind: 'edited' as const,
              brief: await editBrief(transaction, principal, {
                eventId: params.interviewId,
                expectedVersion: version,
                content: parsed.data.content,
                // From the stored row, never from the request. The manifest records what was actually
                // supplied and read; letting an edit change it would let a citation be made to point at
                // something that was never in evidence.
                evidenceManifest: existing.evidenceManifest,
                status: parsed.data.status,
              }),
            }
          })

          if (result.kind === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 })

          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'interview.brief.edit',
            targetType: 'interview_brief',
            targetId: result.brief.id,
            result: 'allowed',
            requestId: principal.requestId,
            // Version and status only — never the edited text.
            details: { version: result.brief.version, status: result.brief.status },
          }, consoleSecurityAuditSink)

          return Response.json({ brief: toBriefDto(result.brief) })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) return Response.json({ error: 'forbidden' }, { status: 403 })
          if (error instanceof BriefServiceError) {
            return Response.json({ error: error.code }, { status: error.code === 'version_conflict' ? 409 : 403 })
          }
          if (error instanceof Error && error.name === 'InterviewBriefError') {
            // A dangling citation or invalid content. 422 rather than 400: the request was well-formed
            // JSON and the problem is what it says, which is a distinction the editor's error handling
            // depends on.
            return Response.json({ error: (error as { code?: string }).code ?? 'invalid_content' }, { status: 422 })
          }
          console.error('interview brief edit error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },

      POST: async ({ request, params }) => {
        // Accepting a draft as the active version. Separate from PATCH because it changes which brief the
        // interview uses without touching a word of its content, and conflating the two would make
        // "accept" indistinguishable from "save" in the audit trail.
        try {
          const principal = await requireTenantPrincipal(request)
          const version = parseVersion(params.version)
          if (version === null) return Response.json({ error: 'invalid_input' }, { status: 400 })

          /*
           * Authorize before touching the brief. `requireTenantPrincipal` proves the tenant, not a
           * relationship to *this* interview, so without this any colleague — or an organization
           * admin — could read a candidate's brief. `briefContextForEvent` answers null unless the
           * caller owns it. A granted participant reads the brief but does not rewrite it, so this one
           * requires ownership. Reported as 404 rather than 403, as everywhere else here.
           */
          const authorized = await withTenantContext(principal, (transaction) =>
            briefContextForEvent(transaction, principal, params.interviewId))
          if (!authorized?.isOwner) return Response.json({ error: 'not_found' }, { status: 404 })

          const brief = await withTenantContext(principal, (transaction) => activateBriefVersion(transaction, {
            organizationId: principal.organizationId,
            eventId: params.interviewId,
            version,
          }))

          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'interview.brief.activate',
            targetType: 'interview_brief',
            targetId: brief.id,
            result: 'allowed',
            requestId: principal.requestId,
            details: { version: brief.version },
          }, consoleSecurityAuditSink)

          return Response.json({ brief: toBriefDto(brief) })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) return Response.json({ error: 'forbidden' }, { status: 403 })
          if (error instanceof Error && error.name === 'InterviewBriefError') {
            return Response.json({ error: 'not_found' }, { status: 404 })
          }
          console.error('interview brief activate error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
