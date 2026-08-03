import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { getStorageProvider } from '~/lib/storage/provider'
import { isCleanKey } from '~/lib/storage/object-keys'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { findCleanDocumentForDownload } from '~/shared/lib/repositories/interview-documents'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'

/**
 * Issues a short-lived signed download for one scanned candidate document (plan:
 * calendar-scheduling-interview-intelligence, Phase 6).
 *
 * ## Why this path, and not `/api/interviews/:id/documents/...`
 *
 * The plan places this route under `/api/interviews/:interviewId/`, authorized for "owner or
 * participants". `interview_sessions` — and therefore any notion of a participant — arrives in
 * Phase 9; there is no interview resource to hang this off yet, and no participant set to check
 * against. Rather than invent one, this delivers the authority that *does* exist today: the
 * organizer who owns the invitation, proven the same way `candidate_documents_app_owner_all` proves
 * it in RLS. The participant-scoped variant belongs with the phase that creates participants, and is
 * an addition to this — not a replacement, since owner access is needed either way.
 *
 * ## Only clean documents have keys here
 *
 * `findCleanDocumentForDownload` filters on `scan_status = 'clean'` in the query, so there is no code
 * path that holds an unscanned document's key and then decides not to sign it. The prefix assertion
 * below is a second, independent statement of the same fact: promotion to `clean/` is the only way a
 * document becomes clean, so a clean row whose key is still under `quarantine/` means the two
 * disagree, and signing on either one alone would serve an unscanned file.
 *
 * ## Five minutes, and no filename
 *
 * spec.md: "issue a five-minute signed URL". The audit record names the document id and nothing else
 * — not the original filename, not the candidate's address. A download log that quietly accumulates
 * `maria-gonzalez-cv.pdf` is a log that has become personal data.
 */
const DOWNLOAD_TTL_SECONDS = 300

export const Route = createFileRoute('/api/scheduling/invitations/$invitationId/documents/$documentId/download')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request, params }) => {
        try {
          if (env.CANDIDATE_UPLOADS_ENABLED !== 'true') {
            return Response.json({ error: 'candidate_uploads_disabled' }, { status: 503 })
          }
          const principal = await requireTenantPrincipal(request)

          const document = await withTenantContext(principal, (transaction) =>
            findCleanDocumentForDownload(transaction, {
              organizationId: principal.organizationId,
              documentId: params.documentId,
            }))

          // One answer for absent, not-yours, and not-yet-scanned. Telling them apart would let an
          // organizer without access learn that a document id exists and is still processing.
          if (!document) {
            await emitSecurityAudit({
              organizationId: principal.organizationId,
              actorUserId: principal.userId,
              action: 'interview.document.download',
              targetType: 'candidate_document',
              targetId: params.documentId,
              result: 'denied',
              requestId: principal.requestId,
            }, consoleSecurityAuditSink)
            return Response.json({ error: 'not_found' }, { status: 404 })
          }

          if (!isCleanKey(document.objectKey)) {
            // The row says clean and the key says quarantined. That is a worker that moved the object
            // and failed to record it, or a record that was written without the move — either way the
            // two sources disagree about whether this file was scanned, and the only safe reading of
            // a disagreement is "not scanned".
            console.error('candidate document marked clean with a non-clean key:', params.documentId)
            return Response.json({ error: 'not_found' }, { status: 404 })
          }

          const signed = await getStorageProvider().createSignedDownloadUrl({
            key: document.objectKey,
            expiresInSeconds: DOWNLOAD_TTL_SECONDS,
          })

          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'interview.document.download',
            targetType: 'candidate_document',
            targetId: params.documentId,
            result: 'allowed',
            requestId: principal.requestId,
          }, consoleSecurityAuditSink)

          return Response.json({
            documentId: document.id,
            downloadUrl: signed.url,
            expiresAt: signed.expiresAt,
            // Display metadata, returned so the browser can name the saved file. It is not part of
            // the key and plays no part in authorization.
            originalName: document.originalName,
            mediaType: document.detectedMediaType,
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: 'forbidden' }, { status: 403 })
          }
          console.error('candidate document download error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
