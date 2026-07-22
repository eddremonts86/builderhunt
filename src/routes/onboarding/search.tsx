import * as React from 'react'
import { createFileRoute, useNavigate, Link, redirect } from '@tanstack/react-router'
import { Search, X, Sparkles } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { STARTER_QUERIES } from '~/shared/lib/onboarding-shared'
import { Input } from '~/components/ui'

export const Route = createFileRoute('/onboarding/search')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) {
      throw redirect({ to: '/auth/sign-in', search: { redirect: '/onboarding/search' } })
    }
    return { user }
  },
  component: SearchStep,
})

function SearchStep() {
  const navigate = useNavigate()
  const [query, setQuery] = React.useState('')
  const [skipping, setSkipping] = React.useState(false)

  React.useEffect(() => {
    // Mark step 2 as visited
    fetch('/api/onboarding/complete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 2 }),
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

  const runSearch = (q: string) => {
    if (!q.trim()) return
    navigate({ to: '/onboarding/save', search: { q: q.trim() } })
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim mb-2">Step 2 of 3</p>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">
            What are you looking for?
          </h1>
          <p className="text-bh-text-muted">
            Pick a starter query or type your own. We'll search 12 sources.
          </p>
        </div>

        <div className="mb-6">
          <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">Try one of these:</p>
          <div className="flex flex-wrap gap-2">
            {STARTER_QUERIES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => runSearch(q)}
                data-testid="onboarding-starter-query"
                data-query={q}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-bh-surface border border-bh-border text-sm text-bh-text hover:border-bh-accent hover:text-bh-accent hover:bg-bh-accent-soft/30 transition-colors"
              >
                <Sparkles className="w-3 h-3 text-bh-accent" aria-hidden="true" />
                {q}
              </button>
            ))}
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            runSearch(query)
          }}
          className="glass-panel p-4 mb-4"
        >
          <label htmlFor="onboarding-q" className="text-xs uppercase tracking-wider text-bh-text-dim block mb-2">
            Or type your own
          </label>
          <div className="flex gap-2">
            <Input
              id="onboarding-q"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. rust async, AI engineers, indie hackers"
              className="flex-1"
              data-testid="onboarding-query-input"
            />
            <button type="submit" disabled={!query.trim()} className="btn-primary" data-testid="onboarding-search">
              <Search className="w-4 h-4" />
              Search
            </button>
          </div>
        </form>

        <div className="flex items-center justify-between">
          <Link to="/onboarding/welcome" className="btn-ghost btn-sm">
            ← Back
          </Link>
          <button onClick={skip} disabled={skipping} className="btn-ghost btn-sm" data-testid="onboarding-skip-2">
            <X className="w-3.5 h-3.5" />
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}
