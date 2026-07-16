import * as React from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Sparkles, X } from 'lucide-react'

interface OnboardingStatus {
  step: number
  completed: boolean
  skipped: boolean
  eligible: boolean
  reason?: string
}

const DISMISS_KEY = 'bh_onboarding_banner_dismissed'

export function OnboardingBanner() {
  const [status, setStatus] = React.useState<OnboardingStatus | null>(null)
  const [dismissed, setDismissed] = React.useState<boolean>(false)
  const navigate = useNavigate()

  React.useEffect(() => {
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') {
        setDismissed(true)
        return
      }
    } catch {}
    fetch('/api/onboarding/status', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) return null
        return r.json() as Promise<OnboardingStatus>
      })
      .then((s) => {
        if (s) setStatus(s)
      })
      .catch(() => {})
  }, [])

  if (!status || !status.eligible || status.completed || dismissed) return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch {}
    setDismissed(true)
  }

  const skip = async () => {
    try {
      await fetch('/api/onboarding/skip', { method: 'POST', credentials: 'include' })
    } catch {}
    dismiss()
  }

  return (
    <div
      className="card p-4 mb-6 flex items-center gap-3 border-bh-accent/30 bg-bh-accent-soft/20"
      data-testid="onboarding-banner"
      role="status"
    >
      <Sparkles className="w-5 h-5 text-bh-accent shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-bh-text">
          <span className="font-semibold">First time here?</span>{' '}
          <span className="text-bh-text-muted">Take a 3-step tour to set up your first radar.</span>
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Link
          to="/onboarding/welcome"
          className="btn-primary btn-sm"
          data-testid="onboarding-banner-cta"
        >
          Start tour
        </Link>
        <button
          onClick={skip}
          className="btn-ghost btn-sm p-1.5"
          aria-label="Dismiss"
          title="Skip onboarding"
          data-testid="onboarding-banner-skip"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
