import * as React from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { Scale, X } from 'lucide-react'

interface ConsentStatus {
  userId: string | null
  consents: Record<string, string>
  required: Record<string, string>
  needsAcceptance: string[]
}

export function TosModal() {
  const [status, setStatus] = React.useState<ConsentStatus | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setMounted(true)
    fetch('/api/consent', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => setStatus(data))
      .catch(() => setStatus({ userId: null, consents: {}, required: { tos: 'v1.0' }, needsAcceptance: [] }))
  }, [])

  if (!mounted || !status) return null
  // Only block if user is signed in AND needs to accept TOS
  if (!status.userId) return null
  if (!status.needsAcceptance.includes('tos')) return null

  const accept = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/consent', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document: 'tos', version: status.required.tos }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStatus({ ...status, consents: { ...status.consents, tos: status.required.tos }, needsAcceptance: status.needsAcceptance.filter((d) => d !== 'tos') })
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tos-modal-title"
      data-testid="tos-modal"
    >
      <div className="card w-full max-w-lg p-6 relative">
        <button
          type="button"
          onClick={() => {/* can't dismiss without accepting */}}
          className="absolute top-3 right-3 p-1 text-bh-text-dim cursor-not-allowed opacity-30"
          aria-label="Close (disabled until accepted)"
          disabled
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-2 mb-3">
          <Scale className="w-5 h-5 text-bh-accent" aria-hidden="true" />
          <h2 id="tos-modal-title" className="text-lg font-semibold">Updated Terms of Service</h2>
        </div>

        <p className="text-sm text-bh-text-muted mb-4">
          We've updated our Terms of Service ({status.required.tos}). Please review and accept to continue using BuilderHunt.
        </p>

        <ul className="text-sm text-bh-text-muted space-y-1 mb-5 list-disc pl-5">
          <li>Be respectful to builders you discover</li>
          <li>No scraping or bulk harvesting</li>
          <li>You own your data, we own the platform</li>
          <li>30-day grace period on account deletion</li>
        </ul>

        <div className="flex flex-wrap gap-2 items-center">
          <Link to="/legal/terms" className="btn-ghost btn-sm" data-testid="tos-modal-read">
            Read full terms →
          </Link>
          <Link to="/legal/privacy" className="btn-ghost btn-sm" data-testid="tos-modal-privacy">
            Privacy policy
          </Link>
          <button
            type="button"
            onClick={accept}
            disabled={busy}
            className="btn-primary btn-sm ml-auto"
            data-testid="tos-modal-accept"
          >
            {busy ? 'Saving…' : 'Accept and continue'}
          </button>
        </div>

        {error && (
          <p className="text-xs text-bh-danger mt-3" role="alert">{error}</p>
        )}
      </div>
    </div>,
    document.body,
  )
}
