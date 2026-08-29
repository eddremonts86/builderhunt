import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { withAccountSubjectContext } from '~/shared/lib/db/tenant-context'
import {
  SelfManagedAttachmentError,
  softDeleteAttachment,
} from '~/shared/lib/repositories/self-managed-attachments'

/**
 * Deletes one self-managed attachment (plan: phase-2/07-perfiles-autogestionados).
 *
 * Soft delete: the row is marked and the bytes stay in object storage until the retention sweep,
 * because removing the object first and the row second means a crash in between leaves a row
 * pointing at nothing. Deleting releases the quota slot immediately — the counts only see live
 * rows — so "delete and re-upload" works without waiting for the sweep.
 */
export const Route = createFileRoute('/api/self-managed/attachments/$attachmentId/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['DELETE']),

      DELETE: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id

          const deleted = await withAccountSubjectContext(ownerUserId, (transaction) =>
            softDeleteAttachment(transaction, { ownerUserId, attachmentId: params.attachmentId }))

          // One answer for absent, not yours, and already deleted — an attachment id from somebody
          // else's profile must read exactly like one that never existed.
          if (!deleted) return Response.json({ error: 'not_found' }, { status: 404 })
          return Response.json({ deleted: true })
        } catch (error) {
          if (error instanceof SelfManagedAttachmentError && error.code === 'no-profile') {
            return Response.json({ error: 'not_found' }, { status: 404 })
          }
          console.error('self-managed attachment delete error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
