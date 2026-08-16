import * as React from 'react'
import { createFileRoute, useNavigate, redirect } from '@tanstack/react-router'
import { Search, X, Sparkles } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { searchStepCopyFor, starterQueriesFor } from '~/shared/lib/onboarding-shared'
import { useOnboardingStep } from '~/shared/lib/useOnboardingStep'
import { Button, Input, LinkButton } from '~/components/ui'
import { consumePostOnboardingNext } from '~/shared/lib/post-onboarding-next'
import { SEARCH_SOURCE_COUNT } from '~/shared/lib/search-connectors'

/**
 * `?q=` prefills the input and nothing else (plan 59).
 *
 * It arrives from an accepted invitation, where the server chose it from the invitation's intent. It is
 * treated as **editable text**, never as authorization and never as something to persist: nothing is
 * saved until the visitor runs the search themselves, so a tampered value costs a stranger a prefilled
 * box and no more.
 *
 * Trimmed and capped at 300 characters, because it lands in an `<input>` whose value ends up in a URL
 * — and an unbounded string here would be a way to make that URL arbitrarily long. A visit with no `q`
 * behaves exactly as before: `undefined` in, empty string out.
 */
const MAX_PREFILL_LENGTH = 300

function normalizePrefill(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_PREFILL_LENGTH)
}

export const Route = createFileRoute('/onboarding/search')({
  // Omitted rather than empty when absent, so `q` stays optional for every other navigation into this
  // route — `onboarding/save.tsx` links here without it, and a required param would have made that a
  // type error for a page that has no query to suggest.
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = normalizePrefill(search.q)
    return q ? { q } : {}
  },
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
  // Initial value only: `useState`'s initializer runs once, so a later navigation that changes `q` does
  // not overwrite what the visitor has typed. That is the difference between a suggestion and a field
  // that fights the person filling it in.
  const { q } = Route.useSearch()
  const [query, setQuery] = React.useState(q ?? '')
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

  /**
   * The route the person is on, read from the server rather than inferred.
   *
   * `/api/onboarding/v2` already resolves the segment from `user_preferences` and answers the
   * preset, so there is one place that decision is made — `useOnboardingStep` is that one place, and
   * it reports the step to the funnel while it is there. Anything that goes wrong — the segmentation
   * feature being off, a failed request, an account with no segment — lands on `general`, which is
   * the flow v1 already had. A step that could fail to render because a preference did not load
   * would be a worse product than one that shows the general copy.
   */
  const step = useOnboardingStep('search')

  const skip = async () => {
    setSkipping(true)
    step.exit()
    try {
      await fetch('/api/onboarding/skip', { method: 'POST', credentials: 'include' })
    } catch {
      // Skip is best-effort — the user still leaves onboarding either way.
    }
    const next = consumePostOnboardingNext()
    if (next) navigate({ href: next })
    else navigate({ to: '/dashboard' })
  }

  const runSearch = (q: string) => {
    if (!q.trim()) return
    void step.complete()
    navigate({ to: '/onboarding/save', search: { q: q.trim() } })
  }

  const copy = searchStepCopyFor(step.preset)
  const starterQueries = starterQueriesFor(step.preset)

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim mb-2">Step 2 of 3</p>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">
            {copy.heading}
          </h1>
          <p className="text-bh-text-muted">
            {copy.body} We'll search {SEARCH_SOURCE_COUNT} sources.
          </p>
        </div>

        <div className="mb-6">
          <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">Try one of these:</p>
          <div className="flex flex-wrap gap-2">
            {starterQueries.map((q) => (
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
          className="card p-4 mb-4"
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
            <Button type="submit" disabled={!query.trim()} data-testid="onboarding-search">
              <Search className="w-4 h-4" />
              Search
            </Button>
          </div>
        </form>

        <div className="flex items-center justify-between">
          <LinkButton to="/onboarding/welcome" variant="ghost" size="sm">
            ← Back
          </LinkButton>
          <Button onClick={skip} disabled={skipping} variant="ghost" size="sm" data-testid="onboarding-skip-2">
            <X className="w-3.5 h-3.5" />
            Skip
          </Button>
        </div>
      </div>
    </div>
  )
}
