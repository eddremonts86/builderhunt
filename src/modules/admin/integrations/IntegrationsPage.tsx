// table-surface-bounded: source register and AI task registry — both one row per code-side entry, read whole. Still <table> markup rather than the shell: plans/phase-3/08 tracks that migration, which is a UI-consistency task and not a pagination one.
import * as React from 'react'
import { AlertTriangle, BookOpen, CheckCircle2, ExternalLink, MinusCircle, XCircle } from 'lucide-react'
import { Button } from '~/components/ui'

interface SourceRow {
  source: string
  label: string
  trackable: boolean
  dormantReason: string | null
  credentialRequired: boolean
  credentialPresent: boolean
  killSwitchEnabled: boolean | null
  quota: null
  lastSuccessAt: null
  lastFailureAt: null
  indexedCount: null
  backlogCount: null
}

interface AITaskRow {
  taskId: string
  tier: 'local-first' | 'server-only'
  sensitive: boolean
  version: string
  disabled: boolean
}

interface IntegrationsResponse {
  sources: SourceRow[]
  aiTasks: AITaskRow[]
  aiGloballyDisabled: boolean
  aiProviderAvailable: boolean
  aiBudgetDenials: number
  enrichmentEnabled: boolean
  discovery: { cursor: number; lastRunAt: string | null; stats: unknown } | null
  generatedAt: string
}

const RUNBOOK_PATH = 'docs/operations/deploy-runbook.md'

type SourceFilter = 'all' | 'active' | 'dormant' | 'attention'

function sourceNeedsAttention(row: SourceRow): boolean {
  if (row.killSwitchEnabled === false) return true
  if (row.credentialRequired && !row.credentialPresent) return true
  return false
}

function SourceBadge({ row }: { row: SourceRow }) {
  if (!row.trackable) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-surface text-bh-text-muted" data-testid={`integration-badge-${row.source}`}>
        Dormant
      </span>
    )
  }
  if (row.killSwitchEnabled === false) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-surface text-bh-text-muted" data-testid={`integration-badge-${row.source}`}>
        Disabled
      </span>
    )
  }
  if (row.credentialRequired && !row.credentialPresent) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-warning/15 text-bh-warning" data-testid={`integration-badge-${row.source}`}>
        <AlertTriangle className="size-3" aria-hidden />
        No credential
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-success/15 text-bh-success" data-testid={`integration-badge-${row.source}`}>
      <CheckCircle2 className="size-3" aria-hidden />
      Active
    </span>
  )
}

function CredentialCell({ row }: { row: SourceRow }) {
  if (!row.credentialRequired) {
    return <span className="text-bh-text-dim">Not required</span>
  }
  return row.credentialPresent ? (
    <span className="inline-flex items-center gap-1 text-bh-success"><CheckCircle2 className="size-3.5" aria-hidden />Present</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-bh-danger"><XCircle className="size-3.5" aria-hidden />Missing</span>
  )
}

export function IntegrationsPage() {
  const [data, setData] = React.useState<IntegrationsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState<SourceFilter>('all')

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/integrations', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      setData(await res.json())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  const sources = React.useMemo(() => {
    if (!data) return []
    switch (filter) {
      case 'active': return data.sources.filter((s) => s.trackable && s.killSwitchEnabled !== false && !sourceNeedsAttention(s))
      case 'dormant': return data.sources.filter((s) => !s.trackable || s.killSwitchEnabled === false)
      case 'attention': return data.sources.filter(sourceNeedsAttention)
      default: return data.sources
    }
  }, [data, filter])

  const attentionCount = data?.sources.filter(sourceNeedsAttention).length ?? 0

  return (
    <div data-testid="admin-integrations-page">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
          <p className="text-sm text-bh-text-muted mt-1">
            Every builder source and AI task this deployment knows about, and whether it can actually run.
            {attentionCount > 0 && (
              <span className="ml-2 text-bh-warning font-medium" data-testid="integrations-attention-count">
                {attentionCount} need{attentionCount === 1 ? 's' : ''} attention
              </span>
            )}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={load} data-testid="integrations-refresh">Refresh</Button>
      </header>

      {loading ? (
        <p className="text-bh-text-muted">Loading…</p>
      ) : error ? (
        <p className="text-bh-danger" role="alert">{error}</p>
      ) : data ? (
        <>
          <section className="card p-4 mb-6" data-testid="integrations-ai-summary">
            <h2 className="font-semibold text-sm mb-3">AI platform</h2>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wider text-bh-text-dim mb-1">Kill switch</dt>
                <dd className={data.aiGloballyDisabled ? 'text-bh-danger font-medium' : 'text-bh-success font-medium'}>
                  {data.aiGloballyDisabled ? 'All AI disabled' : 'On'}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-bh-text-dim mb-1">Provider</dt>
                <dd className={data.aiProviderAvailable ? 'text-bh-success font-medium' : 'text-bh-danger font-medium'} data-testid="integrations-provider-availability">
                  {data.aiProviderAvailable ? 'Available' : 'Unavailable — no API key configured'}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-bh-text-dim mb-1">Budget denials (process lifetime)</dt>
                <dd className="font-medium">{data.aiBudgetDenials}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-bh-text-dim mb-1">Profile enrichment</dt>
                <dd className={data.enrichmentEnabled ? 'text-bh-success font-medium' : 'text-bh-text-muted font-medium'}>
                  {data.enrichmentEnabled ? 'Enabled' : 'Disabled'}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-3 mt-4 text-xs">
              <a href="/admin/operations" className="inline-flex items-center gap-1 text-bh-accent hover:underline" data-testid="integrations-link-operations">
                Operations <ExternalLink className="size-3" aria-hidden />
              </a>
              <a href="/admin/metrics" className="inline-flex items-center gap-1 text-bh-accent hover:underline" data-testid="integrations-link-metrics">
                Metrics <ExternalLink className="size-3" aria-hidden />
              </a>
            </div>
          </section>

          <div className="mb-4 flex items-center gap-2" role="group" aria-label="Filter sources">
            {(['all', 'active', 'dormant', 'attention'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                data-testid={`integrations-filter-${f}`}
                className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${
                  filter === f ? 'bg-bh-accent text-white' : 'bg-bh-surface text-bh-text-muted hover:text-bh-text'
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto mb-6">
            <table className="w-full text-sm" data-testid="integrations-sources-table">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-bh-text-dim border-b border-bh-border">
                  <th className="py-2 pr-4">Source</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Credential</th>
                  <th className="py-2 pr-4">Quota</th>
                  <th className="py-2 pr-4">Last success</th>
                  <th className="py-2 pr-4">Last failure</th>
                  <th className="py-2 pr-4">Indexed / backlog</th>
                  <th className="py-2 pr-4">Search</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((row) => (
                  <tr key={row.source} className="border-b border-bh-border/50" data-testid={`integration-row-${row.source}`}>
                    <td className="py-2.5 pr-4 font-medium text-bh-text">{row.label}</td>
                    <td className="py-2.5 pr-4">
                      <div className="flex flex-col gap-0.5">
                        <SourceBadge row={row} />
                        {row.dormantReason && <span className="text-xs text-bh-text-dim">{row.dormantReason}</span>}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4"><CredentialCell row={row} /></td>
                    <td className="py-2.5 pr-4 text-bh-text-dim">Not tracked</td>
                    <td className="py-2.5 pr-4 text-bh-text-dim">Not tracked</td>
                    <td className="py-2.5 pr-4 text-bh-text-dim">Not tracked</td>
                    <td className="py-2.5 pr-4 text-bh-text-dim">Not tracked</td>
                    <td className="py-2.5 pr-4">
                      <a href={`/search?sources=${encodeURIComponent(row.source)}`} className="inline-flex items-center gap-1 text-bh-accent hover:underline text-xs" data-testid={`integration-search-link-${row.source}`}>
                        View <ExternalLink className="size-3" aria-hidden />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sources.length === 0 && <p className="text-bh-text-muted py-6 text-center">No sources match this filter.</p>}
          </div>

          <div className="overflow-x-auto mb-6">
            <h2 className="font-semibold text-sm mb-3">AI tasks</h2>
            <table className="w-full text-sm" data-testid="integrations-ai-tasks-table">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-bh-text-dim border-b border-bh-border">
                  <th className="py-2 pr-4">Task</th>
                  <th className="py-2 pr-4">Tier</th>
                  <th className="py-2 pr-4">Version</th>
                  <th className="py-2 pr-4">State</th>
                </tr>
              </thead>
              <tbody>
                {data.aiTasks.map((task) => (
                  <tr key={task.taskId} className="border-b border-bh-border/50" data-testid={`integration-ai-task-${task.taskId}`}>
                    <td className="py-2.5 pr-4 font-medium text-bh-text font-mono text-xs">{task.taskId}</td>
                    <td className="py-2.5 pr-4 text-bh-text-muted">{task.tier}</td>
                    <td className="py-2.5 pr-4 text-bh-text-dim">v{task.version}</td>
                    <td className="py-2.5 pr-4">
                      {task.disabled ? (
                        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-surface text-bh-text-muted">
                          <MinusCircle className="size-3" aria-hidden />Disabled
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-success/15 text-bh-success">
                          <CheckCircle2 className="size-3" aria-hidden />Enabled
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <section className="card p-4" data-testid="integrations-runbook">
        <h2 className="font-semibold text-sm flex items-center gap-2 mb-1">
          <BookOpen className="w-4 h-4" aria-hidden="true" />
          Runbook
        </h2>
        <p className="text-xs text-bh-text-muted">
          For credential rotation, kill-switch procedures, and provider incident response, see{' '}
          <code className="text-xs">{RUNBOOK_PATH}</code> in the repository.
        </p>
      </section>
    </div>
  )
}
