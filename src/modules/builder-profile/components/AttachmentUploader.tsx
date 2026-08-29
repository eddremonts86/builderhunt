import * as React from 'react'
import { Loader2, Upload, Trash2 } from 'lucide-react'

import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui'
import {
  MAX_ACTIVE_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  SELF_MANAGED_ATTACHMENT_KINDS,
  type SelfManagedAttachmentKind,
  type SelfManagedScanStatus,
} from '~/shared/lib/self-managed/contracts'

/**
 * Upload and manage a self-managed profile's attachments
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## Three calls, and the middle one does not touch the app
 *
 * Intent reserves a slot and returns a presigned PUT; the browser writes the bytes straight to
 * object storage; completion tells the server to go and verify what actually landed. That middle
 * step is the whole reason the flow has three parts — a 25 MB file never passes through the
 * application — and it is why the hash is computed here: the server checks the claim against the
 * bytes it reads back, so a wrong hash is a rejection rather than a corrupted file nobody notices.
 *
 * ## The states a person sees are the row's, not a spinner's
 *
 * `pending` and `scanning` both read as "checking" because the difference is the worker's lease and
 * means nothing to the owner. `failed` and `infected` are shown with their reason: a refusal the
 * owner cannot see is a refusal they cannot act on, and "nothing happened" is the one outcome that
 * teaches them nothing.
 */
export interface OwnerAttachment {
  id: string
  kind: SelfManagedAttachmentKind
  title: string
  description: string | null
  mediaType: string
  sizeBytes: number | null
  scanStatus: SelfManagedScanStatus
  rejectionCode: string | null
  uploadedAt: string
}

const ACCEPTED = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'video/mp4',
] as const

const STATUS_LABEL: Record<SelfManagedScanStatus, string> = {
  awaiting_upload: 'Waiting for the file',
  pending: 'Checking for viruses',
  scanning: 'Checking for viruses',
  clean: 'Published',
  infected: 'Refused — the scanner found malware',
  failed: 'Refused',
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function AttachmentUploader({
  attachments,
  onChanged,
}: {
  attachments: OwnerAttachment[]
  onChanged: () => void | Promise<void>
}) {
  const [kind, setKind] = React.useState<SelfManagedAttachmentKind>('work-sample')
  const [title, setTitle] = React.useState('')
  const [file, setFile] = React.useState<File | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)

  const liveCount = attachments.filter((a) => a.scanStatus !== 'failed' && a.scanStatus !== 'infected').length
  const full = liveCount >= MAX_ACTIVE_ATTACHMENTS

  const upload = async () => {
    if (!file || !title.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setMessage({ ok: false, text: `That file is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.` })
        return
      }

      const intentResponse = await fetch('/api/self-managed/attachments', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          title: title.trim(),
          declaredMediaType: file.type,
          declaredBytes: file.size,
        }),
      })
      if (!intentResponse.ok) {
        const body = await intentResponse.json().catch(() => ({}))
        setMessage({ ok: false, text: refusalText(body.error) })
        return
      }
      const { attachmentId, uploadUrl } = await intentResponse.json()

      const bytes = await file.arrayBuffer()
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: bytes,
      })
      if (!put.ok) {
        setMessage({ ok: false, text: 'The upload did not go through. Try again.' })
        return
      }

      const completion = await fetch(`/api/self-managed/attachments/${attachmentId}/complete`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256: await sha256Hex(bytes) }),
      })
      if (!completion.ok) {
        const body = await completion.json().catch(() => ({}))
        setMessage({
          ok: false,
          text: body.rejectionCode
            ? `That file was refused (${body.rejectionCode}).`
            : 'That file was refused.',
        })
        return
      }

      setTitle('')
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      setMessage({ ok: true, text: 'Uploaded. It appears on your profile once the virus check passes.' })
    } catch {
      setMessage({ ok: false, text: 'Something went wrong. Try again.' })
    } finally {
      setBusy(false)
      await onChanged()
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    try {
      await fetch(`/api/self-managed/attachments/${id}`, { method: 'DELETE', credentials: 'include' })
    } finally {
      setBusy(false)
      await onChanged()
    }
  }

  return (
    <section aria-labelledby="attachments-heading" className="rounded-2xl border border-bh-border bg-bh-surface p-6">
      <h2 id="attachments-heading" className="text-lg font-semibold text-bh-text">Work samples</h2>
      <p className="mt-1 text-sm text-bh-text-muted">
        {liveCount} of {MAX_ACTIVE_ATTACHMENTS} used. PDF, images, audio or MP4, up to{' '}
        {MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB each.
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-[10rem_1fr]">
        <div>
          <label htmlFor="attachment-kind" className="block text-sm font-medium text-bh-text">Kind</label>
          <select
            id="attachment-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as SelfManagedAttachmentKind)}
            className="mt-1 w-full rounded-lg border border-bh-border bg-bh-surface px-3 py-2 text-sm text-bh-text"
          >
            {SELF_MANAGED_ATTACHMENT_KINDS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="attachment-title" className="block text-sm font-medium text-bh-text">Title</label>
          <Input
            id="attachment-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What is this?"
            className="mt-1"
          />
        </div>
      </div>

      <div className="mt-3">
        <label htmlFor="attachment-file" className="block text-sm font-medium text-bh-text">File</label>
        <input
          id="attachment-file"
          ref={fileInput}
          type="file"
          accept={ACCEPTED.join(',')}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm text-bh-text-muted"
        />
      </div>

      <Button
        type="button"
        onClick={upload}
        disabled={busy || full || !file || !title.trim()}
        className="mt-4"
        data-testid="attachment-upload"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
        Upload
      </Button>
      {full && (
        <p className="mt-2 text-sm text-bh-text-muted">
          You have used all {MAX_ACTIVE_ATTACHMENTS} slots. Delete one to make room.
        </p>
      )}

      {/* Announced, because an upload result the screen reader never mentions is a result the
          keyboard user has to go hunting for. */}
      <p role="status" aria-live="polite" className="mt-2 text-sm text-bh-text-muted" data-testid="attachment-message">
        {message?.text ?? ''}
      </p>

      <ul className="mt-6 space-y-2" data-testid="owner-attachments">
        {attachments.map((attachment) => (
          <li
            key={attachment.id}
            className="flex items-start justify-between gap-4 rounded-xl border border-bh-border bg-bh-surface-2 p-3"
            data-testid="owner-attachment"
          >
            <div className="min-w-0">
              <p className="font-medium text-bh-text">{attachment.title}</p>
              <p className="mt-0.5 text-xs text-bh-text-muted" data-testid="attachment-status">
                {STATUS_LABEL[attachment.scanStatus]}
                {attachment.rejectionCode ? ` (${attachment.rejectionCode})` : ''}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => remove(attachment.id)}
              disabled={busy}
              aria-label={`Delete ${attachment.title}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The repository's refusal codes, as sentences the owner can act on. */
function refusalText(code: unknown): string {
  switch (code) {
    case 'no-profile': return 'Create your profile before attaching anything to it.'
    case 'too-many': return `A profile holds at most ${MAX_ACTIVE_ATTACHMENTS} attachments.`
    case 'cv-exists': return 'You already have a CV. Delete it before adding another.'
    case 'too-large': return `That file is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`
    case 'unsupported_media_type': return 'That file type is not accepted.'
    default: return 'That upload was refused.'
  }
}
