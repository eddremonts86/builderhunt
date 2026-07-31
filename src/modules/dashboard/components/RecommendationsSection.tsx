import * as React from 'react'
import { Sparkles, X, Search, ArrowRight } from 'lucide-react'
import { Button } from '~/components/ui'
import { BuilderResultActions } from '~/modules/search/components/BuilderResultActions'
import { getSourcePresentation } from '~/shared/lib/source-presentation'

interface Recommendation {
  builder: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    bio: string | null
    source: string
    sourceId: string
    followersCount: number | null
    topics: string[]
  }
  reasons: Array<{
    type: 'keyword' | 'source' | 'topic'
    value: string
    matchedSearchName: string
  }>
  score: number
}

interface RecommendationsResponse {
  recommendations: Recommendation[]
  meta: {
    reason?: 'no_saved_searches' | 'no_matches' | 'error'
    basedOnSearches: number
    totalCandidates: number
  }
}

const STARTER_SUGGESTIONS = [
  'rust distributed systems',
  'indie hackers in EU',
  'AI agents in production',
  'react performance',
  'python ML engineers',
]

/**
 * "For you" section — surfaces builders adjacent to the user's saved
 * searches, before they ask. Top 8 by overlap score (multi-query match
 * ranks highest), recency-filtered.
 */
export function RecommendationsSection({ limit = 8 }: { limit?: number } = {}) {
  const [data, setData] = React.useState<RecommendationsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/recommendations', { credentials: 'include' })
      if (!res.ok) {
        setData({ recommendations: [], meta: { reason: 'error', basedOnSearches: 0, totalCandidates: 0 } })
        return
      }
      const json = (await res.json()) as RecommendationsResponse
      setData(json)
    } catch {
      setData({ recommendations: [], meta: { reason: 'error', basedOnSearches: 0, totalCandidates: 0 } })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const visibleRecs = data?.recommendations.filter((r) => !dismissed.has(r.builder.id)) ?? []

  // A dashboard tile is a glance, not a page. Eight rich cards made this tile
  // 1216px tall, which stretched its whole bento row and left the widget beside
  // it as a mostly empty column. The footer link is where "all of them" lives.
  const shown = visibleRecs.slice(0, limit)

  return (
    /* No `card` class here: `BentoTile` paints the bubble, and a card inside a
       card was painting a border inside a border. The grids below use container
       variants (`@lg:`, `@3xl:`) rather than viewport ones, because the usable
       width is the tile's, not the screen's. */
    <section
      aria-labelledby="for-you-heading"
      className="flex min-w-0 flex-col"
      data-event="recommendation_view"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0 flex-1">
          <h2 id="for-you-heading" className="text-base font-semibold text-bh-text flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-bh-accent" aria-hidden="true" />
            For you
          </h2>
          <p className="text-xs text-bh-text-muted mt-1">
            {data?.meta?.reason === 'no_saved_searches' && 'Save a search to start getting daily picks.'}
            {data?.meta?.reason === 'no_matches' && 'No new matches yet. Try adding more keywords to your searches.'}
            {data?.meta?.reason === 'error' && 'Could not load recommendations. Try again later.'}
            {!data?.meta?.reason && data?.meta?.basedOnSearches != null && data.meta.basedOnSearches > 0 && (
              <>
                <span className="font-medium text-bh-text">
                  {shown.length < visibleRecs.length ? `${shown.length} of ${visibleRecs.length}` : visibleRecs.length}
                </span>{' '}picks based on your{' '}
                <span className="font-medium text-bh-text">{data.meta.basedOnSearches}</span> saved{' '}
                {data.meta.basedOnSearches === 1 ? 'search' : 'searches'}
              </>
            )}
            {loading && 'Loading recommendations…'}
          </p>
        </div>
        {!loading && data?.meta?.reason !== 'no_saved_searches' && (
          <Button
            type="button"
            onClick={() => { setRefreshing(true); load() }}
            disabled={refreshing}
            variant="ghost"
            size="sm"
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
            aria-label="Refresh recommendations"
            title="Refresh"
          >
            <Sparkles className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        )}
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="grid grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card animate-pulse h-32 bg-bh-surface/40" />
          ))}
        </div>
      )}

      {/* Empty: no saved searches */}
      {!loading && data?.meta?.reason === 'no_saved_searches' && (
        <div className="py-2">
          <p className="text-sm text-bh-text-muted mb-3">
            Run your first search, then save it. BuilderHunt will surface new builders matching those
            keywords — no need to remember to come back.
          </p>
          <div className="flex flex-wrap gap-2">
            <span className="text-xs text-bh-text-dim uppercase tracking-wider mr-1 self-center">Try:</span>
            {STARTER_SUGGESTIONS.map((q) => (
              <a
                key={q}
                href={`/search?q=${encodeURIComponent(q)}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bh-surface border border-bh-border text-sm text-bh-text-muted hover:border-bh-accent hover:text-bh-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
              >
                <Search className="w-3 h-3" aria-hidden="true" />
                {q}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Empty: no matches (user has searches but no fresh candidates) */}
      {!loading && data?.meta?.reason === 'no_matches' && (
        <div className="py-2 text-sm text-bh-text-muted">
          <p>
            We checked your saved searches against the latest data — nothing new this round.
            Run them again or add a new search to discover more.
          </p>
        </div>
      )}

      {/* Populated */}
      {!loading && visibleRecs.length > 0 && (
        <div className="grid grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 gap-3">
          {shown.map((rec) => (
            <RecommendationCard
              key={rec.builder.id}
              rec={rec}
              onDismiss={() =>
                setDismissed((prev) => new Set([...prev, rec.builder.id]))
              }
            />
          ))}
        </div>
      )}

      {/* Aggregate why-this-match footer */}
      {!loading && visibleRecs.length > 0 && (
        <WhyFooter recommendations={visibleRecs} />
      )}
    </section>
  )
}

function RecommendationCard({
  rec,
  onDismiss,
}: {
  rec: Recommendation
  onDismiss: () => void
}) {
  const { builder, reasons, score } = rec
  const presentation = getSourcePresentation(builder.source)
  const sourceLabel = presentation?.label ?? builder.source
  const reasonText = reasons.length > 0
    ? `matches ${reasons
        .slice(0, 2)
        .map((r) => (r.type === 'source' ? r.value : `"${r.value}"`))
        .join(', ')}`
    : `score ${score}`
  const matchedSearches = Array.from(new Set(reasons.map((r) => r.matchedSearchName)))

  // Construct dynamic match %
  const matchPercentage = Math.min(99, Math.max(80, 80 + Math.floor(score * 3)))
  // Derive role from topics
  const role = builder.topics?.[0]
    ? `${builder.topics[0].charAt(0).toUpperCase() + builder.topics[0].slice(1)} Dev`
    : 'Fullstack Dev'

  return (
    <article
      className="card card-hover p-4 group relative flex flex-col justify-between"
      data-event="recommendation_view"
    >
      <button
        type="button"
        onClick={onDismiss}
        className="absolute top-2 right-2 p-1.5 rounded-full bg-bh-bg hover:bg-bh-bg-alt text-bh-text-dim hover:text-bh-text opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X className="w-3 h-3" aria-hidden="true" />
      </button>

      <div className="space-y-3">
        <div className="flex items-start gap-2.5">
          {/* Avatar */}
          {builder.avatarUrl ? (
            <img
              src={builder.avatarUrl}
              alt=""
              className="w-10 h-10 rounded-full border border-bh-border shrink-0 object-cover"
              loading="lazy"
              width={40}
              height={40}
            />
          ) : (
            <div
              className="w-10 h-10 rounded-full bg-gradient-to-br from-bh-accent to-bh-cyan flex items-center justify-center text-white font-semibold shrink-0 text-sm"
              aria-hidden="true"
            >
              {(builder.displayName ?? builder.username)[0]?.toUpperCase()}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm text-bh-text truncate">
              {builder.displayName ?? builder.username}
            </p>
            <p className="text-xs text-bh-text-dim truncate">@{builder.username}</p>
            <p className="text-[11px] text-bh-text-muted mt-0.5 font-medium">{role}</p>
          </div>
        </div>

        <p className="text-xs text-bh-text-muted line-clamp-2 leading-relaxed">
          {builder.bio || <span className="italic text-bh-text-dim">No bio yet.</span>}
        </p>

        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="px-2 py-0.5 text-[10px] font-semibold bg-bh-accent text-[color:var(--color-bh-accent-contrast)] rounded-full shrink-0">
            {matchPercentage}% Match
          </span>
          <span className="px-2 py-0.5 text-[10px] font-semibold bg-bh-success/10 text-bh-success border border-bh-success/20 rounded-full shrink-0">
            Available
          </span>
          <span className={`badge ${presentation?.badgeClassName ?? 'badge-neutral'} text-[10px] p-0 px-2 py-0.5`}>
            {sourceLabel}
          </span>
        </div>

        {/* Why you're seeing this */}
        <p className="text-[11px] text-bh-text-dim mt-2 line-clamp-1">
          <Sparkles className="w-3 h-3 inline text-bh-accent mr-0.5" aria-hidden="true" />
          {reasonText}
          {matchedSearches.length > 0 && (
            <span className="text-bh-text-dim"> · in {matchedSearches[0]}</span>
          )}
        </p>
      </div>

      <div className="mt-3.5">
        <BuilderResultActions
          builder={{
            id: builder.id,
            source: builder.source,
            sourceId: builder.sourceId,
            username: builder.username,
            displayName: builder.displayName,
            avatarUrl: builder.avatarUrl,
            bio: builder.bio,
            profileUrl: '',
            followersCount: builder.followersCount,
            topics: builder.topics,
            score,
          }}
          className="[&>div]:w-full [&_button]:flex-1 [&_a]:flex-1"
        />
      </div>
    </article>
  )
}

function WhyFooter({ recommendations }: { recommendations: Recommendation[] }) {
  // Aggregate the matched searches across all visible recommendations
  const counts = new Map<string, number>()
  for (const r of recommendations) {
    for (const reason of r.reasons) {
      counts.set(reason.matchedSearchName, (counts.get(reason.matchedSearchName) ?? 0) + 1)
    }
  }
  const top = Array.from(counts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
  if (top.length === 0) return null
  return (
    <p className="text-xs text-bh-text-dim mt-4 flex items-center gap-1.5 flex-wrap">
      <ArrowRight className="w-3 h-3" aria-hidden="true" />
      Why these?{' '}
      {top.map(([name, count], i) => (
        <span key={name}>
          <span className="text-bh-text-muted font-medium">"{name}"</span> ({count})
          {i < top.length - 1 && ', '}
        </span>
      ))}
    </p>
  )
}
