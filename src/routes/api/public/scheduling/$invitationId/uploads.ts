import { createFileRoute } from '@tanstack/react-router'
import {
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import { getStorageProvider } from '~/lib/storage/provider'
import {
  DOCX_MEDIA_TYPE,
  MAX_DOCUMENT_BYTES,
  MAX_INVITATION_BYTES,
  PDF_MEDIA_TYPE,
  TXT_MEDIA_TYPE,
} from '~/lib/storage/document-validation'
import { quarantineKeyFor } from '~/lib/storage/object-keys'
import { env } from '~/shared/lib/env'
import { createUploadIntentRequestSchema } from '~/shared/lib/interview-api'
import {
  createUploadIntent,
  sumSubmissionDocumentBytes,
} from '~/shared/lib/repositories/interview-documents'
import { findSubmissionByInvitation, listConsentsForInvitation } from '~/shared/lib/repositories/scheduling'

/**
 * Issues a signed upload URL for one candidate document (plan:
 * calendar-scheduling-interview-intelligence, Phase 6).
 *
 * ## The row is created here, not when the bytes arrive
 *
 * That is what makes the 25 MB invitation quota a *reservation* rather than a check. Handing out
 * signed URLs without recording them would let a client request a hundred intents — each one seeing
 * an empty allowance — and then upload against all of them. The row starts in `awaiting_upload`, so
 * the scan worker cannot pick it up before the completion call has confirmed what was written.
 *
 * ## Consent gates the URL, not just the UI
 *
 * `candidate_document_processing` is checked server-side before anything is signed. A candidate who
 * has not granted it must not be able to upload a CV by driving the API directly, and a URL already
 * issued is a URL that works — there is no later point at which refusing costs nothing.
 *
 * ## What the response deliberately does not contain
 *
 * No object key. The key is server-generated and is the only handle to the bytes; echoing it would
 * put it in browser history and client logs for no gain, since the client needs only the URL. The
 * `documentId` is enough to complete the upload.
 */

const ACCEPTED_MEDIA_TYPES: readonly string[] = [PDF_MEDIA_TYPE, DOCX_MEDIA_TYPE, TXT_MEDIA_TYPE]

/**
 * Matches `submission.ts`. Documents inherit the submission's horizon rather than getting their own:
 * a CV that outlived the identity it belongs to would be an orphan nobody is accountable for.
 */
const RETENTION_DAYS = 180

export const Route = createFileRoute('/api/public/scheduling/$invitationId/uploads')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, true)
        if (refused) return refused

        if (env.CANDIDATE_UPLOADS_ENABLED !== 'true') {
          return withPublicHeaders(publicError('invalid_input', { reason: 'uploads_disabled' }))
        }

        const parsed = createUploadIntentRequestSchema.safeParse(await request.json().catch(() => ({})))
        if (!parsed.success) return withPublicHeaders(publicError('invalid_input'))

        // Checked before a transaction is opened: these are decidable from the request alone, and a
        // rejected upload should not have cost a connection.
        if (!ACCEPTED_MEDIA_TYPES.includes(parsed.data.declaredMediaType)) {
          return withPublicHeaders(publicError('invalid_input', { reason: 'unsupported_media_type' }))
        }
        if (parsed.data.bytes > MAX_DOCUMENT_BYTES) {
          return withPublicHeaders(publicError('invalid_input', { reason: 'too_large' }))
        }

        try {
          const result = await withCapabilityRequest(request, params.invitationId, async ({ transaction, tenant }) => {
            const submission = await findSubmissionByInvitation(transaction, tenant.organizationId, tenant.invitationId)
            // No submission means the candidate has not given their details or consent yet. There is
            // nothing to attach a document to, and nothing that made storing one lawful.
            if (!submission) return { kind: 'no_submission' as const }

            const consents = await listConsentsForInvitation(transaction, tenant.organizationId, tenant.invitationId)
            const granted = consents.some((consent) =>
              consent.purpose === 'candidate_document_processing' && consent.decision === 'granted')
            if (!granted) return { kind: 'consent_missing' as const }

            const existingBytes = await sumSubmissionDocumentBytes(transaction, {
              organizationId: tenant.organizationId,
              submissionId: submission.id,
            })
            if (existingBytes + parsed.data.bytes > MAX_INVITATION_BYTES) {
              return { kind: 'quota_exceeded' as const, remainingBytes: Math.max(0, MAX_INVITATION_BYTES - existingBytes) }
            }

            const intent = await createUploadIntent(transaction, {
              organizationId: tenant.organizationId,
              submissionId: submission.id,
              originalName: parsed.data.originalName,
              declaredMediaType: parsed.data.declaredMediaType,
              declaredBytes: parsed.data.bytes,
              retentionExpiresAt: new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60_000),
              keyFor: (documentId) => quarantineKeyFor({
                organizationId: tenant.organizationId,
                submissionId: submission.id,
                documentId,
              }),
            })

            return { kind: 'created' as const, intent }
          })

          if (!result.ok || !result.value) return withPublicHeaders(publicError('invitation_unavailable'))
          if (result.value.kind === 'no_submission') {
            return withPublicHeaders(publicError('invalid_input', { reason: 'submission_required' }))
          }
          if (result.value.kind === 'consent_missing') {
            return withPublicHeaders(publicError('consent_required', { purpose: 'candidate_document_processing' }))
          }
          if (result.value.kind === 'quota_exceeded') {
            return withPublicHeaders(publicError('invalid_input', {
              reason: 'quota_exceeded',
              remainingBytes: result.value.remainingBytes,
            }))
          }

          // Signed outside the transaction. Signing is a local HMAC with no network call, but holding
          // a tenant transaction open across it buys nothing, and if the signing ever throws the row
          // is already committed — an unused intent that expires on its own, rather than a rolled-back
          // reservation that leaves the candidate's quota quietly consumed.
          const signed = await getStorageProvider().createSignedUploadUrl({
            key: result.value.intent.objectKey,
            contentType: parsed.data.declaredMediaType,
            maxBytes: parsed.data.bytes,
          })

          return withPublicHeaders(Response.json({
            documentId: result.value.intent.id,
            uploadUrl: signed.url,
            expiresAt: signed.expiresAt,
          }))
        } catch (error) {
          // Name only. A storage error message can carry a signed URL or an object key, and the
          // audit trail for this route must never contain a filename or an address.
          console.error('candidate upload intent error:', (error as Error)?.name)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
