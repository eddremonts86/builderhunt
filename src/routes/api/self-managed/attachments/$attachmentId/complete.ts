import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { withAccountSubjectContext } from '~/shared/lib/db/tenant-context'
import { getStorageProvider } from '~/lib/storage/provider'
import {
  DocumentValidationError,
  SELF_MANAGED_ATTACHMENT_POLICY,
  sha256Hex,
  validateDocument,
} from '~/lib/storage/document-validation'
import { completeAttachmentUploadSchema } from '~/shared/lib/self-managed/contracts'
import {
  findAwaitingUploadAttachment,
  markAttachmentUploaded,
  rejectAttachmentUploadOnCompletion,
} from '~/shared/lib/repositories/self-managed-attachments'

/**
 * Confirms that a self-managed attachment landed, and decides whether it is worth scanning
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## Every claim is checked against the bytes
 *
 * The presigned PUT cannot enforce size or content, so the `sha256` in this request is an assertion
 * about an object the server can go and read. `validateDocument` — under the self-managed policy —
 * checks the hash, the real length, the magic bytes and the structure. A mismatch rejects the
 * attachment with a code the owner can read; it never updates the record to match what was found.
 *
 * ## One role, unlike the candidate flow — and that is not a shortcut
 *
 * The candidate completion needs a second, worker-role UPDATE because the capability role holds no
 * UPDATE at all. Here the caller is the authenticated owner, `builderhunt_app` holds UPDATE, and the
 * `0175` owner policy already scopes the write to their own rows — the two-role dance would add a
 * privilege, not remove one.
 *
 * ## The synthesized filename
 *
 * This model stores no client filename, by design — the spec forbids names in keys, and a name
 * nobody renders is PII retained for nothing. The shared validator still checks extension-vs-type,
 * so the name it sees is synthesized from the declared type's own extension. Nothing is lost: the
 * declared type is exactly what the magic bytes are checked against.
 */
export const Route = createFileRoute('/api/self-managed/attachments/$attachmentId/complete')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id

          const parsed = completeAttachmentUploadSchema.safeParse(await request.json().catch(() => null))
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? 'invalid request' },
              { status: 400 },
            )
          }

          const attachment = await withAccountSubjectContext(ownerUserId, (transaction) =>
            findAwaitingUploadAttachment(transaction, { ownerUserId, attachmentId: params.attachmentId }))
          // One answer for absent, not yours, and already completed. Telling them apart would let a
          // caller learn that an attachment id exists on somebody else's profile.
          if (!attachment) return Response.json({ error: 'not_found' }, { status: 404 })

          const storage = getStorageProvider()

          const head = await storage.headObject({ key: attachment.storageKey })
          if (!head) {
            // The signed URL was issued but nothing was ever written, or it expired first. The
            // intent stays as it is so the owner can retry against the same attachment.
            return Response.json({ error: 'upload_missing' }, { status: 400 })
          }
          if (head.bytes === 0) {
            // A zero-byte PUT is nothing arriving with a success code. Treated like a missing
            // upload — and the empty object goes, because the rejection path records the measured
            // size and the schema rightly refuses a size of zero.
            await storage.deleteObject({ key: attachment.storageKey }).catch(() => undefined)
            return Response.json({ error: 'upload_missing' }, { status: 400 })
          }

          const object = await storage.readObject({ key: attachment.storageKey })
          const chunks: Uint8Array[] = []
          for await (const chunk of object.stream) chunks.push(chunk)
          const body = Buffer.concat(chunks)

          try {
            const validated = await validateDocument({
              originalName: synthesizedNameFor(attachment.declaredMediaType),
              declaredMediaType: attachment.declaredMediaType,
              // Checked against the object's real length, not the intent's declaration — the
              // declaration was only ever a quota estimate.
              declaredBytes: head.bytes,
              declaredSha256: parsed.data.sha256,
              body,
              policy: SELF_MANAGED_ATTACHMENT_POLICY,
            })

            const [updated] = await withAccountSubjectContext(ownerUserId, (transaction) =>
              markAttachmentUploaded(transaction, {
                attachmentId: attachment.id,
                sha256: validated.sha256,
                actualBytes: validated.bytes,
                detectedMediaType: validated.mediaType,
              }))
            // Lost a race with a concurrent completion. The other call did the work.
            if (!updated) return Response.json({ error: 'not_found' }, { status: 404 })

            return Response.json({ attachmentId: attachment.id, scanStatus: 'pending' })
          } catch (error) {
            if (!(error instanceof DocumentValidationError)) throw error

            // What was actually there, not what was claimed — the claim is what was just rejected.
            const computedSha256 = sha256Hex(body)
            await withAccountSubjectContext(ownerUserId, (transaction) =>
              rejectAttachmentUploadOnCompletion(transaction, {
                attachmentId: attachment.id,
                rejectionCode: error.code,
                computedSha256,
                actualBytes: head.bytes,
              }))
            await storage.deleteObject({ key: attachment.storageKey }).catch(() => undefined)

            return Response.json(
              { attachmentId: attachment.id, scanStatus: 'failed', rejectionCode: error.code },
              { status: 422 },
            )
          }
        } catch (error) {
          // Name only: a storage error message can carry a signed URL or an object key.
          console.error('self-managed attachment completion error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})

/** `attachment.png` for `image/png` — see the module comment for why the name is synthesized. */
function synthesizedNameFor(declaredMediaType: string): string {
  const extension = SELF_MANAGED_ATTACHMENT_POLICY.accepts[declaredMediaType]?.extensions[0] ?? ''
  return `attachment${extension}`
}
