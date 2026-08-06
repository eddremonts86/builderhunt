import * as React from 'react'
import { ShieldAlert, X } from 'lucide-react'
import { Button, Dialog, Input, Label } from '~/components/ui'

interface StepupStatus {
  stage: 'observe' | 'warned' | 'stepup' | 'throttled' | 'blocked'
  requiresStepUp: boolean
}

const DISMISS_KEY = 'bh_abuse_warning_dismissed_stage'

/**
 * Dashboard-wide enforcement-stage surface (abuse-and-usage-integrity plan, Phase 5's second
 * task). Framed as fairness, not accusation, per `spec.md`'s own language for the `warned` stage.
 * Fetches its own status (same zero-props, client-side-fetch pattern as `OnboardingBanner`/
 * `OnboardingBanner`) rather than threading it through route loaders, since this needs to
 * render on every dashboard page and those two banners establish that self-fetching is already
 * this codebase's convention for dashboard notices.
 *
 * `warned`: a dismissible (per-stage, not permanent — re-shown if the stage changes) banner.
 * `stepup`: a non-dismissible-by-navigation password challenge (`POST /api/me/stepup`) — dismissing
 * the dialog just re-shows it next load, since the requirement lives server-side
 * (`auth/stepup.ts`'s `bh_stepup` cookie), not in this component's state.
 * `throttled`/`blocked` have no UI surface here — `blocked` is already rejected at the request
 * layer (`tenant-principal.ts`), and `throttled` is a rate-limit concern, not a banner.
 */
export function AbuseWarningBanner() {
  const [status, setStatus] = React.useState<StepupStatus | null>(null)
  const [dismissedStage, setDismissedStage] = React.useState<string | null>(null)
  const [password, setPassword] = React.useState('')
  const [verifying, setVerifying] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(() => {
    fetch('/api/me/stepup', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) return null
        return r.json() as Promise<StepupStatus>
      })
      .then((s) => { if (s) setStatus(s) })
      .catch(() => {})
  }, [])

  React.useEffect(() => {
    try { setDismissedStage(sessionStorage.getItem(DISMISS_KEY)) } catch {}
    refresh()
  }, [refresh])

  if (!status) return null

  const dismissWarning = () => {
    try { sessionStorage.setItem(DISMISS_KEY, status.stage) } catch {}
    setDismissedStage(status.stage)
  }

  const submitStepUp = async (event: React.FormEvent) => {
    event.preventDefault()
    setVerifying(true)
    setError(null)
    try {
      const response = await fetch('/api/me/stepup', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        setError(typeof body.error === 'string' ? body.error : 'Verification failed')
        return
      }
      setPassword('')
      refresh()
    } finally {
      setVerifying(false)
    }
  }

  if (status.stage === 'stepup' && status.requiresStepUp) {
    return (
      <Dialog open onClose={() => {}} title="Please confirm it's you">
        <form onSubmit={submitStepUp} className="space-y-4" data-testid="stepup-dialog">
          <p className="text-sm text-bh-text-muted">
            We noticed some unusual activity on this account. Re-enter your password to continue —
            this is a routine check, not an accusation.
          </p>
          <div>
            <Label htmlFor="stepup-password">Password</Label>
            <Input
              id="stepup-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
              data-testid="stepup-password-input"
            />
          </div>
          {error && <p className="text-sm text-red-500" role="alert">{error}</p>}
          <Button type="submit" variant="primary" disabled={verifying || !password} data-testid="stepup-submit" className="w-full">
            {verifying ? 'Verifying…' : 'Confirm'}
          </Button>
        </form>
      </Dialog>
    )
  }

  if (status.stage !== 'warned' || dismissedStage === status.stage) return null

  return (
    <div
      className="card p-4 mb-6 flex items-center gap-3 border-amber-500/30 bg-amber-500/10"
      data-testid="abuse-warning-banner"
      role="status"
    >
      <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-bh-text">
          <span className="font-semibold">Just so you know:</span>{' '}
          <span className="text-bh-text-muted">
            we noticed some activity on this account we want to keep an eye on — no action needed
            right now, but usage may be reviewed.
          </span>
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={dismissWarning}
        className="p-1.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
        aria-label="Dismiss"
        data-testid="abuse-warning-banner-dismiss"
      >
        <X className="w-3.5 h-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}
