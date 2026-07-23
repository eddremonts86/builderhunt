import * as React from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Clock, AlertTriangle, XCircle } from 'lucide-react'

/**
 * Shown after Stripe redirects back from Checkout (plans/stripe-billing-platform/tasks.md §5
 * "Build pending Checkout return experience"). Deliberately reads NOTHING from the URL — no
 * `location.search`, no `useSearch()` — the entire state comes from polling
 * `GET /api/billing/checkout/status`, which itself derives the answer from the authenticated
 * session's own organization state (see `getCheckoutReturnStatus`). A forged `?status=success` (or
 * any other query parameter) therefore has zero effect: this component never looks at it.
 */

export type CheckoutReturnState = 'no_attempt' | 'pending' | 'succeeded' | 'failed' | 'expired'

interface CheckoutStatusResponse {
  state: CheckoutReturnState
}

const POLL_INTERVAL_MS = 3000
const TERMINAL_STATES: ReadonlySet<CheckoutReturnState> = new Set(['succeeded', 'failed', 'expired', 'no_attempt'])

async function fetchCheckoutStatus(): Promise<CheckoutStatusResponse> {
  const response = await fetch('/api/billing/checkout/status', { credentials: 'include' })
  if (!response.ok) throw new Error(`Failed to load checkout status (${response.status})`)
  return response.json()
}

export function CheckoutReturn() {
  const navigate = useNavigate()
  const hasNavigatedRef = React.useRef(false)

  const statusQuery = useQuery({
    queryKey: ['billing', 'checkout', 'status'],
    queryFn: fetchCheckoutStatus,
    refetchInterval: (query) => {
      const state = query.state.data?.state
      return state && TERMINAL_STATES.has(state) ? false : POLL_INTERVAL_MS
    },
  })

  const state = statusQuery.data?.state

  React.useEffect(() => {
    if (state === 'succeeded' && !hasNavigatedRef.current) {
      hasNavigatedRef.current = true
      navigate({ to: '/settings/billing' })
    }
  }, [state, navigate])

  return (
    <div data-testid="checkout-return-page" className="max-w-md mx-auto py-12 text-center">
      <div role="status" aria-live="polite" className="glass-panel p-8">
        {statusQuery.isLoading && <PendingView label="Checking your subscription…" />}
        {statusQuery.isError && <ErrorRecoveryView />}
        {!statusQuery.isLoading && !statusQuery.isError && renderForState(state)}
      </div>
      <p className="mt-6 text-sm text-bh-text-muted">
        <Link to="/settings/billing" className="underline">Back to billing settings</Link>
      </p>
    </div>
  )
}

function renderForState(state: CheckoutReturnState | undefined) {
  switch (state) {
    case 'succeeded':
      return <SucceededView />
    case 'expired':
      return <ExpiredView />
    case 'failed':
      return <FailedView />
    case 'no_attempt':
      return <NoAttemptView />
    case 'pending':
    default:
      return <PendingView label="Confirming your subscription with Stripe…" />
  }
}

function PendingView({ label }: { label: string }) {
  return (
    <div data-testid="checkout-return-pending">
      <Clock className="w-10 h-10 mx-auto mb-4 text-bh-accent animate-pulse" aria-hidden="true" />
      <h1 className="text-lg font-semibold mb-1">{label}</h1>
      <p className="text-sm text-bh-text-muted">
        This can take a few seconds. You don't need to do anything — this page will update on its own.
      </p>
    </div>
  )
}

function SucceededView() {
  return (
    <div data-testid="checkout-return-succeeded">
      <CheckCircle2 className="w-10 h-10 mx-auto mb-4 text-bh-success" aria-hidden="true" />
      <h1 className="text-lg font-semibold mb-1">You're subscribed!</h1>
      <p className="text-sm text-bh-text-muted">Taking you to your billing settings…</p>
    </div>
  )
}

function ExpiredView() {
  return (
    <div data-testid="checkout-return-expired">
      <AlertTriangle className="w-10 h-10 mx-auto mb-4 text-bh-warning" aria-hidden="true" />
      <h1 className="text-lg font-semibold mb-1">This checkout session expired</h1>
      <p className="text-sm text-bh-text-muted">Nothing was charged. Head back to billing settings to try again.</p>
    </div>
  )
}

function FailedView() {
  return (
    <div data-testid="checkout-return-failed">
      <XCircle className="w-10 h-10 mx-auto mb-4 text-bh-danger" aria-hidden="true" />
      <h1 className="text-lg font-semibold mb-1">We couldn't confirm your subscription</h1>
      <p className="text-sm text-bh-text-muted">Nothing was charged. Head back to billing settings to try again.</p>
    </div>
  )
}

function NoAttemptView() {
  return (
    <div data-testid="checkout-return-no-attempt">
      <AlertTriangle className="w-10 h-10 mx-auto mb-4 text-bh-warning" aria-hidden="true" />
      <h1 className="text-lg font-semibold mb-1">No checkout in progress</h1>
      <p className="text-sm text-bh-text-muted">Head back to billing settings to start a subscription.</p>
    </div>
  )
}

function ErrorRecoveryView() {
  return (
    <div data-testid="checkout-return-error">
      <XCircle className="w-10 h-10 mx-auto mb-4 text-bh-danger" aria-hidden="true" />
      <h1 className="text-lg font-semibold mb-1">Something went wrong</h1>
      <p className="text-sm text-bh-text-muted">We couldn't check your subscription status. Head back to billing settings and try again.</p>
    </div>
  )
}
