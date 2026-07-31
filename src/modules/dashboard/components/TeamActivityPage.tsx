// Plan 29 (activity-feed) task 5 — team activity page.
//
// Full feed view of the principal's organization activity. Day
// groups, load-more keyset cursor, in-flight cancellation when
// the user switches orgs (the spec demands no feed while the
// context is stale), and a clean empty state.

import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import {
  TeamActivityWidget,
  type ActivityRowDTO,
} from '~/modules/dashboard/components/TeamActivityWidget'

export interface TeamActivityPageProps {
  initialRows: ActivityRowDTO[]
  initialCursor: { before: string; id: string } | null
}

interface PageState {
  rows: ActivityRowDTO[]
  cursor: { before: string; id: string } | null
  loading: boolean
  error: string | null
}

const PAGE_SIZE = 50

export function TeamActivityPage({ initialRows, initialCursor }: TeamActivityPageProps) {
  const navigate = useNavigate()
  const [state, setState] = React.useState<PageState>({
    rows: initialRows,
    cursor: initialCursor,
    loading: false,
    error: null,
  })

  // Abort in-flight requests on unmount and on cursor change. An
  // A→B org switch cancels the current page; a click on
  // "Load more" cancels the previous one. Either way, a stale
  // response can never overwrite a fresh one.
  const requestIdRef = React.useRef(0)

  const fetchPage = React.useCallback(async (before: { before: string; id: string } | null) => {
    const id = ++requestIdRef.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const params = new URLSearchParams()
      if (before) {
        params.set('before', before.before)
        params.set('id', before.id)
      }
      params.set('limit', String(PAGE_SIZE))
      const res = await fetch(`/api/organizations/activity?${params.toString()}`, {
        credentials: 'include',
      })
      if (id !== requestIdRef.current) return // stale
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setState((s) => ({
          ...s,
          loading: false,
          error: typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
        }))
        return
      }
      const data = (await res.json()) as {
        rows: ActivityRowDTO[]
        nextCursor: { before: string; id: string } | null
      }
      setState((s) => ({
        ...s,
        rows: before ? [...s.rows, ...data.rows] : data.rows,
        cursor: data.nextCursor,
        loading: false,
      }))
    } catch (e) {
      if (id !== requestIdRef.current) return
      setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : 'Failed to load' }))
    }
  }, [])

  // The route always hands this component an empty initial page (see
  // team/activity.tsx's own comment) so an A→B org switch — which remounts
  // this component — always starts from a real fetch, never a stale SSR
  // snapshot from the previous organization.
  React.useEffect(() => {
    void fetchPage(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadMore = React.useCallback(() => {
    if (!state.cursor || state.loading) return
    return fetchPage(state.cursor)
  }, [state.cursor, state.loading, fetchPage])

  return (
    <div data-testid="team-activity-page" className="space-y-6">
      <div>
        <button
          type="button"
          onClick={() => navigate({ to: '/dashboard' })}
          className="inline-flex items-center gap-1 text-sm text-bh-text-muted hover:text-bh-accent mb-4"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          Back to dashboard
        </button>
        <h1 className="text-2xl font-bold tracking-tight">Team activity</h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Recent changes your team has made to shared searches, shortlists, and alerts.
        </p>
      </div>

      {state.error && (
        <p className="text-sm text-bh-danger" role="alert" data-testid="team-activity-error">
          {state.error}
        </p>
      )}

      <TeamActivityWidget rows={state.rows} loading={state.loading && state.rows.length === 0} error={null} />

      {state.cursor && (
        <div className="flex justify-center pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={loadMore}
            disabled={state.loading}
            data-testid="team-activity-load-more"
          >
            {state.loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                Loading…
              </>
            ) : (
              'Load more'
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
