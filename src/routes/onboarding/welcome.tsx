import * as React from 'react'
import { createFileRoute, useNavigate, redirect } from '@tanstack/react-router'
import { Sparkles, ArrowRight, X } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { Button, LinkButton } from '~/components/ui'
import { consumePostOnboardingNext } from '~/shared/lib/post-onboarding-next'
import { SEARCH_SOURCE_COUNT } from '~/shared/lib/search-connectors'
import { useOnboardingStep } from '~/shared/lib/useOnboardingStep'

export const Route = createFileRoute('/onboarding/welcome')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) {
      throw redirect({ to: '/auth/sign-in', search: { redirect: '/onboarding/welcome' } })
    }
    return { user }
  },
  component: WelcomeStep,
})

const VALUE_PROPS = [
  {
    title: `${SEARCH_SOURCE_COUNT} sources, one search`,
    body: 'GitHub, Reddit, HN, DEV.to, Stack Overflow, npm, Hugging Face, GitLab, Codeberg, Lobsters, and more. All deduplicated.',
  },
  {
    title: 'Save a search, get daily picks',
    body: 'Your "For you" radar surfaces fresh builders every day — no need to remember to come back.',
  },
  {
    title: 'Claim your profile',
    body: 'Found yourself? Claim your profile to enrich it with topics, "open to" status, and a verified badge.',
  },
]

function WelcomeStep() {
  const navigate = useNavigate()
  const [skipping, setSkipping] = React.useState(false)
  const step = useOnboardingStep('welcome')

  React.useEffect(() => {
    // Mark step 1 as visited
    fetch('/api/onboarding/complete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 1 }),
    }).catch(() => {})
  }, [])

  const skip = async () => {
    setSkipping(true)
    step.exit()
    try {
      await fetch('/api/onboarding/skip', { method: 'POST', credentials: 'include' })
    } catch {
      // Skip is best-effort — the user still leaves onboarding either way.
    }
    const next = consumePostOnboardingNext()
    // `href` (not `to`): `next` may carry a query string (e.g.
    // "/search?q=rust") and `to` treats "?" as part of the pathname.
    if (next) navigate({ href: next })
    else navigate({ to: '/dashboard' })
  }

  /**
   * Where "Show me how" leads — the one place the two flows fork.
   *
   * v2 inserts the goal step between welcome and the action; v1 goes straight to the search step.
   * Both are live, so the rollout is this choice and nothing else: no deploy, no migration, and a
   * rollback is the same choice made the other way. The cohort is decided on the server
   * (`/api/onboarding/v2` answers `rollout.inCohort`) so a client cannot opt itself in.
   *
   * Until the status has resolved, this points at v1 — the flow everybody had. Guessing the other
   * way would flash the goal step at somebody who is not in the cohort.
   */
  const start = step.inCohort ? '/onboarding/goal' : '/onboarding/search'

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
      <div className="max-w-3xl w-full">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-bh-accent/10 border border-bh-accent/30 mb-4">
            <Sparkles className="w-8 h-8 text-bh-accent" aria-hidden="true" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">
            Welcome to BuilderHunt
          </h1>
          <p className="text-bh-text-muted text-lg max-w-xl mx-auto">
            Find active developers across {SEARCH_SOURCE_COUNT} sources. Save a search, get daily picks.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {VALUE_PROPS.map((vp) => (
            <div key={vp.title} className="card p-5">
              <h3 className="font-semibold text-bh-text mb-2">{vp.title}</h3>
              <p className="text-sm text-bh-text-muted leading-relaxed">{vp.body}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          {/* A button rather than a link: the destination is decided at click time and the step has
              to be recorded before the navigation. `LinkButton` takes no click handler. */}
          <Button
            variant="primary"
            className="inline-flex"
            data-testid="onboarding-start"
            data-flow-version={step.inCohort ? '2' : '1'}
            onClick={() => {
              void step.complete()
              void navigate({ to: start })
            }}
          >
            Show me how
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button
            onClick={skip}
            disabled={skipping}
            variant="ghost"
            data-testid="onboarding-skip"
          >
            <X className="w-4 h-4" aria-hidden="true" />
            {skipping ? 'Skipping…' : 'Skip, take me to dashboard'}
          </Button>
        </div>
      </div>
    </div>
  )
}
