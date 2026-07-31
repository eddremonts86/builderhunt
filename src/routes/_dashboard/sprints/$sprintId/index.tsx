import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Compass, Loader2, Sparkles } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { ai } from '~/shared/lib/ai/client'
import { useEntityBreadcrumbLabel } from '~/modules/dashboard/ui/shell/breadcrumb-context'
import { PersonResultCard, type PersonCardData } from '~/modules/search/components/PersonResultCard'
import { sprintProgressPercent, type QueryVariant, type SprintCursor, type SprintFilter } from '~/shared/lib/sprints-shared'
import { Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'
import { Button } from '~/components/ui/button'

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
  cursor: SprintCursor
  variants: QueryVariant[]
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

// Chat-style history for filter-refine — client state only, not persisted.
interface RefineTurn {
  instruction: string
  explanation: string
}

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
  const [refineHistory, setRefineHistory] = React.useState<RefineTurn[]>([])
  const [loading, setLoading] = React.useState(true)
  const [trackedIds, setTrackedIds] = React.useState<Set<string>>(new Set())

  useEntityBreadcrumbLabel(sprint?.name ?? null)

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
    const submittedInstruction = instruction.trim()
    setRefining(true)
    try {
      const result = await ai<{ filters: SprintFilter; explanation: string }>('filter-refine', { filters: filter, instruction: submittedInstruction })
      setFilter(result.output.filters)
      setKeywordInput(result.output.filters.keywords.join(', '))
      setMinFollowersInput(result.output.filters.minFollowers != null ? String(result.output.filters.minFollowers) : '')
      setRefineHistory((prev) => [...prev, { instruction: submittedInstruction, explanation: result.output.explanation }])
      setInstruction('')
      load(result.output.filters, sort)
    } catch {
      setRefineHistory((prev) => [...prev, { instruction: submittedInstruction, explanation: 'AI refinement unavailable — use the manual filters above.' }])
      setInstruction('')
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
    <div data-testid="sprint-dossier">
      <div className="flex items-center gap-2 mb-1">
        <Compass className="w-5 h-5 text-bh-accent" />
        <h1 className="text-xl font-bold text-bh-text">{sprint?.name ?? 'Sprint'}</h1>
      </div>
      {sprint && (
        <>
          <p className="text-xs text-bh-text-dim mb-1.5">
            {sprint.status} · quota {sprint.quota} · {total} results · last run{' '}
            {sprint.lastRunAt ? new Date(sprint.lastRunAt).toLocaleString() : 'never'}
          </p>
          <div className="h-1.5 w-full max-w-sm rounded-full bg-bh-surface/60 overflow-hidden mb-6" data-testid="sprint-progress">
            <div
              className="h-full rounded-full bg-bh-accent transition-all"
              style={{ width: `${sprintProgressPercent(sprint.status, sprint.cursor, sprint.variants.length)}%` }}
            />
          </div>
        </>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-6">
        <div>
          <div className="card p-4 mb-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                placeholder="Filter keywords (comma separated)"
                className="flex-1 min-w-[160px] text-sm"
              />
              {/* Fixed-width wrappers. Were required when `.input-field` was unlayered
                  CSS whose `width: 100%` beat a plain Tailwind width utility; that root
                  cause is fixed (it now sits in the `components` layer — see
                  globals.css), so `w-32`/`w-40` on the controls themselves would work
                  too. Left alone since they render identically. */}
              <div className="w-32 shrink-0">
                <Input
                  value={minFollowersInput}
                  onChange={(e) => setMinFollowersInput(e.target.value)}
                  placeholder="Min followers"
                  className="text-sm"
                />
              </div>
              <div className="w-40 shrink-0">
                <Select value={sort} onValueChange={(v) => changeSort(v as 'score' | 'date')}>
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="score">Sort: score</SelectItem>
                    <SelectItem value="date">Sort: newest</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" onClick={applyFilters} variant="secondary" className="px-3 py-2 text-sm">Apply</Button>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && refine()}
                placeholder='Refine with AI, e.g. "only github, remote"'
                className="flex-1 text-sm"
                data-testid="sprint-refine-input"
              />
              <Button
                type="button"
                onClick={refine}
                disabled={refining}
                variant="secondary"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm"
                data-testid="sprint-refine-button"
              >
                {refining ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                Refine
              </Button>
            </div>
            {refineHistory.length > 0 && (
              <ul className="space-y-2 max-h-48 overflow-y-auto" data-testid="sprint-refine-history">
                {refineHistory.map((turn, i) => (
                  <li key={i} className="text-xs">
                    <p className="text-bh-text font-medium">“{turn.instruction}”</p>
                    <p className="text-bh-text-dim">{turn.explanation}</p>
                  </li>
                ))}
              </ul>
            )}
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
                    <Button
                      type="button"
                      onClick={() => track(item)}
                      disabled={isTracked}
                      variant="secondary"
                      className="px-3 py-2 text-xs shrink-0"
                      data-testid={`sprint-track-${item.id}`}
                    >
                      {isTracked ? 'Tracked' : 'Track'}
                    </Button>
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
