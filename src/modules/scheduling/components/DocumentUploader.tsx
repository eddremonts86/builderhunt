import { useCallback, useRef, useState } from 'react'
import { FileText, Loader2, ShieldAlert, ShieldCheck, Upload, X } from 'lucide-react'
import { Button } from '~/components/ui'

/**
 * Candidate-side document upload (plan: calendar-scheduling-interview-intelligence, Phase 6
 * "Add candidate links and intake UI").
 *
 * ## Three requests, and the middle one does not touch our server
 *
 * `POST /uploads` reserves a slot and returns a signed URL; the browser `PUT`s the bytes straight to
 * object storage; `POST .../complete` tells us it landed. The file never passes through the app,
 * which is the point — a 10 MB body through a request handler is a 10 MB body a request handler can
 * be made to hold.
 *
 * ## The hash is computed here and checked there
 *
 * `crypto.subtle.digest` over the file the user picked, sent with the completion call. It is not a
 * security boundary on its own — a client that lies simply gets rejected, because the server hashes
 * the object it actually received and compares. What it buys is that a *truncated* upload is caught
 * as a checksum mismatch instead of being scanned and stored as a valid short document.
 *
 * ## Status words, not spinner words
 *
 * `scanning` and `extracting` are shown as themselves rather than as one "processing". A candidate
 * whose file was refused needs to know it was refused *by a virus scan* — the alternative reading, that
 * we simply lost it, is the one that makes people re-upload the same file four times.
 *
 * Booking is deliberately not blocked on any of this. spec.md: documents may continue processing after
 * the slot is confirmed.
 */

export type DocumentStatus = 'pending_upload' | 'uploaded' | 'scanning' | 'extracting' | 'ready' | 'rejected' | 'failed'

export interface CandidateDocumentView {
  id: string
  originalName: string
  bytes: number
  status: DocumentStatus
  rejectionCode: string | null
}

/** Kept in step with `ACCEPTED_MEDIA_TYPES` in the uploads route; the server is authoritative. */
const ACCEPTED = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'text/plain': '.txt',
} as const

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 25 * 1024 * 1024

/**
 * Candidate-facing wording for a server rejection code.
 *
 * Every code gets a sentence a person can act on. The fallback is deliberately vague about *our*
 * internals and specific about what to do, because a code we forgot to map is our bug and the
 * candidate can still make progress.
 */
const REJECTION_COPY: Readonly<Record<string, string>> = {
  infected: 'Our virus scanner flagged this file. Please check it locally before trying again.',
  empty_file: 'That file is empty.',
  too_large: 'That file is over the 10 MB limit.',
  quota_exceeded: 'That would take you over the 25 MB total for this interview.',
  unsupported_media_type: 'Only PDF, DOCX and TXT files are accepted.',
  extension_mismatch: 'The file extension does not match its type.',
  media_type_mismatch: 'The contents do not match the file type.',
  size_mismatch: 'The upload did not complete. Please try again.',
  checksum_mismatch: 'The upload arrived damaged. Please try again.',
  encrypted_document: 'This document is password protected, so it cannot be read.',
  corrupt_document: 'This document could not be read.',
  archive_bomb: 'This document could not be read.',
  scan_unavailable: 'We could not scan this file. Please try again shortly.',
  promotion_failed: 'Something went wrong storing this file. Please try again.',
}

const STATUS_COPY: Readonly<Record<DocumentStatus, string>> = {
  pending_upload: 'Waiting for the upload to finish',
  uploaded: 'Uploaded — waiting to be scanned',
  scanning: 'Checking for viruses',
  extracting: 'Reading the text',
  ready: 'Ready',
  rejected: 'Not accepted',
  failed: 'Could not be processed',
}

export interface DocumentUploaderProps {
  invitationId: string
  documents: readonly CandidateDocumentView[]
  /** Refetches the status list. Called after a completed upload; polling is the parent's business. */
  onChanged: () => void
  disabled?: boolean
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function DocumentUploader({ invitationId, documents, onChanged, disabled = false }: DocumentUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Counted from what the server told us, not from what this session uploaded: a returning candidate
  // on a second device would otherwise see an empty allowance.
  const usedBytes = documents
    .filter((document) => document.status !== 'rejected' && document.status !== 'failed')
    .reduce((total, document) => total + document.bytes, 0)
  const remainingBytes = Math.max(0, MAX_TOTAL_BYTES - usedBytes)

  const upload = useCallback(async (file: File) => {
    setError(null)

    // Checked locally purely so the answer is immediate. The server checks all of it again, and its
    // answer is the one that counts.
    if (!(file.type in ACCEPTED)) {
      setError('Only PDF, DOCX and TXT files are accepted.')
      return
    }
    if (file.size === 0) {
      setError('That file is empty.')
      return
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setError('That file is over the 10 MB limit.')
      return
    }
    if (file.size > remainingBytes) {
      setError(`That would take you over the 25 MB total. You have ${Math.floor(remainingBytes / 1024 / 1024)} MB left.`)
      return
    }

    setBusy(true)
    try {
      const intentResponse = await fetch(`/api/public/scheduling/${invitationId}/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ originalName: file.name, declaredMediaType: file.type, bytes: file.size }),
      })
      if (!intentResponse.ok) {
        const body = await intentResponse.json().catch(() => ({}))
        setError(REJECTION_COPY[body?.reason] ?? 'We could not start that upload. Please try again.')
        return
      }
      const intent = await intentResponse.json() as { documentId: string; uploadUrl: string }

      // Straight to storage. A failure here leaves the reservation in place; it expires on its own and
      // the candidate can retry without being locked out of their allowance.
      const put = await fetch(intent.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      })
      if (!put.ok) {
        setError('The upload did not complete. Please try again.')
        return
      }

      const completion = await fetch(
        `/api/public/scheduling/${invitationId}/uploads/${intent.documentId}/complete`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sha256: await sha256Hex(file), bytes: file.size }),
        },
      )
      if (!completion.ok) {
        const body = await completion.json().catch(() => ({}))
        // A 422 here is a real verdict about the file, not a transport problem — the server read the
        // bytes and refused them. Showing the reason is the whole reason the row is kept.
        setError(REJECTION_COPY[body?.rejectionCode ?? body?.reason] ?? 'That file was not accepted.')
      }
      onChanged()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }, [invitationId, onChanged, remainingBytes])

  return (
    <section aria-labelledby="documents-heading" className="space-y-3">
      <h3 id="documents-heading" className="text-sm font-medium">Your CV and supporting documents</h3>
      <p className="text-muted-foreground text-xs">
        PDF, DOCX or TXT. Up to 10 MB each, 25 MB in total. You can book a time before these finish
        processing.
      </p>

      {documents.length > 0 && (
        <ul className="space-y-2">
          {documents.map((document) => (
            <li key={document.id} className="flex items-start gap-2 rounded-md border p-2 text-sm">
              {document.status === 'ready'
                ? <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                : document.status === 'rejected' || document.status === 'failed'
                  ? <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
                  : <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                {/* The candidate's own filename, shown back to them. It is display metadata only and
                    is never part of the object key. */}
                <p className="truncate font-medium">{document.originalName}</p>
                <p
                  className="text-muted-foreground text-xs"
                  // Announced, because the status changes without the candidate doing anything.
                  role="status"
                >
                  {STATUS_COPY[document.status]}
                  {document.rejectionCode !== null && (
                    <> — {REJECTION_COPY[document.rejectionCode] ?? 'This file was not accepted.'}</>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={Object.values(ACCEPTED).join(',')}
        className="sr-only"
        aria-label="Choose a document to upload"
        disabled={disabled || busy}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void upload(file)
        }}
      />
      <Button
        type="button"
        variant="secondary"
        disabled={disabled || busy || remainingBytes === 0}
        onClick={() => inputRef.current?.click()}
      >
        {busy
          ? <><Loader2 aria-hidden className="mr-2 size-4 animate-spin" />Uploading…</>
          : <><Upload aria-hidden className="mr-2 size-4" />Add a document</>}
      </Button>

      {remainingBytes === 0 && (
        <p className="text-muted-foreground text-xs">
          You have used the full 25 MB for this interview.
        </p>
      )}

      {error !== null && (
        <p role="alert" className="text-destructive flex items-start gap-1 text-xs">
          <X aria-hidden className="mt-0.5 size-3 shrink-0" />
          {error}
        </p>
      )}
    </section>
  )
}
