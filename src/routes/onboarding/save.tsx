import * as React from 'react'
import { createFileRoute, useNavigate, Link, useSearch, redirect } from '@tanstack/react-router'
import { Bookmark, ArrowRight, AlertCircle, Loader2, ExternalLink, Check } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'

interface Builder {
  id: string
  username: string
  displayName?: string | null
  source: string
  profileUrl: string
  bio?: string | null
  followersCount?: number
  topics?: string[]
  score?: number
}

export const Route = createFileRoute('/onboarding/save')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) {
      throw redirect({ to: '/auth/sign-in', search: { redirect: '/onboarding/save' } })
    }
    return { user }
  },
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q : '',
  }),
  component: SaveStep,
})

const REQUIRED_SAVES = 3

function SaveStep() {
  const navigate = useNavigate()
  const { q } = useSearch({ from: Route.fullPath })
  const [results, setResults] = React.useState<Builder[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [savedIds, setSavedIds] = React.useState<Set<string>>(new Set())
  const [savingId, setSavingId] = React.useState<string | null>(null)
  const [searchedQuery, setSearchedQuery] = React.useState<string>('')

  React.useEffect(() => {
    if (!q) {
      navigate({ to: '/onboarding/search' })
      return
    }
    setSearchedQuery(q)
    setLoading(true)
    setError(null)
    fetch('/api/search/builders', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: q, perPage: 12 }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}))
          throw new Error(data.error ?? `Search failed (${r.status})`)
        }
        return r.json()
      })
      .then((data) => {
        setResults((data.builders ?? []).filter((b: Builder) => b.kind === 'person' || !b.kind).slice(0, 12))
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message ?? 'Search failed')
        setLoading(false)
      })
  }, [q, navigate])

  const saveOne = async (builder: Builder) => {
    setSavingId(builder.id)
    try {
      // Mark in onboarding progress (just intent — actual builder save
      // happens later via the dashboard's save flow, or this counts as
      // soft "I like this" tracking for the activation funnel).
      const res = await fetch('/api/onboarding/complete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builderId: builder.id }),
      })
      if (res.ok) {
        setSavedIds((prev) => new Set([...prev, builder.id]))
      }
    } catch {
      // ignore
    } finally {
      setSavingId(null)
    }
  }

  const finish = async () => {
    if (savedIds.size < REQUIRED_SAVES) return
    await fetch('/api/onboarding/complete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: true }),
    })
    navigate({ to: '/onboarding/success' })
  }

  const canFinish = savedIds.size >= REQUIRED_SAVES

  return (
    <div className="min-h-[calc(100vh-4rem)] p-6 max-w-5xl mx-auto">
      <div className="text-center mb-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim mb-2">Step 3 of 3</p>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">
          Save {REQUIRED_SAVES}+ builders
        </h1>
        <p className="text-bh-text-muted">
          Saved {savedIds.size} / {REQUIRED_SAVES} · "Your radar activates once you save {REQUIRED_SAVES}."
        </p>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12 text-bh-text-muted" data-testid="onboarding-save-loading">
          <Loader2 className="w-5 h-5 animate-spin mr-2" aria-hidden="true" />
          Searching for "{searchedQuery}"…
        </div>
      )}

      {error && (
        <div className="card border border-bh-danger/30 bg-bh-danger/10 p-4 mb-4" role="alert">
          <div className="flex items-start gap-2 text-bh-danger">
            <AlertCircle className="w-4 h-4 mt-0.5" aria-hidden="true" />
            <div>
              <p className="font-semibold">Search failed</p>
              <p className="text-sm">{error}</p>
              <Link to="/onboarding/search" className="btn-secondary btn-sm mt-2 inline-flex">
                Try a different query
              </Link>
            </div>
          </div>
        </div>
      )}

      {!loading && !error && results.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-bh-text-muted">No results for "{searchedQuery}".</p>
          <Link to="/onboarding/search" className="btn-secondary btn-sm mt-3 inline-flex">
            Try a different query
          </Link>
        </div>
      )}

      {!loading && !error && results.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            {results.map((b) => {
              const isSaved = savedIds.has(b.id)
              const isSaving = savingId === b.id
              return (
                <article key={b.id} className="card p-4" data-testid="onboarding-builder-card" data-builder-id={b.id}>
                  <div className="flex items-start gap-3 mb-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-bh-accent to-bh-cyan flex items-center justify-center text-white font-semibold shrink-0 text-sm">
                      {(b.displayName ?? b.username)[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-sm text-bh-text truncate">
                        {b.displayName ?? b.username}
                      </p>
                      <p className="text-xs text-bh-text-dim truncate">@{b.username} · {b.source}</p>
                    </div>
                  </div>
                  {b.bio && (
                    <p className="text-xs text-bh-text-muted line-clamp-2 mb-3">{b.bio}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => !isSaved && saveOne(b)}
                      disabled={isSaved || isSaving}
                      className={`btn-sm flex-1 justify-center ${
                        isSaved ? 'btn-secondary' : 'btn-primary'
                      }`}
                      data-testid="onboarding-save-btn"
                      data-builder-id={b.id}
                    >
                      {isSaving ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                      ) : isSaved ? (
                        <Check className="w-3.5 h-3.5" aria-hidden="true" />
                      ) : (
                        <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      {isSaved ? 'Saved' : isSaving ? 'Saving…' : 'Save'}
                    </button>
                    <a
                      href={b.profileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-ghost btn-sm p-1.5"
                      title="View profile"
                    >
                      <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                    </a>
                  </div>
                </article>
              )
            })}
          </div>

          <div className="flex items-center justify-between sticky bottom-0 z-50 bg-bh-bg/80 backdrop-blur p-4 -mx-6 -mb-6 border-t border-bh-border">
            <div className="text-sm text-bh-text-muted">
              {savedIds.size} of {REQUIRED_SAVES} builders saved
            </div>
            <button
              type="button"
              onClick={finish}
              disabled={!canFinish}
              className="btn-primary"
              data-testid="onboarding-finish"
            >
              Finish
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </div>
  )
}
