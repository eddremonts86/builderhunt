import * as React from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { AlertCircle, ArrowRight, Loader2, Search, X } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { Button, Input, LinkButton } from '~/components/ui'
import { consumePostOnboardingNext } from '~/shared/lib/post-onboarding-next'
import { useOnboardingStep } from '~/shared/lib/useOnboardingStep'
import { getSelfManagedEnabled } from '~/shared/lib/self-managed/feature-flag'

/**
 * The building branch (plan: phase-2/03-onboarding-segmentado).
 *
 * ## Locate, then claim — and claiming is not instant
 *
 * Verification here is asynchronous by design: the claimant publishes a challenge string on the
 * account being claimed, and the product checks it. So the honest shape of this step is not "claimed
 * / not claimed" but three states, and the pending one is a first-class screen rather than a
 * spinner: the challenge, where to put it, and a button that checks again. The spec asks for exactly
 * that — "claim verified, or, if verification is asynchronous, claim started with a clear next step".
 *
 * ## Not found is a real answer
 *
 * Somebody may simply not be in the index, and the step says so plainly and lets them leave. It does
 * not offer to create a profile: the index is built from what the connectors find, and a row this
 * flow invented would be a profile nobody can prove.
 *
 * ## What is not promised
 *
 * No visits, no opportunities, no reach. Claiming links an indexed profile to an account; everything
 * that follows is what the person chooses to put on it.
 */
export const Route = createFileRoute('/onboarding/building')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) {
      throw redirect({ to: '/auth/sign-in', search: { redirect: '/onboarding/building' } })
    }
    return { user }
  },
  component: BuildingStep,
})

interface Candidate {
  id: string
  source: string
  username: string
  displayName?: string | null
  avatarUrl?: string | null
  profileUrl: string
}

interface PendingClaim {
  builderIdentityId: string
  source: string
  username: string
  challenge: string
  instructions: string
  expiresAt: string
}

function BuildingStep() {
  const navigate = useNavigate()
  const step = useOnboardingStep('building')
  /*
   * Resolved from the server, and defaulting to *not offered*.
   *
   * A component cannot read the flag — `env.ts` gives the browser a stub — so this asks the server
   * function once. `false` until it answers is the right default for a feature switch: showing the
   * offer and then withdrawing it reads as a broken screen, while showing it a moment late reads as
   * a page finishing loading.
   */
  const [selfManagedEnabled, setSelfManagedEnabled] = React.useState(false)
  React.useEffect(() => {
    void getSelfManagedEnabled().then(setSelfManagedEnabled).catch(() => setSelfManagedEnabled(false))
  }, [])
  const [handle, setHandle] = React.useState('')
  const [searching, setSearching] = React.useState(false)
  const [searched, setSearched] = React.useState(false)
  const [candidates, setCandidates] = React.useState<Candidate[]>([])
  const [claim, setClaim] = React.useState<PendingClaim | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [proofFailure, setProofFailure] = React.useState<string | null>(null)

  const leave = async (skipping: boolean) => {
    setBusy(true)
    step.exit()
    if (skipping) {
      await fetch('/api/onboarding/skip', { method: 'POST', credentials: 'include' }).catch(() => {})
    }
    const next = consumePostOnboardingNext()
    if (next) navigate({ href: next })
    else navigate({ to: '/dashboard' })
  }

  const locate = async () => {
    if (!handle.trim()) return
    setSearching(true)
    setError(null)
    setProofFailure(null)
    try {
      const response = await fetch(`/api/builders/claim/candidates?handle=${encodeURIComponent(handle.trim())}`, {
        credentials: 'include',
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Lookup failed (${response.status}).`)
        setCandidates([])
      } else {
        const body = (await response.json()) as { candidates?: Candidate[] }
        setCandidates(body.candidates ?? [])
      }
    } catch {
      setError('We could not reach the server.')
      setCandidates([])
    } finally {
      setSearched(true)
      setSearching(false)
    }
  }

  const startClaim = async (candidate: Candidate) => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/builders/${encodeURIComponent(candidate.id)}/claim`, {
        method: 'POST',
        credentials: 'include',
      })
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      if (!response.ok) {
        setError(typeof body.error === 'string' ? body.error : `Could not start the claim (${response.status}).`)
        return
      }

      setClaim({
        builderIdentityId: candidate.id,
        source: String(body.source ?? candidate.source),
        username: String(body.username ?? candidate.username),
        challenge: String(body.challenge ?? ''),
        instructions: String(body.instructions ?? ''),
        expiresAt: String(body.expiresAt ?? ''),
      })

      /**
       * Activation is requested here, at the pending claim — not at verification.
       *
       * The spec counts a started claim with a clear next step, because verification depends on the
       * person going and editing an account somewhere else and may take days. Waiting for it would
       * make this route's activation rate a measurement of how quickly people read instructions.
       *
       * A request, not an assertion: the server counts the claim rows itself before recording it.
       */
      await fetch('/api/onboarding/v2', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'activate', activationType: 'builder_claim', refId: candidate.id }),
      }).catch(() => {})
      await step.complete()
    } catch {
      setError('We could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  const checkProof = async () => {
    if (!claim) return
    setBusy(true)
    setProofFailure(null)
    try {
      const response = await fetch(`/api/builders/${encodeURIComponent(claim.builderIdentityId)}/claim/verify`, {
        method: 'POST',
        credentials: 'include',
      })
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; reason?: string; error?: string }
      if (response.ok && body.ok) {
        await navigate({ to: '/onboarding/success' })
        return
      }
      // Still pending is the normal answer, not an error: the challenge may not be published yet, or
      // the source may still be serving a cached profile.
      setProofFailure(body.reason ?? body.error ?? 'not_found')
    } catch {
      setProofFailure('unreachable')
    } finally {
      setBusy(false)
    }
  }

  if (claim) {
    return (
      <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
        <div className="max-w-2xl w-full" data-testid="building-pending">
          <p className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim mb-2">
            One step left
          </p>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Prove the account is yours</h1>
          <p className="text-bh-text-muted mb-6">
            Add this to your {claim.source} profile, then check back. Nobody else can claim{' '}
            @{claim.username} while this is open.
          </p>

          <div className="card p-4 mb-4">
            <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">Your challenge</p>
            <code className="block px-3 py-2 rounded-lg bg-bh-surface border border-bh-border text-sm break-all" data-testid="building-challenge">
              {claim.challenge}
            </code>
            <p className="text-sm text-bh-text-muted mt-3">{claim.instructions}</p>
          </div>

          {proofFailure && (
            <p className="mb-4 text-sm text-bh-text-muted" role="status" data-testid="building-proof-failure">
              We could not find it yet ({proofFailure}). It can take a few minutes to appear — you can
              close this and check from your profile later.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void checkProof()} disabled={busy} data-testid="building-check">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ArrowRight className="w-4 h-4" aria-hidden="true" />}
              I have published it
            </Button>
            {/* Leaving is not losing the claim: it stays open, and `/me` shows it. */}
            <LinkButton to="/me" variant="secondary" size="sm">
              Finish later on my profile
            </LinkButton>
            <Button onClick={() => void leave(false)} disabled={busy} variant="ghost" size="sm" data-testid="building-leave">
              Go to the dashboard
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim mb-2">
            Find yourself
          </p>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">Claim your profile</h1>
          <p className="text-bh-text-muted">
            If we have already indexed you, claiming links that profile to this account. You decide
            what it says.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void locate()
          }}
          className="card p-4 mb-4"
        >
          <label htmlFor="building-handle" className="text-xs uppercase tracking-wider text-bh-text-dim block mb-2">
            Your handle on GitHub, GitLab, Codeberg or DEV
          </label>
          <div className="flex gap-2">
            <Input
              id="building-handle"
              type="search"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="e.g. octocat"
              className="flex-1"
              data-testid="building-handle"
            />
            <Button type="submit" disabled={!handle.trim() || searching} data-testid="building-find">
              {searching ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Search className="w-4 h-4" aria-hidden="true" />}
              Find me
            </Button>
          </div>
        </form>

        {error && (
          <div className="card border border-bh-danger/30 bg-bh-danger/10 p-4 mb-4" role="alert">
            <div className="flex items-start gap-2 text-bh-danger">
              <AlertCircle className="w-4 h-4 mt-0.5" aria-hidden="true" />
              <p className="text-sm" data-testid="building-error">{error}</p>
            </div>
          </div>
        )}

        {candidates.length > 0 && (
          <ul className="space-y-2 mb-4" data-testid="building-candidates">
            {candidates.map((candidate) => (
              <li key={candidate.id} className="card p-4 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm truncate">
                    {candidate.displayName ?? candidate.username}
                  </p>
                  <p className="text-xs text-bh-text-dim truncate">
                    @{candidate.username} · {candidate.source}
                  </p>
                </div>
                <a
                  href={candidate.profileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs underline text-bh-text-muted"
                >
                  View
                </a>
                <Button
                  size="sm"
                  onClick={() => void startClaim(candidate)}
                  disabled={busy}
                  data-testid="building-claim"
                  data-candidate-id={candidate.id}
                >
                  This is me
                </Button>
              </li>
            ))}
          </ul>
        )}

        {searched && !searching && candidates.length === 0 && !error && (
          <div className="card p-4 mb-4 text-sm text-bh-text-muted" data-testid="building-not-found">
            {/*
              This used to end here, with no offer to create anything, and the reason given was that
              "a row this flow invented would be a profile nobody could prove". That was right while
              the only kind of profile was a claimed one — and it is exactly the exclusion
              phase-2/07 exists to end.
              A self-managed profile proves nothing and never pretends to: it is marked
              `Self-managed` on every block it renders, it can never carry the verified badge, and
              its content is the owner's own declaration. So the offer below is not a weaker claim,
              it is a different and honestly labelled thing — which is what makes it safe to make to
              somebody whose work simply is not in any connector's index.
            */}
            <p className="mb-3">
              Nothing indexed under that handle yet. We index from public activity, so a claimed
              profile appears once we have seen some.
            </p>
            {selfManagedEnabled && (
              <p className="mb-4">
                You can write your own profile instead. It is marked <strong>Self-managed</strong>
                {' '}wherever it appears — never verified — and you can attach work samples to it.
              </p>
            )}
            {selfManagedEnabled && (
              <LinkButton to="/me/profile" size="sm" data-testid="building-create" onClick={() => step.exit('building_create')}>
                Write my own profile
              </LinkButton>
            )}
          </div>
        )}

        <div className="flex items-center justify-between">
          <LinkButton to="/onboarding/goal" variant="ghost" size="sm">
            ← Back
          </LinkButton>
          <Button onClick={() => void leave(true)} disabled={busy} variant="ghost" size="sm" data-testid="building-skip">
            <X className="w-3.5 h-3.5" aria-hidden="true" />
            Skip
          </Button>
        </div>
      </div>
    </div>
  )
}
