import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { withAccountSubjectContext } from '~/shared/lib/db/tenant-context'
import { getStorageProvider } from '~/lib/storage/provider'
import { SELF_MANAGED_ATTACHMENT_POLICY } from '~/lib/storage/document-validation'
import { selfManagedQuarantineKeyFor } from '~/lib/storage/object-keys'
import { createAttachmentIntentSchema } from '~/shared/lib/self-managed/contracts'
import {
  createAttachmentUploadIntent,
  listOwnAttachments,
  SelfManagedAttachmentError,
  type SelfManagedAttachment,
} from '~/shared/lib/repositories/self-managed-attachments'

/**
 * Self-managed attachments: the owner's list, and the upload intent
 * (plan: phase-2/07-perfiles-autogestionados, "Expose upload intent, completion, download, and
 * deletion routes").
 *
 * ## The row is created here, not when the bytes arrive
 *
 * Same reservation contract as the candidate flow: issuing signed URLs without recording them
 * would let a client request a dozen intents, each seeing a free slot, and upload against all of
 * them. The row starts `awaiting_upload`, holds one of the twelve slots from this moment, and the
 * scan worker cannot touch it until completion has verified what was written.
 *
 * ## Account-subject, deliberately organization-free
 *
 * A self-managed profile belongs to a person, not a workspace, so the guard is the session and the
 * database context is `withAccountSubjectContext` — it sets `app.user_id` and nothing else, which
 * is exactly the identity the `0175` owner policies key on. Requiring a tenant principal here would
 * refuse a signed-in builder whose session has no active organization.
 *
 * ## What the responses deliberately do not contain
 *
 * No object key and no checksum, on any handler. The key is server-generated and is the only handle
 * to the bytes; the client needs only the signed URL. The DTO names its fields so a column added
 * later cannot leak by default.
 */
export const Route = createFileRoute('/api/self-managed/attachments/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id

          const attachments = await withAccountSubjectContext(ownerUserId, (transaction) =>
            listOwnAttachments(transaction, ownerUserId))

          return Response.json({ attachments: attachments.map(toOwnerDto) })
        } catch (error) {
          console.error('self-managed attachments list error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },

      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id

          const parsed = createAttachmentIntentSchema.safeParse(await request.json().catch(() => null))
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? 'invalid request' },
              { status: 400 },
            )
          }

          // Decidable from the request alone, so refused before a transaction is opened. The policy
          // is the contract the completion call will verify the real bytes against.
          if (!(parsed.data.declaredMediaType in SELF_MANAGED_ATTACHMENT_POLICY.accepts)) {
            return Response.json({ error: 'unsupported_media_type' }, { status: 400 })
          }

          const intent = await withAccountSubjectContext(ownerUserId, (transaction) =>
            createAttachmentUploadIntent(transaction, {
              ownerUserId,
              attachment: {
                kind: parsed.data.kind,
                title: parsed.data.title,
                description: parsed.data.description ?? null,
              },
              declaredMediaType: parsed.data.declaredMediaType,
              declaredBytes: parsed.data.declaredBytes,
              keyFor: ({ profileId, attachmentId }) =>
                selfManagedQuarantineKeyFor({ ownerUserId, profileId, attachmentId }),
            }))

          // Signed outside the transaction, like the candidate flow: if signing throws, the row is
          // already committed — an unused intent the abandoned sweep expires — rather than a
          // rolled-back reservation that quietly consumed a slot.
          const signed = await getStorageProvider().createSignedUploadUrl({
            key: intent.storageKey,
            contentType: parsed.data.declaredMediaType,
            maxBytes: parsed.data.declaredBytes,
          })

          return Response.json({
            attachmentId: intent.id,
            uploadUrl: signed.url,
            expiresAt: signed.expiresAt,
          })
        } catch (error) {
          if (error instanceof SelfManagedAttachmentError) return refusalResponse(error)
          // Name only. A storage error message can carry a signed URL or an object key.
          console.error('self-managed attachment intent error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})

/** The owner's view of a row. Named fields, so a column added later cannot leak by default. */
function toOwnerDto(attachment: SelfManagedAttachment) {
  return {
    id: attachment.id,
    kind: attachment.kind,
    title: attachment.title,
    description: attachment.description,
    mediaType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    durationSeconds: attachment.durationSeconds,
    scanStatus: attachment.scanStatus,
    // The owner may read why a scan refused; a public projection never includes this.
    rejectionCode: attachment.rejectionCode,
    uploadedAt: attachment.uploadedAt.toISOString(),
  }
}

/** The refusals the repository names, mapped to statuses a client can act on. */
function refusalResponse(error: SelfManagedAttachmentError): Response {
  const status =
    error.code === 'no-profile' || error.code === 'not-found' ? 404
    : error.code === 'too-large' ? 413
    : 409
  return Response.json({ error: error.code }, { status })
}
