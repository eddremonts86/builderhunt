import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Activity, Users, Database, Cpu, RefreshCw } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'

interface MetricsResponse {
  inProcess: {
    searches: number
    searchCacheHits: number
    apiRequests: number
    apiErrors: number
    signups: number
    signins: number
    uptimeSeconds: number
  }
  db: {
    totalUsers: number
    newUsersLast24h: number
    newUsersLast7d: number
    totalSavedQueries: number
    totalBuilders: number
    totalNotes: number
  }
  server: {
    nodeVersion: string
    platform: string
    pid: number
    memoryUsage: { rss: number; heapTotal: number; heapUsed: number; external: number }
  }
}

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)

export const Route = createFileRoute('/_dashboard/admin/metrics')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (ADMIN_IDS.length === 0 || !ADMIN_IDS.includes(user.userId)) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: AdminMetricsPage,
})

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function AdminMetricsPage() {
  const [data, setData] = React.useState<MetricsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/metrics', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      setData(await res.json())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
    const id = setInterval(load, 15000)
    return () => clearInterval(id)
  }, [load])

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto" data-testid="admin-metrics-page">
        <p className="text-bh-text-muted">Loading…</p>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="p-6 max-w-4xl mx-auto" data-testid="admin-metrics-page">
        <p className="text-bh-danger">{error ?? 'No data'}</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-4xl mx-auto" data-testid="admin-metrics-page">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="w-6 h-6 text-bh-accent" aria-hidden="true" />
            Metrics
          </h1>
          <p className="text-sm text-bh-text-muted mt-1">
            In-process counters + DB aggregates. Auto-refreshes every 15s.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="btn-ghost btn-sm"
          aria-label="Refresh"
          data-testid="admin-metrics-refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6" data-testid="metrics-inprocess">
        <h2 className="sr-only">In-process metrics</h2>
        <MetricCard label="Searches" value={data.inProcess.searches} />
        <MetricCard label="Cache hits" value={data.inProcess.searchCacheHits} />
        <MetricCard label="API requests" value={data.inProcess.apiRequests} />
        <MetricCard label="API errors" value={data.inProcess.apiErrors} />
        <MetricCard label="Signups" value={data.inProcess.signups} />
        <MetricCard label="Signins" value={data.inProcess.signins} />
      </section>

      <section className="card p-5 mb-6" data-testid="metrics-db">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Database className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Database
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricCard label="Total users" value={data.db.totalUsers} />
          <MetricCard label="New (24h)" value={data.db.newUsersLast24h} />
          <MetricCard label="New (7d)" value={data.db.newUsersLast7d} />
          <MetricCard label="Saved queries" value={data.db.totalSavedQueries} />
          <MetricCard label="Builders" value={data.db.totalBuilders} />
          <MetricCard label="Notes" value={data.db.totalNotes} />
        </div>
      </section>

      <section className="card p-5" data-testid="metrics-server">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Cpu className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Server
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div>
            <p className="text-bh-text-dim text-xs">Uptime</p>
            <p className="font-semibold">{formatUptime(data.inProcess.uptimeSeconds)}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Node</p>
            <p className="font-mono text-xs">{data.server.nodeVersion}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Platform</p>
            <p className="font-mono text-xs">{data.server.platform}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">PID</p>
            <p className="font-mono text-xs">{data.server.pid}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">RSS</p>
            <p className="font-mono text-xs">{formatBytes(data.server.memoryUsage.rss)}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Heap total</p>
            <p className="font-mono text-xs">{formatBytes(data.server.memoryUsage.heapTotal)}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Heap used</p>
            <p className="font-mono text-xs">{formatBytes(data.server.memoryUsage.heapUsed)}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">External</p>
            <p className="font-mono text-xs">{formatBytes(data.server.memoryUsage.external)}</p>
          </div>
        </div>
      </section>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-3" data-testid={`metric-card-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <p className="text-xs text-bh-text-dim mb-1">{label}</p>
      <p className="text-2xl font-bold text-bh-text">{value.toLocaleString()}</p>
    </div>
  )
}
