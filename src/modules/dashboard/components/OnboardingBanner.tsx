import * as React from 'react'
import { Sparkles, X } from 'lucide-react'
import { Button, LinkButton } from '~/components/ui'

interface OnboardingStatus {
  step: number
  completed: boolean
  skipped: boolean
  eligible: boolean
  reason?: string
}

/**
 * A browser-local dismissal that overrides the server's model, deliberately left alone for now.
 *
 * The server allows three skips: `POST /api/onboarding/skip` increments `skippedCount`, and
 * `isEligibleForOnboarding` keeps returning true until it reaches `MAX_SKIPS`. So the product intends
 * this notice to come back twice more after a skip.
 *
 * This key silently prevents that. The effect below reads it *before* the fetch, so once dismissed in
 * a browser the banner never returns there, whatever the server says — client state overriding a
 * server rule, which is the same fragility Wave 6 removed from dashboard preferences.
 *
 * Not fixed here on purpose. Removing the key makes the product naggier for every user who has
 * already dismissed it, and "should we remind twice more?" is a product decision rather than a bug
 * with one right answer. The real resolution is Wave 2's: this banner folds into the action queue,
 * whose dismissals are server-backed by construction, and the key goes away with the component.
 */
const DISMISS_KEY = 'bh_onboarding_banner_dismissed'

export function OnboardingBanner() {
  const [status, setStatus] = React.useState<OnboardingStatus | null>(null)
  const [dismissed, setDismissed] = React.useState<boolean>(false)

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
      className="card p-4 flex items-center gap-3 border-bh-accent/30 bg-bh-accent-soft/20"
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
        <LinkButton
          to="/onboarding/welcome"
          variant="primary"
          size="sm"
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
          data-testid="onboarding-banner-cta"
        >
          Start tour
        </LinkButton>
        {/*
          The accessible name has to be the *action*, not the gesture.
          It said "Dismiss" while the tooltip said "Skip onboarding" and the handler posted a real
          server-side skip counted against `MAX_SKIPS`. A sighted user hovered and learned the truth;
          a screen-reader user heard "Dismiss" and spent one of three skips. Same defect class as the
          Customize dialog's pin buttons: the name described the affordance instead of the effect.
        */}
        <Button
          variant="ghost"
          size="sm"
          onClick={skip}
          className="p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
          aria-label="Skip onboarding"
          title="Skip onboarding"
          data-testid="onboarding-banner-skip"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
