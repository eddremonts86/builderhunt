import * as React from 'react'
import { createPortal } from 'react-dom'
import { Scale, X } from 'lucide-react'
import { LinkButton } from '~/components/ui'

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
  const panelRef = React.useRef<HTMLDivElement>(null)
  const acceptRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    setMounted(true)
    fetch('/api/consent', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => setStatus(data))
      .catch(() => setStatus({ userId: null, consents: {}, required: { tos: 'v1.0' }, needsAcceptance: [] }))
  }, [])

  const isOpen = mounted && !!status && !!status.userId && status.needsAcceptance.includes('tos')

  // Hand-rolled focus contract (this modal deliberately isn't built on the
  // shared Radix-based `Dialog` because it must stay non-dismissible — no
  // Escape-to-close, no outside-click-to-close — which is the opposite of
  // that component's default). Mirrors what Radix gives the shared Dialog
  // for free: initial focus on the primary control, Tab/Shift+Tab contained
  // inside the panel, body scroll locked, and focus restored to whatever
  // was focused before the modal appeared once it closes.
  React.useEffect(() => {
    if (!isOpen) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    acceptRef.current?.focus()

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Isolate the rest of the page from assistive-tech navigation while this
    // mandatory modal blocks the app — `inert` removes it from both the tab
    // order and the accessibility tree, not just visually (the modal already
    // covers it visually via its own overlay).
    const mainContent = document.getElementById('main-content')
    const cookieBanner = document.querySelector<HTMLElement>('[data-testid="cookie-banner"]')
    mainContent?.setAttribute('inert', '')
    cookieBanner?.setAttribute('inert', '')

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      mainContent?.removeAttribute('inert')
      cookieBanner?.removeAttribute('inert')
      previouslyFocused?.focus?.()
    }
  }, [isOpen])

  if (!isOpen || !status) return null

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
      <div ref={panelRef} className="card w-full max-w-lg p-6 relative">
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
          <LinkButton to="/legal/terms" variant="ghost" size="sm" data-testid="tos-modal-read">
            Read full terms →
          </LinkButton>
          <LinkButton to="/legal/privacy" variant="ghost" size="sm" data-testid="tos-modal-privacy">
            Privacy policy
          </LinkButton>
          <button
            ref={acceptRef}
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
