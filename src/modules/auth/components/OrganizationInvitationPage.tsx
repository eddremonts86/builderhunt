import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useSession } from '~/shared/lib/auth/client'
import { Button } from '~/components/ui'
import { InvitationValuePreview } from '~/modules/organizations/components/InvitationValuePreview'
import {
  normalizeInvitationIntent,
  type InvitationIntent,
} from '~/shared/lib/organizations/invitation-personalization'

type ActionState = 'idle' | 'accepting' | 'declining' | 'accepted' | 'declined' | 'error'

interface InvitationReview {
  organizationName: string
  role: 'admin' | 'member'
  intent: InvitationIntent
  roleTitle: string | null
  expiresAt: string
  /** Three already-discovered public identities, or empty when the read failed or found none. */
  builders?: Array<{
    username: string
    displayName: string | null
    avatarUrl: string | null
    source: string
    profileUrl: string
  }>
}

/** The one message every invalid case gets. Never made more specific here — see the fetch below. */
const GENERIC_ERROR = 'This invitation is no longer valid'

export function OrganizationInvitationPage({ invitationId }: { invitationId: string }) {
  const { data: session, isPending: sessionPending, refetch: refetchSession } = useSession()
  const navigate = useNavigate()
  const [state, setState] = React.useState<ActionState>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [redirecting, setRedirecting] = React.useState(false)
  const [review, setReview] = React.useState<InvitationReview | null>(null)
  const [reviewState, setReviewState] = React.useState<'loading' | 'ready' | 'invalid' | 'offline'>('loading')

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

  /**
   * The review fetch, once the visitor is signed in.
   *
   * `invalid` and `offline` are separate states on purpose. A 403 means this account may not see this
   * invitation and no retry will change that; a network failure means the answer is unknown and
   * retrying is the right offer. Collapsing them would either hide a retry the user needs or offer one
   * that can only ever fail.
   */
  React.useEffect(() => {
    if (!session?.user) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/organizations/invitations/${encodeURIComponent(invitationId)}/review`, {
          credentials: 'include',
        })
        if (cancelled) return
        if (!res.ok) {
          setReviewState('invalid')
          return
        }
        const body = (await res.json()) as InvitationReview
        if (cancelled) return
        setReview({ ...body, intent: normalizeInvitationIntent(body.intent) })
        setReviewState('ready')
      } catch {
        if (!cancelled) setReviewState('offline')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session?.user, invitationId])

  async function act(action: 'accept' | 'reject') {
    setState(action === 'accept' ? 'accepting' : 'declining')
    setError(null)
    try {
      const res = await fetch(`/api/organizations/invitations/${encodeURIComponent(invitationId)}/${action}`, {
        method: 'POST',
        credentials: 'include',
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // The lifecycle already collapses every failure mode — wrong account, unverified email,
        // expired, revoked, already used, lost race — into one generic message, deliberately, so this
        // page never needs (and must never invent) a more specific one.
        setError(typeof body.error === 'string' ? body.error : GENERIC_ERROR)
        setState('error')
        return
      }
      if (action === 'reject') {
        setState('declined')
        return
      }
      setState('accepted')
      /**
       * Where acceptance lands, and why it is a branch rather than always `/dashboard`.
       *
       * `activeOrganization: false` means the membership committed but the session switch did not, so
       * sending them to the onboarding search would run it against whichever organization was active
       * before. `/dashboard` has the switcher; onboarding does not.
       */
      if (body.activeOrganization && typeof body.suggestedQuery === 'string') {
        navigate({ to: '/onboarding/search', search: { q: body.suggestedQuery }, replace: true })
        return
      }
      navigate({ to: '/dashboard', replace: true })
    } catch {
      setError(GENERIC_ERROR)
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

  const busy = state === 'accepting' || state === 'declining'

  return (
    <div className="p-8 max-w-lg mx-auto" data-testid="invitation-page">
      <h1 className="text-2xl font-bold mb-2">Team invitation</h1>
      <p className="text-bh-text-muted mb-6 text-sm">
        Signed in as <strong className="text-bh-text">{session.user.email}</strong>. If this invitation was sent to a
        different address, sign in with that account instead.
      </p>

      {/*
        One live region, always mounted.
        Mounting it only when there is something to say means a screen reader never announces the first
        message, because the region and its content arrive in the same commit and there is no change to
        observe. Empty and present is the shape that works.
      */}
      <div aria-live="polite" className="min-h-6 mb-4">
        {reviewState === 'loading' && (
          <p className="text-sm text-bh-text-muted" data-testid="invitation-review-loading">Loading invitation…</p>
        )}
        {reviewState === 'invalid' && (
          <p className="text-sm text-bh-danger" data-testid="invitation-error">{GENERIC_ERROR}</p>
        )}
        {reviewState === 'offline' && (
          <p className="text-sm text-bh-warning" data-testid="invitation-review-offline">
            We could not load this invitation. Check your connection and try again.
          </p>
        )}
        {state === 'error' && error && (
          <p className="text-sm text-bh-danger" data-testid="invitation-error">{error}</p>
        )}
        {state === 'accepted' && (
          <p className="text-sm text-bh-success" data-testid="invitation-success">Invitation accepted.</p>
        )}
        {state === 'declined' && (
          <p className="text-sm text-bh-text-muted" data-testid="invitation-declined">
            Invitation declined. You can close this page.
          </p>
        )}
      </div>

      {reviewState === 'offline' && (
        <Button type="button" variant="ghost" onClick={() => { setReviewState('loading'); void refetchSession() }} data-testid="invitation-review-retry">
          Try again
        </Button>
      )}

      {reviewState === 'ready' && review && state !== 'declined' && (
        <>
          {/*
            Three real people, and every one of them a link out.
            Rendered only when the server sent some: an empty array becomes no section, not an empty
            heading, because "here is what you could find" above nothing is worse than silence. The
            names are public discovery data — `builder_identities` holds no tenant rows — so this is
            safe for a recipient who is not a member yet.
          */}
          {review.builders && review.builders.length > 0 && (
            <div className="mb-6" data-testid="invitation-preview-builders">
              <p className="mb-2 text-xs uppercase tracking-wider text-bh-text-dim">
                People already indexed here
              </p>
              <ul className="flex flex-wrap gap-3">
                {review.builders.map((builder) => (
                  <li key={`${builder.source}:${builder.username}`}>
                    <a
                      href={builder.profileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 rounded-full border border-bh-border bg-bh-bg-alt px-2 py-1 text-xs text-bh-text-muted hover:border-bh-accent/40 hover:text-bh-text transition-colors"
                    >
                      {builder.avatarUrl && (
                        // `alt=""` and `aria-hidden`: the accessible name is the text beside it, and a
                        // screen reader announcing "avatar of X" then "X" says the name twice.
                        <img src={builder.avatarUrl} alt="" aria-hidden className="size-5 rounded-full" loading="lazy" />
                      )}
                      <span>{builder.displayName ?? builder.username}</span>
                      <span className="text-bh-text-dim">{builder.source}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mb-6">
            <InvitationValuePreview
              intent={review.intent}
              roleTitle={review.roleTitle}
              organizationName={review.organizationName}
              role={review.role}
              audience="recipient"
            />
          </div>

          {/*
            No timed redirect and no automatic acceptance. Joining an organization is not reversible from
            this page, and a countdown makes the decision for someone who is still reading it.
          */}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="primary"
              disabled={busy || state === 'accepted'}
              onClick={() => void act('accept')}
              data-testid="invitation-accept-btn"
            >
              {state === 'accepting' ? 'Accepting…' : 'Accept invitation'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy || state === 'accepted'}
              onClick={() => void act('reject')}
              data-testid="invitation-decline-btn"
            >
              {state === 'declining' ? 'Declining…' : 'Decline'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
