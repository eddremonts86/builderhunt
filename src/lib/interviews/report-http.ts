import { ReportServiceError } from './report-service'
import { TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { CrossOriginError } from '~/shared/lib/security/same-origin'
import type { InterviewReportRow } from '~/shared/lib/repositories/interviews'

/**
 * The report routes' shared DTO and error mapping (plan:
 * calendar-scheduling-interview-intelligence, Phase 10).
 *
 * **This lives outside `src/routes` for a load-bearing reason.** These two functions started out exported
 * from `report.ts` so `finalize.ts` could reuse them, which broke the entire application: TanStack Start's
 * dev transform strips a route module's `server.handlers` and the imports only that block referenced — but
 * it cannot strip an *exported* symbol, so `errorResponse` kept `ReportServiceError` alive, which kept
 * `report-service` alive, which kept `feature-authorization` → the tenant repositories → `db/client` → the
 * `postgres` driver in the client bundle. `postgres` calls `Buffer.allocUnsafe` at module scope, so every
 * page threw `ReferenceError: Buffer is not defined` before any application code ran. The markup arrived
 * from SSR and nothing was interactive — no navigation, no theme toggle.
 *
 * The pre-existing `brief/index.ts` exports `toBriefDto` and is fine, because that function references
 * nothing but plain data. That is the actual rule: a route module may export a *pure* helper and must never
 * export one that reaches the server layer.
 *
 * `scripts/check-route-client-boundary.mjs` enforces this now, because the failure is invisible in a
 * type-check, a lint run, a unit test and a production build — all four passed while the app was dead.
 */

/**
 * The report a client receives.
 *
 * An explicit field list rather than a spread of the row: `ownerUserId` and `retentionExpiresAt` are
 * internal, and a spread would ship whatever column a future migration adds.
 */
export function toReportDto(report: InterviewReportRow) {
  return {
    id: report.id,
    eventId: report.eventId,
    version: report.version,
    status: report.status,
    content: report.content,
    // Needed to render a timestamp link, and it is the list every citation must resolve against — so a
    // reader can tell a resolvable citation from a broken one.
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
  // The name only. A driver error message can carry parameter values, and these queries carry a
  // candidate's transcript.
  console.error(`${context} error:`, (error as Error)?.name)
  return Response.json({ error: 'failed' }, { status: 500 })
}
