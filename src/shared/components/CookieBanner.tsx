import * as React from 'react'
import { Cookie, X, Settings } from 'lucide-react'
import { Button, Checkbox } from '~/components/ui'

const STORAGE_KEY = 'bh_cookie_consent'

interface ConsentState {
  essential: true // always true
  functional: boolean
  analytics: boolean
  decidedAt: string
}

function readConsent(): ConsentState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ConsentState
    if (typeof parsed?.decidedAt !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function writeConsent(c: ConsentState) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
  // Dispatch event so other components can react
  window.dispatchEvent(new CustomEvent('bh-cookie-consent-changed', { detail: c }))
}

export function CookieBanner() {
  const [visible, setVisible] = React.useState(false)
  const [showCustomize, setShowCustomize] = React.useState(false)
  const [functional, setFunctional] = React.useState(true)
  const [analytics, setAnalytics] = React.useState(false)

  React.useEffect(() => {
    const existing = readConsent()
    if (!existing) {
      setVisible(true)
    }
  }, [])

  const accept = (choice: { functional: boolean; analytics: boolean }) => {
    const consent: ConsentState = {
      essential: true,
      functional: choice.functional,
      analytics: choice.analytics,
      decidedAt: new Date().toISOString(),
    }
    writeConsent(consent)
    setVisible(false)
  }

  if (!visible) return null

  return (
    <>
      <div
        className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:max-w-md z-40 card border-bh-border/60 shadow-2xl p-4"
        role="dialog"
        aria-live="polite"
        aria-label="Cookie consent"
        data-testid="cookie-banner"
      >
        <div className="flex items-start gap-3 mb-3">
          <Cookie className="w-5 h-5 text-bh-accent shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <h2 className="font-semibold text-sm mb-1">We use cookies</h2>
            <p className="text-xs text-bh-text-muted">
              Essential cookies keep you signed in. Optional cookies are off by default — nothing leaves the app unless you say so.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setVisible(false)}
            className="ml-auto -mt-1 -mr-1 p-1 text-bh-text-dim hover:text-bh-text"
            aria-label="Dismiss"
            data-testid="cookie-banner-dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {showCustomize && (
          <div className="mb-3 space-y-2 p-3 rounded-lg bg-bh-bg-alt/40 border border-bh-border/50" data-testid="cookie-banner-customize">
            <label className="flex items-start gap-2 text-xs cursor-not-allowed">
              <Checkbox checked disabled className="mt-0.5" />
              <div>
                <span className="font-semibold text-bh-text">Essential</span>
                <p className="text-bh-text-muted">Session, auth, security — always on.</p>
              </div>
            </label>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <Checkbox
                checked={functional}
                onCheckedChange={(checked) => setFunctional(checked === true)}
                className="mt-0.5"
                data-testid="cookie-banner-functional"
              />
              <div>
                <span className="font-semibold text-bh-text">Functional</span>
                <p className="text-bh-text-muted">Onboarding state, claim tokens.</p>
              </div>
            </label>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <Checkbox
                checked={analytics}
                onCheckedChange={(checked) => setAnalytics(checked === true)}
                className="mt-0.5"
                data-testid="cookie-banner-analytics"
              />
              <div>
                <span className="font-semibold text-bh-text">Analytics</span>
                <p className="text-bh-text-muted">
                  Not currently in use — if enabled, would record only anonymous landing-page/signup
                  funnel events (no query text, no account data), never sold or shared. See our Cookie
                  Policy for the current status.
                </p>
              </div>
            </label>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => accept({ functional: true, analytics: true })}
            data-testid="cookie-banner-accept-all"
          >
            Accept all
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => accept({ functional: false, analytics: false })}
            data-testid="cookie-banner-essential"
          >
            Essential only
          </Button>
          {!showCustomize ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowCustomize(true)}
              data-testid="cookie-banner-customize-btn"
            >
              <Settings className="w-3 h-3" aria-hidden="true" />
              Customize
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => accept({ functional, analytics })}
              data-testid="cookie-banner-save-prefs"
            >
              Save preferences
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
