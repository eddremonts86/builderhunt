import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { selfManagedDisabledResponse } from '~/shared/lib/self-managed/feature-flag'
import { withAccountSubjectContext } from '~/shared/lib/db/tenant-context'
import { getStorageProvider } from '~/lib/storage/provider'
import { isCleanKey } from '~/lib/storage/object-keys'
import { findCleanAttachmentForDownload } from '~/shared/lib/repositories/self-managed-attachments'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'

/**
 * Issues a short-lived signed download for one scanned attachment, to its owner
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * Owner-scoped on purpose: what a *stranger* may fetch from a public profile is the public-API
 * task's problem, and it starts from the public projection, not from this route.
 *
 * ## Only clean attachments have keys here
 *
 * `findCleanAttachmentForDownload` filters on `scan_status = 'clean'` in the query, so no code path
 * holds an unscanned attachment's key and then decides not to sign it. The prefix assertion below
 * is a second, independent statement of the same fact — a clean row whose key still says
 * `quarantine/` means the two disagree, and the only safe reading of a disagreement is "not
 * scanned".
 *
 * ## Five minutes, and no tenant
 *
 * Same TTL as the candidate download, from the spec. The audit rows carry `organizationId: null`
 * because a self-managed profile has no tenant — the actor and the attachment id are the whole
 * story, and a filename would turn the log into personal data.
 */
const DOWNLOAD_TTL_SECONDS = 300

export const Route = createFileRoute('/api/self-managed/attachments/$attachmentId/download')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request, params }) => {
        try {
          const disabled = selfManagedDisabledResponse()
          if (disabled) return disabled
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id
          const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()

          const attachment = await withAccountSubjectContext(ownerUserId, (transaction) =>
            findCleanAttachmentForDownload(transaction, { ownerUserId, attachmentId: params.attachmentId }))

          // One answer for absent, not yours, and not-yet-scanned. Telling them apart would let a
          // caller learn that an attachment id exists and is still processing.
          if (!attachment) {
            await emitSecurityAudit({
              organizationId: null,
              actorUserId: ownerUserId,
              action: 'self-managed.attachment.download',
              targetType: 'self_managed_attachment',
              targetId: params.attachmentId,
              result: 'denied',
              requestId,
            }, consoleSecurityAuditSink)
            return Response.json({ error: 'not_found' }, { status: 404 })
          }

          if (!isCleanKey(attachment.storageKey)) {
            // The row says clean and the key says quarantined — a worker that moved the object and
            // failed to record it, or a record written without the move. Either way the two sources
            // disagree about whether this file was scanned, and a disagreement reads as "not scanned".
            console.error('self-managed attachment marked clean with a non-clean key:', params.attachmentId)
            return Response.json({ error: 'not_found' }, { status: 404 })
          }

          const signed = await getStorageProvider().createSignedDownloadUrl({
            key: attachment.storageKey,
            expiresInSeconds: DOWNLOAD_TTL_SECONDS,
          })

          await emitSecurityAudit({
            organizationId: null,
            actorUserId: ownerUserId,
            action: 'self-managed.attachment.download',
            targetType: 'self_managed_attachment',
            targetId: params.attachmentId,
            result: 'allowed',
            requestId,
          }, consoleSecurityAuditSink)

          return Response.json({
            attachmentId: attachment.id,
            downloadUrl: signed.url,
            expiresAt: signed.expiresAt,
            // Display metadata so the browser can name the saved file. Not part of the key, and no
            // part in authorization.
            title: attachment.title,
            mediaType: attachment.mimeType,
          })
        } catch (error) {
          console.error('self-managed attachment download error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
