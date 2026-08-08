// table-surface: sprintResultsCapability
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Compass, Loader2, Sparkles } from 'lucide-react'
import * as React from 'react'

import { Input } from '~/components/ui'
import { Button } from '~/components/ui/button'
import { useEntityBreadcrumbLabel } from '~/modules/dashboard/ui/shell/breadcrumb-context'
import { BuilderResultActions } from '~/modules/search/components/BuilderResultActions'
import { ai } from '~/shared/lib/ai/client'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { DataTable } from '~/shared/components/table'
import {
  SPRINT_RESULT_FILTER_LABELS,
} from '~/shared/lib/table/capabilities/sprint-results'
import {
  pickTableSearchParams,
  serializeTableSearch,
  tableSearchSchema,
  tableSearchToParams,
} from '~/shared/lib/table/query-url'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery, TableSearch } from '~/shared/lib/table/types'
import { sprintProgressPercent, type QueryVariant, type SprintCursor, type SprintFilter } from '~/shared/lib/sprints-shared'

export const Route = createFileRoute('/_dashboard/sprints/$sprintId/')({
  // The table's whole state — search, filters, sort, group, cursor — is the URL, so a filtered
  // view of a sprint is a link somebody can paste into a thread.
  //
  // It returns the *flat params*, not a parsed `TableSearch`: TanStack Router re-serializes
  // whatever `validateSearch` returns, so returning the parsed object would put a JSON blob in the
  // address bar instead of `?sort=score:desc&filter.source=github`.
  validateSearch: (raw: Record<string, unknown>) => ({
    ...pickTableSearchParams(raw),
    ...(typeof raw.minFollowers === 'string' && raw.minFollowers !== ''
      ? { minFollowers: raw.minFollowers }
      : {}),
  }),
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
  /**
   * Sourcing **progress** — which variant and page the worker has reached. Feeds the progress bar.
   * Not pagination: that is `search.page.cursor`, and the two are unrelated.
   */
  cursor: SprintCursor
  variants: QueryVariant[]
}

interface ResultRow extends Record<string, unknown> {
  id: string
  source: string
  sourceId: string
  profile: {
    username: string
    displayName?: string
    avatarUrl?: string
    bio?: string
    profileUrl: string
    followersCount?: number
    language?: string
    country?: string
    topics: string[]
  }
  matchedVariant: string
  score: number
  createdAt: string
  tracked: boolean
}

/** Chat-style history for filter-refine — client state only, not persisted. */
interface RefineTurn {
  instruction: string
  explanation: string
}

const EMPTY_PAGE: PageResult<ResultRow> = { rows: [], nextCursor: null, total: 0, facets: {} }

function SprintDossierPage() {
  const { sprintId } = Route.useParams()
  const params = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const search = React.useMemo(() => tableSearchSchema(params), [params])

  const [sprint, setSprint] = React.useState<SprintDetail | null>(null)
  const [page, setPage] = React.useState<PageResult<ResultRow>>(EMPTY_PAGE)
  const [status, setStatus] = React.useState<'ready' | 'loading' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = React.useState('')

  /**
   * The one filter the shared table contract cannot express.
   *
   * `TableQuery.filters` is set membership; this is a range. It stays a surface control with its
   * own search param rather than growing the shared contract a range operator for one table.
   */
  const appliedMinFollowers = typeof params.minFollowers === 'string' ? params.minFollowers : ''
  const [minFollowersInput, setMinFollowersInput] = React.useState(appliedMinFollowers)

  const [instruction, setInstruction] = React.useState('')
  const [refining, setRefining] = React.useState(false)
  const [refineHistory, setRefineHistory] = React.useState<RefineTurn[]>([])

  // Keyed by this sprint result's own id → the organization-builder id, populated only by a track
  // that happens in this session — the API reports `tracked` but not the row id for a builder
  // tracked in an earlier session (the same gap as the alerts inbox).
  const [trackedRowIds, setTrackedRowIds] = React.useState<Map<string, string>>(new Map())

  useEntityBreadcrumbLabel(sprint?.name ?? null)

  const requestUrl = React.useCallback((next: TableSearch, minFollowers: string) => {
    const params = tableSearchToParams(next)
    if (minFollowers !== '') params.set('minFollowers', minFollowers)
    return `/api/sprints/${sprintId}/results?${params.toString()}`
  }, [sprintId])

  /**
   * Fetch one page.
   *
   * `append` is what a cursor page does — the loaded set grows and the virtualizer bounds the DOM.
   * A query change replaces instead, because a cursor minted for the previous sort is rejected by
   * signature and the first page of the new order is a different list.
   */
  const load = React.useCallback(async (next: TableSearch, minFollowers: string, append: boolean) => {
    setStatus('loading')
    try {
      const response = await fetch(requestUrl(next, minFollowers), { credentials: 'include' })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        setErrorMessage(body?.error ?? `Could not load results (${response.status})`)
        setStatus('error')
        return
      }
      const data = await response.json() as PageResult<ResultRow>
      setPage((current) => append
        ? { ...data, rows: [...current.rows, ...data.rows] }
        : data)
      setStatus('ready')
    } catch {
      setErrorMessage('Could not reach the server')
      setStatus('error')
    }
  }, [requestUrl])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const response = await fetch(`/api/sprints/${sprintId}`, { credentials: 'include' })
      if (!cancelled) setSprint(response.ok ? await response.json() : null)
    })()
    return () => { cancelled = true }
  }, [sprintId])

  // Every table interaction writes the URL; this reads it back and fetches. One direction of data
  // flow, so the list and the link can never disagree.
  const searchKey = JSON.stringify(params)
  React.useEffect(() => {
    void load(search, appliedMinFollowers, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey, sprintId])

  const onQueryChange = React.useCallback((query: TableQuery) => {
    // Dropping the cursor is mandatory, not tidiness: a cursor carries the sort it was minted for,
    // and presenting it under a different one is a 400 by design.
    const next = serializeTableSearch({ ...search, query, page: { ...search.page, cursor: null } })
    void navigate({
      search: { ...next, ...(appliedMinFollowers !== '' ? { minFollowers: appliedMinFollowers } : {}) },
      replace: true,
    })
  }, [navigate, search, appliedMinFollowers])

  const applyMinFollowers = React.useCallback((value: string) => {
    const next = serializeTableSearch({ ...search, page: { ...search.page, cursor: null } })
    void navigate({ search: { ...next, ...(value !== '' ? { minFollowers: value } : {}) }, replace: true })
  }, [navigate, search])

  const loadMore = React.useCallback(() => {
    if (!page.nextCursor || status === 'loading') return
    void load({ ...search, page: { ...search.page, cursor: page.nextCursor } }, appliedMinFollowers, true)
  }, [page.nextCursor, status, load, search, appliedMinFollowers])

  const refine = async () => {
    if (instruction.trim().length < 2) return
    const submitted = instruction.trim()
    setRefining(true)
    try {
      const current: SprintFilter = { keywords: search.query.search === '' ? [] : [search.query.search] }
      const result = await ai<{ filters: SprintFilter; explanation: string }>('filter-refine', {
        filters: current,
        instruction: submitted,
      })
      const filters: Record<string, string[]> = { ...search.query.filters }
      if (result.output.filters.sources && result.output.filters.sources.length > 0) {
        filters.source = [...result.output.filters.sources]
      }
      if (result.output.filters.country) filters.country = [result.output.filters.country]
      setRefineHistory((prev) => [...prev, { instruction: submitted, explanation: result.output.explanation }])
      setInstruction('')
      if (result.output.filters.minFollowers != null) {
        setMinFollowersInput(String(result.output.filters.minFollowers))
      }
      onQueryChange({
        ...search.query,
        // The refiner returns a keyword list; the contract carries one search term, so they are
        // joined. Multi-keyword OR is the one behaviour this migration does not reproduce.
        search: result.output.filters.keywords.join(' '),
        filters,
      })
    } catch {
      setRefineHistory((prev) => [...prev, { instruction: submitted, explanation: 'AI refinement unavailable — use the filters above.' }])
      setInstruction('')
    } finally {
      setRefining(false)
    }
  }

  const columns = React.useMemo<ColumnDef<ResultRow>[]>(() => [
    {
      id: 'builder',
      header: 'Builder',
      priority: 'primary',
      value: (row) => row.profile.displayName ?? row.profile.username,
      cell: (row) => (
        <a
          href={row.profile.profileUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="flex min-w-0 items-center gap-2 hover:underline"
        >
          {row.profile.avatarUrl && (
            <img src={row.profile.avatarUrl} alt="" className="h-6 w-6 shrink-0 rounded-full" loading="lazy" />
          )}
          <span className="truncate">{row.profile.displayName ?? row.profile.username}</span>
        </a>
      ),
    },
    {
      id: 'source',
      header: 'Source',
      sortable: true,
      groupable: true,
      value: (row) => row.source,
      cell: (row) => row.source,
    },
    {
      id: 'country',
      header: 'Country',
      groupable: true,
      priority: 'secondary',
      value: (row) => row.profile.country ?? null,
      cell: (row) => row.profile.country ?? '—',
    },
    {
      id: 'followers',
      header: 'Followers',
      align: 'end',
      priority: 'secondary',
      value: (row) => row.profile.followersCount ?? 0,
      cell: (row) => (row.profile.followersCount ?? 0).toLocaleString(),
    },
    {
      id: 'score',
      header: 'Score',
      sortable: true,
      align: 'end',
      value: (row) => row.score,
      cell: (row) => row.score,
    },
    {
      id: 'createdAt',
      header: 'Found',
      sortable: true,
      align: 'end',
      priority: 'detail',
      value: (row) => row.createdAt,
      cell: (row) => new Date(row.createdAt).toLocaleDateString(),
    },
    {
      id: 'actions',
      header: 'Actions',
      priority: 'secondary',
      cell: (row) => {
        const trackedRowId = trackedRowIds.get(row.id) ?? null
        return (
          <BuilderResultActions
            builder={{
              id: row.id,
              source: row.source,
              sourceId: row.sourceId,
              username: row.profile.username,
              displayName: row.profile.displayName,
              avatarUrl: row.profile.avatarUrl,
              bio: row.profile.bio,
              profileUrl: row.profile.profileUrl,
              followersCount: row.profile.followersCount,
              topics: row.profile.topics,
              score: row.score,
              tracked: row.tracked || trackedRowId !== null,
              trackedRowId,
            }}
            from={`/sprints/${sprintId}`}
            onTracked={(organizationBuilderId) => {
              setTrackedRowIds((prev) => new Map(prev).set(row.id, organizationBuilderId))
            }}
          />
        )
      },
    },
  ], [sprintId, trackedRowIds])

  return (
    <div data-testid="sprint-dossier">
      <div className="mb-1 flex items-center gap-2">
        <Compass className="h-5 w-5 text-bh-accent" />
        <h1 className="text-xl font-bold text-bh-text">{sprint?.name ?? 'Sprint'}</h1>
      </div>
      {sprint && (
        <>
          <p className="mb-1.5 text-xs text-bh-text-dim">
            {sprint.status} · quota {sprint.quota} · {page.total} results · last run{' '}
            {sprint.lastRunAt ? new Date(sprint.lastRunAt).toLocaleString() : 'never'}
          </p>
          <div className="mb-6 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-bh-surface/60" data-testid="sprint-progress">
            <div
              className="h-full rounded-full bg-bh-accent transition-all"
              style={{ width: `${sprintProgressPercent(sprint.status, sprint.cursor, sprint.variants.length)}%` }}
            />
          </div>
        </>
      )}

      <div className="card mb-4 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-40 shrink-0">
            <Input
              value={minFollowersInput}
              onChange={(event) => setMinFollowersInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') applyMinFollowers(minFollowersInput) }}
              placeholder="Min followers"
              aria-label="Minimum followers"
              className="text-sm"
              data-testid="sprint-min-followers"
            />
          </div>
          <Button
            type="button"
            onClick={() => applyMinFollowers(minFollowersInput)}
            variant="secondary"
            className="px-3 py-2 text-sm"
            data-testid="sprint-apply-min-followers"
          >
            Apply
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void refine() }}
            placeholder='Refine with AI, e.g. "only github, remote"'
            className="flex-1 text-sm"
            data-testid="sprint-refine-input"
          />
          <Button
            type="button"
            onClick={() => void refine()}
            disabled={refining}
            variant="secondary"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm"
            data-testid="sprint-refine-button"
          >
            {refining ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Refine
          </Button>
        </div>
        {refineHistory.length > 0 && (
          <ul className="max-h-48 space-y-2 overflow-y-auto" data-testid="sprint-refine-history">
            {refineHistory.map((turn, index) => (
              <li key={index} className="text-xs">
                <p className="font-medium text-bh-text">“{turn.instruction}”</p>
                <p className="text-bh-text-dim">{turn.explanation}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <DataTable
        label="Sprint results"
        columns={columns}
        page={page}
        query={search.query}
        onQueryChange={onQueryChange}
        renderer={search.query.groupBy ? 'grouped' : 'table'}
        rowTestId={(row) => `sprint-result-${row.id}`}
        status={status}
        error={{ message: errorMessage, onRetry: () => void load(search, appliedMinFollowers, false) }}
        onLoadMore={loadMore}
        filterLabels={SPRINT_RESULT_FILTER_LABELS}
        emptyState={(
          <div className="px-4 py-12 text-center text-sm text-bh-text-dim" data-testid="sprint-empty">
            No results yet. The background worker fills this in over time.
          </div>
        )}
      />
    </div>
  )
}
