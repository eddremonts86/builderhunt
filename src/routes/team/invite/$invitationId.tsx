import * as React from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

export const Route = createFileRoute('/team/invite/$invitationId')({
  component: InvitePage,
})

type AcceptState = 'idle' | 'pending' | 'accepted' | 'error'

function InvitePage() {
  const { invitationId } = Route.useParams()
  const navigate = useNavigate()
  const [state, setState] = React.useState<AcceptState>('idle')
  const [error, setError] = React.useState<string | null>(null)

  async function handleAccept() {
    setState('pending')
    setError(null)
    try {
      const res = await fetch(`/api/organizations/invitations/${encodeURIComponent(invitationId)}/accept`, {
        method: 'POST',
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof body.error === 'string' ? body.error : 'This invitation is no longer valid')
        setState('error')
        return
      }
      setState('accepted')
      navigate({ to: '/', replace: true })
    } catch {
      setError('This invitation is no longer valid')
      setState('error')
    }
  }

  return (
    <div className="p-8 max-w-md mx-auto text-center">
      <h1 className="text-2xl font-bold mb-2">Team invitation</h1>
      <p className="text-bh-text-muted mb-6">
        Sign in with the email address this invitation was sent to, then accept it below.
      </p>

      {state === 'error' && error && (
        <p className="text-bh-danger text-sm mb-4" role="alert">
          {error}
        </p>
      )}
      {state === 'accepted' && (
        <p className="text-bh-success text-sm mb-4">Invitation accepted — redirecting…</p>
      )}

      <button
        type="button"
        className="btn-primary"
        disabled={state === 'pending' || state === 'accepted'}
        onClick={handleAccept}
      >
        {state === 'pending' ? 'Accepting…' : 'Accept invitation'}
      </button>
    </div>
  )
}
