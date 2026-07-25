import * as React from 'react'
import { createFileRoute, useNavigate, useSearch, redirect } from '@tanstack/react-router'
import { Bookmark, ArrowRight, AlertCircle, Loader2, ExternalLink, Check } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { Button, LinkButton } from '~/components/ui'

interface Builder {
  id: string
  username: string
  displayName?: string | null
  kind?: 'person' | 'repo'
  source: string
  sourceId: string
  profileUrl: string
  bio?: string | null
  avatarUrl?: string | null
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
      // Actually track the builder (same endpoint Search's "Track" button
      // uses) so the "radar is live" promise on the success step is true —
      // these builders show up in Exports/Recent builders/the dashboard
      // count afterwards, not just as an onboarding-progress flag.
      const trackRes = await fetch('/api/builders/track', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: builder.source,
          sourceId: builder.sourceId,
          username: builder.username,
          displayName: builder.displayName,
          avatarUrl: builder.avatarUrl,
          bio: builder.bio,
          profileUrl: builder.profileUrl,
          followersCount: builder.followersCount,
          topics: builder.topics,
          score: builder.score,
        }),
      })
      if (trackRes.ok) {
        setSavedIds((prev) => new Set([...prev, builder.id]))
      }
      // Onboarding progress is separate bookkeeping (drives the "resume
      // onboarding" banner elsewhere) — record intent regardless.
      await fetch('/api/onboarding/complete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builderId: builder.id }),
      }).catch(() => {})
    } catch {
      // ignore
    } finally {
      setSavingId(null)
    }
  }

  const finish = async () => {
    if (savedIds.size < REQUIRED_SAVES) return
    // Actually save the search that was just used, so "your saved searches
    // run continuously" on the success step is true from the start.
    await fetch('/api/queries', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: searchedQuery,
        keywords: [searchedQuery],
        sources: ['github', 'reddit', 'hn', 'devto', 'lobsters'],
      }),
    }).catch(() => {})
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
              <LinkButton to="/onboarding/search" variant="secondary" size="sm" className="mt-2 inline-flex">
                Try a different query
              </LinkButton>
            </div>
          </div>
        </div>
      )}

      {!loading && !error && results.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-bh-text-muted">No results for "{searchedQuery}".</p>
          <LinkButton to="/onboarding/search" variant="secondary" size="sm" className="mt-3 inline-flex">
            Try a different query
          </LinkButton>
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
                    <Button
                      type="button"
                      onClick={() => !isSaved && saveOne(b)}
                      disabled={isSaved || isSaving}
                      variant={isSaved ? 'secondary' : 'primary'}
                      size="sm"
                      className="flex-1 justify-center"
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
                    </Button>
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
            <Button
              type="button"
              onClick={finish}
              disabled={!canFinish}
              data-testid="onboarding-finish"
            >
              Finish
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
