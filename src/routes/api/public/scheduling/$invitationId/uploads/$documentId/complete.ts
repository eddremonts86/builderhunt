import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import {
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import { getStorageProvider } from '~/lib/storage/provider'
import { DocumentValidationError, sha256Hex, validateDocument } from '~/lib/storage/document-validation'
import { env } from '~/shared/lib/env'
import { completeUploadRequestSchema } from '~/shared/lib/interview-api'
import { deriveDocumentStatus } from '~/shared/lib/interviews'
import {
  findAwaitingUploadDocument,
  markDocumentUploaded,
  rejectUploadOnCompletion,
  withWorkerOrganization,
} from '~/shared/lib/repositories/interview-documents'
import { findSubmissionByInvitation } from '~/shared/lib/repositories/scheduling'

/**
 * Confirms that an upload landed, and decides whether it is worth scanning (plan:
 * calendar-scheduling-interview-intelligence, Phase 6).
 *
 * ## Everything the client says here is a claim, and every claim is checked
 *
 * The presigned PUT cannot enforce size or content, so `sha256` and `bytes` in this request are
 * assertions about bytes the server can go and read. `validateDocument` reads them and checks the
 * hash, the real length, the magic bytes, the extension, and the archive structure. A mismatch
 * rejects the document; it never updates the record to match what was found.
 *
 * ## Two roles, on purpose
 *
 * Authorization happens on the capability connection, which holds SELECT and INSERT on
 * `candidate_documents` and deliberately no UPDATE — 0085: "Capability writes go through a narrowly
 * privileged server command, never anonymous SQL grants". So the read that proves this document
 * belongs to *this* invitation's submission runs as the candidate, and the single scoped UPDATE that
 * follows runs as the worker. Granting UPDATE to the anonymous role instead would have been one line
 * and would have handed every capability holder write access to the whole table.
 *
 * ## Rejected, not deleted
 *
 * A validation failure keeps the row with a `rejectionCode`, because a candidate whose CV was refused
 * needs to know why — "nothing happened" is the one outcome they cannot act on. The object itself is
 * deleted: it failed validation, so nothing downstream will ever read it. Quota is released by the
 * rejection, so they can retry immediately.
 */
export const Route = createFileRoute('/api/public/scheduling/$invitationId/uploads/$documentId/complete')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, true)
        if (refused) return refused

        if (env.CANDIDATE_UPLOADS_ENABLED !== 'true') {
          return withPublicHeaders(publicError('invalid_input', { reason: 'uploads_disabled' }))
        }

        const parsed = completeUploadRequestSchema.safeParse(await request.json().catch(() => ({})))
        if (!parsed.success) return withPublicHeaders(publicError('invalid_input'))

        try {
          // Authorization only — no writes on this connection.
          const authorized = await withCapabilityRequest(request, params.invitationId, async ({ transaction, tenant }) => {
            const submission = await findSubmissionByInvitation(transaction, tenant.organizationId, tenant.invitationId)
            if (!submission) return null

            const document = await findAwaitingUploadDocument(transaction, {
              organizationId: tenant.organizationId,
              submissionId: submission.id,
              documentId: params.documentId,
            })
            if (!document) return null

            return { organizationId: tenant.organizationId, document }
          })

          // One answer for "no such document", "not yours", and "already completed". Distinguishing
          // them would tell a caller whether a document id exists in another candidate's submission.
          if (!authorized.ok || !authorized.value) {
            return withPublicHeaders(publicError('invitation_unavailable'))
          }

          const { organizationId, document } = authorized.value
          const storage = getStorageProvider()

          const head = await storage.headObject({ key: document.objectKey })
          if (!head) {
            // The signed URL was issued but nothing was ever written, or it expired first. The intent
            // stays as it is so the candidate can retry against the same document.
            return withPublicHeaders(publicError('invalid_input', { reason: 'upload_missing' }))
          }

          const object = await storage.readObject({ key: document.objectKey })
          const chunks: Uint8Array[] = []
          for await (const chunk of object.stream) chunks.push(chunk)
          const body = Buffer.concat(chunks)

          try {
            const validated = await validateDocument({
              originalName: document.originalName,
              declaredMediaType: document.declaredMediaType,
              // Checked against the object's real length, not the request's — a client that
              // misreports its own upload should fail on the bytes, not on its own arithmetic.
              declaredBytes: head.bytes,
              declaredSha256: parsed.data.sha256,
              body,
            })

            const [updated] = await withWorkerOrganization(organizationId, (transaction) => markDocumentUploaded(transaction, {
              organizationId,
              documentId: document.id,
              sha256: validated.sha256,
              actualBytes: validated.bytes,
              detectedMediaType: validated.mediaType,
            }))
            // Lost a race with a concurrent completion. The other call did the work.
            if (!updated) return withPublicHeaders(publicError('invitation_unavailable'))

            return withPublicHeaders(Response.json({
              documentId: document.id,
              status: deriveDocumentStatus({ scanStatus: 'pending', extractionStatus: 'pending' }),
            }))
          } catch (error) {
            if (!(error instanceof DocumentValidationError)) throw error

            // What was actually there. `validateDocument` throws before computing a hash on the
            // cheap structural checks, so this is computed here rather than assumed to exist.
            const computedSha256 = sha256Hex(body)
            await withWorkerOrganization(organizationId, (transaction) => rejectUploadOnCompletion(transaction, {
              organizationId,
              documentId: document.id,
              rejectionCode: error.code,
              computedSha256,
              actualBytes: head.bytes,
              detectedMediaType: null,
            }))
            await storage.deleteObject({ key: document.objectKey }).catch(() => undefined)

            return withPublicHeaders(Response.json({
              documentId: document.id,
              status: deriveDocumentStatus({ scanStatus: 'failed', extractionStatus: 'skipped' }),
              rejectionCode: error.code,
            }, { status: 422 }))
          }
        } catch (error) {
          // Name only: a storage error message can carry a signed URL or an object key.
          console.error('candidate upload completion error:', (error as Error)?.name)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
