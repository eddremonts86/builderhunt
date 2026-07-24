import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useSession } from '~/shared/lib/auth/client'

type AcceptState = 'idle' | 'pending' | 'accepted' | 'error'

export function OrganizationInvitationPage({ invitationId }: { invitationId: string }) {
  const { data: session, isPending: sessionPending, refetch: refetchSession } = useSession()
  const navigate = useNavigate()
  const [state, setState] = React.useState<AcceptState>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [redirecting, setRedirecting] = React.useState(false)

  // Signed-out visitors go to sign-in and come straight back here to finish
  // accepting — `?redirect=` is sign-in's existing "return to" contract
  // (src/routes/auth/sign-in.tsx), so no new mechanism is needed.
  //
  // The client session atom can briefly hold a stale signed-out value
  // (`isPending: false`, `data: null`) right after the client-side return
  // from sign-in, while its own refetch is still in flight — so a bare
  // `!session?.user` check would bounce the freshly signed-in invitee
  // straight back to the sign-in form. Confirm against the server before
  // treating the visitor as signed out; when the server says signed in,
  // refresh the atom and stay.
  React.useEffect(() => {
    if (sessionPending || session?.user) return
    let cancelled = false
    void (async () => {
      let serverUser: unknown
      try {
        const res = await fetch('/api/auth/get-session', { credentials: 'include' })
        const body = res.ok ? ((await res.json().catch(() => null)) as { user?: unknown } | null) : null
        serverUser = body?.user ?? null
      } catch {
        serverUser = null
      }
      if (cancelled) return
      if (serverUser) {
        refetchSession()
        return
      }
      setRedirecting(true)
      navigate({ to: '/auth/sign-in', search: { redirect: `/team/invite/${invitationId}` } })
    })()
    return () => {
      cancelled = true
    }
  }, [sessionPending, session, invitationId, navigate, refetchSession])

  async function handleAccept() {
    setState('pending')
    setError(null)
    try {
      const res = await fetch(`/api/organizations/invitations/${encodeURIComponent(invitationId)}/accept`, {
        method: 'POST',
        credentials: 'include',
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // `acceptInvitation` itself already collapses every failure mode —
        // wrong account, unverified email, expired, revoked, already used —
        // into one generic message, deliberately, so this page never needs
        // (and must never invent) a more specific one.
        setError(typeof body.error === 'string' ? body.error : 'This invitation is no longer valid')
        setState('error')
        return
      }
      setState('accepted')
      navigate({ to: '/dashboard', replace: true })
    } catch {
      setError('This invitation is no longer valid')
      setState('error')
    }
  }

  if (sessionPending || !session?.user) {
    return (
      <div className="p-8 max-w-md mx-auto text-center text-sm text-bh-text-muted" data-testid="invitation-loading">
        {redirecting ? 'Redirecting to sign in…' : 'Loading…'}
      </div>
    )
  }

  return (
    <div className="p-8 max-w-md mx-auto text-center" data-testid="invitation-page">
      <h1 className="text-2xl font-bold mb-2">Team invitation</h1>
      <p className="text-bh-text-muted mb-6">
        Signed in as <strong className="text-bh-text">{session.user.email}</strong>. If this invitation was sent to a
        different address, sign in with that account instead.
      </p>

      {state === 'error' && error && (
        <p className="text-bh-danger text-sm mb-4" role="alert" data-testid="invitation-error">
          {error}
        </p>
      )}
      {state === 'accepted' && (
        <p className="text-bh-success text-sm mb-4" data-testid="invitation-success">Invitation accepted — redirecting…</p>
      )}

      <button
        type="button"
        className="btn-primary"
        disabled={state === 'pending' || state === 'accepted'}
        onClick={handleAccept}
        data-testid="invitation-accept-btn"
      >
        {state === 'pending' ? 'Accepting…' : 'Accept invitation'}
      </button>
    </div>
  )
}
