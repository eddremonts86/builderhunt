import * as React from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Sparkles, ArrowRight, X } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'

export const Route = createFileRoute('/onboarding/welcome')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  component: WelcomeStep,
})

const VALUE_PROPS = [
  {
    title: '12 sources, one search',
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
    try {
      await fetch('/api/onboarding/skip', { method: 'POST', credentials: 'include' })
      navigate({ to: '/dashboard' })
    } catch {
      navigate({ to: '/dashboard' })
    }
  }

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
            Find active developers across 12 sources. Save a search, get daily picks.
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
          <Link to="/onboarding/search" className="btn-primary inline-flex" data-testid="onboarding-start">
            Show me how
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Link>
          <button
            onClick={skip}
            disabled={skipping}
            className="btn-ghost"
            data-testid="onboarding-skip"
          >
            <X className="w-4 h-4" aria-hidden="true" />
            {skipping ? 'Skipping…' : 'Skip, take me to dashboard'}
          </button>
        </div>
      </div>
    </div>
  )
}
