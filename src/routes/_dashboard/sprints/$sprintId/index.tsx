import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Compass, Loader2, Sparkles } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { ai } from '~/shared/lib/ai/client'
import { PersonResultCard, type PersonCardData } from '~/modules/search/components/PersonResultCard'
import type { SprintFilter } from '~/shared/lib/sprints-shared'

export const Route = createFileRoute('/_dashboard/sprints/$sprintId/')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  component: SprintDossierPage,
})

interface SprintDetail {
  id: string
  name: string
  status: 'active' | 'paused' | 'completed'
  quota: number
  lastRunAt: string | null
}

interface ResultItem {
  id: string
  source: string
  sourceId: string
  profile: { username: string; displayName?: string; avatarUrl?: string; bio?: string; profileUrl: string; followersCount?: number; language?: string; country?: string; topics: string[] }
  matchedVariant: string
  score: number
  createdAt: string
  tracked: boolean
}

interface Facet { location: string; count: number }

function SprintDossierPage() {
  const { sprintId } = Route.useParams()
  const [sprint, setSprint] = React.useState<SprintDetail | null>(null)
  const [items, setItems] = React.useState<ResultItem[]>([])
  const [facets, setFacets] = React.useState<Facet[]>([])
  const [total, setTotal] = React.useState(0)
  const [sort, setSort] = React.useState<'score' | 'date'>('score')
  const [filter, setFilter] = React.useState<SprintFilter>({ keywords: [] })
  const [keywordInput, setKeywordInput] = React.useState('')
  const [minFollowersInput, setMinFollowersInput] = React.useState('')
  const [instruction, setInstruction] = React.useState('')
  const [refining, setRefining] = React.useState(false)
  const [refineNote, setRefineNote] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [trackedIds, setTrackedIds] = React.useState<Set<string>>(new Set())

  const load = React.useCallback(async (nextFilter: SprintFilter, nextSort: 'score' | 'date') => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ sort: nextSort })
      if (nextFilter.keywords.length > 0) params.set('keywords', nextFilter.keywords.join(','))
      if (nextFilter.minFollowers != null) params.set('minFollowers', String(nextFilter.minFollowers))
      const [sprintRes, resultsRes] = await Promise.all([
        fetch(`/api/sprints/${sprintId}`, { credentials: 'include' }),
        fetch(`/api/sprints/${sprintId}/results?${params.toString()}`, { credentials: 'include' }),
      ])
      setSprint(sprintRes.ok ? await sprintRes.json() : null)
      if (resultsRes.ok) {
        const data = await resultsRes.json()
        setItems(data.items)
        setFacets(data.facets)
        setTotal(data.total)
      }
    } finally {
      setLoading(false)
    }
  }, [sprintId])

  React.useEffect(() => {
    load(filter, sort)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprintId])

  const applyFilters = () => {
    const next: SprintFilter = {
      keywords: keywordInput.split(',').map((v) => v.trim()).filter(Boolean),
      minFollowers: minFollowersInput ? Number(minFollowersInput) : undefined,
    }
    setFilter(next)
    load(next, sort)
  }

  const changeSort = (value: 'score' | 'date') => {
    setSort(value)
    load(filter, value)
  }

  const refine = async () => {
    if (instruction.trim().length < 2) return
    setRefining(true)
    setRefineNote(null)
    try {
      const result = await ai<{ filters: SprintFilter; explanation: string }>('filter-refine', { filters: filter, instruction })
      setFilter(result.output.filters)
      setKeywordInput(result.output.filters.keywords.join(', '))
      setMinFollowersInput(result.output.filters.minFollowers != null ? String(result.output.filters.minFollowers) : '')
      setRefineNote(result.output.explanation)
      load(result.output.filters, sort)
    } catch {
      setRefineNote('AI refinement unavailable — use the manual filters above.')
    } finally {
      setRefining(false)
    }
  }

  const track = async (item: ResultItem) => {
    const res = await fetch('/api/builders/track', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: item.source,
        sourceId: item.sourceId,
        username: item.profile.username,
        displayName: item.profile.displayName ?? null,
        avatarUrl: item.profile.avatarUrl ?? null,
        bio: item.profile.bio ?? null,
        profileUrl: item.profile.profileUrl,
        followersCount: item.profile.followersCount ?? null,
        topics: item.profile.topics,
        score: item.score,
      }),
    })
    if (res.ok) setTrackedIds((prev) => new Set(prev).add(item.id))
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8" data-testid="sprint-dossier">
      <div className="flex items-center gap-2 mb-1">
        <Compass className="w-5 h-5 text-bh-accent" />
        <h1 className="text-xl font-bold text-bh-text">{sprint?.name ?? 'Sprint'}</h1>
      </div>
      {sprint && (
        <p className="text-xs text-bh-text-dim mb-6">
          {sprint.status} · quota {sprint.quota} · {total} results
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-6">
        <div>
          <div className="card p-4 mb-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                placeholder="Filter keywords (comma separated)"
                className="flex-1 min-w-[160px] rounded-md border border-bh-border bg-bh-surface/40 p-2 text-sm text-bh-text"
              />
              <input
                value={minFollowersInput}
                onChange={(e) => setMinFollowersInput(e.target.value)}
                placeholder="Min followers"
                className="w-32 rounded-md border border-bh-border bg-bh-surface/40 p-2 text-sm text-bh-text"
              />
              <select
                value={sort}
                onChange={(e) => changeSort(e.target.value as 'score' | 'date')}
                className="rounded-md border border-bh-border bg-bh-surface/40 p-2 text-sm text-bh-text"
              >
                <option value="score">Sort: score</option>
                <option value="date">Sort: newest</option>
              </select>
              <button type="button" onClick={applyFilters} className="btn-secondary px-3 py-2 text-sm">Apply</button>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder='Refine with AI, e.g. "only github, remote"'
                className="flex-1 rounded-md border border-bh-border bg-bh-surface/40 p-2 text-sm text-bh-text"
              />
              <button
                type="button"
                onClick={refine}
                disabled={refining}
                className="btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-sm"
              >
                {refining ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                Refine
              </button>
            </div>
            {refineNote && <p className="text-xs text-bh-text-dim">{refineNote}</p>}
          </div>

          {loading ? (
            <p className="text-sm text-bh-text-dim">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-bh-text-dim">No results yet. The background worker fills this in over time.</p>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => {
                const cardData: PersonCardData = {
                  id: item.id,
                  username: item.profile.username,
                  displayName: item.profile.displayName,
                  source: item.source,
                  avatarUrl: item.profile.avatarUrl,
                  bio: item.profile.bio,
                  followersCount: item.profile.followersCount,
                  profileUrl: item.profile.profileUrl,
                  topics: item.profile.topics,
                  score: item.score,
                }
                const isTracked = item.tracked || trackedIds.has(item.id)
                return (
                  <li key={item.id} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <PersonResultCard builder={cardData} />
                    </div>
                    <button
                      type="button"
                      onClick={() => track(item)}
                      disabled={isTracked}
                      className="btn-secondary px-3 py-2 text-xs shrink-0"
                      data-testid={`sprint-track-${item.id}`}
                    >
                      {isTracked ? 'Tracked' : 'Track'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <aside className="card p-4 h-fit">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim mb-2">Locations</h2>
          <ul className="space-y-1 text-sm">
            {facets.map((facet) => (
              <li key={facet.location} className="flex justify-between text-bh-text-muted">
                <span>{facet.location}</span>
                <span>{facet.count}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  )
}
