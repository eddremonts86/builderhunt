import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Compass, Plus, Trash2, Pause, Play, PlayCircle, Loader2 } from 'lucide-react'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { sprintProgressPercent, type QueryVariant, type SprintCursor } from '~/shared/lib/sprints-shared'
import { Button } from '~/components/ui/button'
import { LinkButton } from '~/components/ui/link'

interface SprintRow {
  id: string
  name: string
  status: 'active' | 'paused' | 'completed'
  quota: number
  lastRunAt: string | null
  createdAt: string
  resultCount: number
  variants: QueryVariant[]
  cursor: SprintCursor
}

export const Route = createFileRoute('/_dashboard/sprints/')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    const isAdmin = await getIsAppAdmin()
    return { user, isAdmin }
  },
  component: SprintsListPage,
})

const STATUS_LABEL: Record<SprintRow['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
}

function sprintProgress(sprint: SprintRow): number {
  return sprintProgressPercent(sprint.status, sprint.cursor, sprint.variants.length)
}

function SprintsListPage() {
  const { isAdmin } = Route.useRouteContext()
  const [sprints, setSprints] = React.useState<SprintRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [runningJob, setRunningJob] = React.useState(false)
  const [runNote, setRunNote] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/sprints', { credentials: 'include' })
      setSprints(res.ok ? await res.json() : [])
    } catch {
      setSprints([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const runJobNow = async () => {
    setRunningJob(true)
    setRunNote(null)
    setError(null)
    try {
      const res = await fetch('/api/admin/sprints/run-worker', { method: 'POST', credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'Failed to run the sourcing job')
        return
      }
      setRunNote('Job run triggered — refreshing results…')
      await load()
    } finally {
      setRunningJob(false)
    }
  }

  const toggle = async (sprint: SprintRow) => {
    setError(null)
    const action = sprint.status === 'active' ? 'pause' : 'resume'
    const res = await fetch(`/api/sprints/${sprint.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Failed to update sprint')
      return
    }
    await load()
  }

  const remove = async (sprint: SprintRow) => {
    if (!window.confirm(`Delete sprint "${sprint.name}"? This also deletes its results.`)) return
    await fetch(`/api/sprints/${sprint.id}`, { method: 'DELETE', credentials: 'include' })
    await load()
  }

  return (
    <div data-testid="sprints-page">
      {/* Both levels wrap: the title and the action group as siblings, and the action group internally.
          "Run job now" plus "New sprint" is 208px of buttons, which does not fit beside a title at 320px. */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-2">
          <Compass className="w-5 h-5 text-bh-accent" />
          <h1 className="text-xl font-bold text-bh-text">Sourcing sprints</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <Button
              type="button"
              onClick={runJobNow}
              disabled={runningJob}
              variant="secondary"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
              data-testid="sprint-run-job-button"
              title="Manually run the sourcing worker now instead of waiting for the next scheduled run"
            >
              {runningJob ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
              Run job now
            </Button>
          )}
          <LinkButton to="/sprints/new" variant="primary" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm">
            <Plus className="w-4 h-4" /> New sprint
          </LinkButton>
        </div>
      </div>

      {runNote && <p className="text-sm text-bh-text-dim mb-4">{runNote}</p>}
      {error && <p className="text-sm text-bh-danger mb-4">{error}</p>}

      {loading ? (
        <p className="text-sm text-bh-text-dim">Loading…</p>
      ) : sprints.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-bh-text-muted mb-3">
            No sourcing sprints yet. A sprint saves a set of search-query variants and re-runs them in the
            background until it reaches a result quota.
          </p>
          <LinkButton to="/sprints/new" variant="primary" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm">
            <Plus className="w-4 h-4" /> Start a sprint
          </LinkButton>
        </div>
      ) : (
        <ul className="space-y-3">
          {sprints.map((sprint) => (
            <li key={sprint.id} className="card p-4 flex items-center justify-between gap-4" data-testid="sprint-row">
              <Link to="/sprints/$sprintId" params={{ sprintId: sprint.id }} search={{}} className="min-w-0 flex-1">
                <p className="font-medium text-bh-text truncate">{sprint.name}</p>
                <p className="text-xs text-bh-text-dim">
                  {STATUS_LABEL[sprint.status]} · {sprint.resultCount} candidates found · last run{' '}
                  {sprint.lastRunAt ? new Date(sprint.lastRunAt).toLocaleString() : 'never'}
                </p>
                <div className="mt-1.5 h-1 w-full max-w-xs rounded-full bg-bh-surface/60 overflow-hidden" data-testid="sprint-progress">
                  <div
                    className="h-full rounded-full bg-bh-accent transition-all"
                    style={{ width: `${sprintProgress(sprint)}%` }}
                  />
                </div>
              </Link>
              <div className="flex items-center gap-2 shrink-0">
                {sprint.status !== 'completed' && (
                  <button
                    type="button"
                    onClick={() => toggle(sprint)}
                    className="p-2 rounded-md hover:bg-bh-surface/60 text-bh-text-dim"
                    aria-label={sprint.status === 'active' ? 'Pause sprint' : 'Resume sprint'}
                  >
                    {sprint.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => remove(sprint)}
                  className="p-2 rounded-md hover:bg-bh-surface/60 text-bh-text-dim"
                  aria-label="Delete sprint"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
