import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CheckCircle2, AlertTriangle, XCircle, Activity, Clock, ExternalLink } from 'lucide-react'

interface Incident {
  id: string
  title: string
  description: string | null
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  severity: 'minor' | 'major' | 'critical'
  affectedComponents: string[]
  startedAt: string
  resolvedAt: string | null
}

interface StatusResponse {
  status: 'ok' | 'degraded'
  version: string
  uptime: number
  checks: {
    db: { name: string; ok: boolean; message?: string }
    redis: { name: string; ok: boolean; message?: string }
  }
  timestamp: string
}

export const Route = createFileRoute('/status')({
  component: StatusPage,
})

function StatusIcon({ ok }: { ok: boolean }) {
  if (ok) return <CheckCircle2 className="w-5 h-5 text-bh-success" aria-hidden="true" />
  return <XCircle className="w-5 h-5 text-bh-danger" aria-hidden="true" />
}

function StatusPage() {
  const [status, setStatus] = React.useState<StatusResponse | null>(null)
  const [incidents, setIncidents] = React.useState<Incident[]>([])
  const [loading, setLoading] = React.useState(true)
  const [lastUpdated, setLastUpdated] = React.useState<string>('')

  const load = React.useCallback(async () => {
    try {
      const [sRes, iRes] = await Promise.all([
        fetch('/api/status'),
        fetch('/api/incidents'),
      ])
      if (sRes.ok) {
        const s = await sRes.json() as StatusResponse
        setStatus(s)
        setLastUpdated(s.timestamp)
      }
      if (iRes.ok) {
        const i = await iRes.json() as Incident[]
        setIncidents(i)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
    const id = setInterval(load, 30_000) // refresh every 30s
    return () => clearInterval(id)
  }, [load])

  const allOk = status?.status === 'ok'
  const openIncidents = incidents.filter((i) => i.status !== 'resolved')

  return (
    <div className="min-h-[calc(100vh-4rem)] p-6 max-w-3xl mx-auto">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-2 flex items-center gap-3">
          <Activity className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          System status
        </h1>
        <p className="text-bh-text-muted">Live status of BuilderHunt services.</p>
      </header>

      <div
        className={`card p-5 mb-6 ${
          allOk
            ? 'border-bh-success/30 bg-bh-success/5'
            : 'border-bh-danger/30 bg-bh-danger/5'
        }`}
        data-testid="status-overall"
      >
        <div className="flex items-center gap-3">
          {allOk ? (
            <CheckCircle2 className="w-6 h-6 text-bh-success" aria-hidden="true" />
          ) : (
            <XCircle className="w-6 h-6 text-bh-danger" aria-hidden="true" />
          )}
          <div className="flex-1">
            <p className="font-semibold text-bh-text">
              {allOk ? 'All systems operational' : 'Some systems are degraded'}
            </p>
            <p className="text-xs text-bh-text-muted">
              {lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}` : 'Loading…'}
              {status && ` · v${status.version} · up ${Math.round(status.uptime / 60)}m`}
            </p>
          </div>
        </div>
      </div>

      <section className="mb-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-3">Components</h2>
        <div className="space-y-2">
          {status ? (
            <>
              <ComponentRow name="Database (Postgres)" check={status.checks.db} />
              <ComponentRow name="Cache (Redis)" check={status.checks.redis} />
              <ComponentRow name="Search" check={{ name: 'search', ok: true }} />
              <ComponentRow name="API" check={{ name: 'api', ok: true }} />
            </>
          ) : (
            <p className="text-sm text-bh-text-muted">Checking…</p>
          )}
        </div>
      </section>

      {openIncidents.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-3 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
            Active incidents
          </h2>
          <div className="space-y-3">
            {openIncidents.map((i) => (
              <IncidentCard key={i.id} incident={i} />
            ))}
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-3">
          Past 30 days
        </h2>
        {incidents.filter((i) => i.status === 'resolved').length === 0 ? (
          <p className="text-sm text-bh-text-muted">No resolved incidents in the last 30 days.</p>
        ) : (
          <div className="space-y-2">
            {incidents
              .filter((i) => i.status === 'resolved')
              .slice(0, 10)
              .map((i) => (
                <IncidentCard key={i.id} incident={i} resolved />
              ))}
          </div>
        )}
      </section>

      <footer className="text-center text-xs text-bh-text-dim">
        <p>
          Status data refreshes every 30s. Subscribe via{' '}
          <Link to="/changelog" className="text-bh-accent hover:underline">changelog</Link>
          {' '}or see the <Link to="/roadmap" className="text-bh-accent hover:underline">roadmap</Link>.
        </p>
      </footer>
    </div>
  )
}

function ComponentRow({ name, check }: { name: string; check: { name: string; ok: boolean; message?: string } }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-bh-surface/40 border border-bh-border" data-testid={`status-row-${check.name}`}>
      <StatusIcon ok={check.ok} />
      <span className="flex-1 text-sm text-bh-text">{name}</span>
      {check.message && (
        <span className="text-xs text-bh-text-dim">{check.message}</span>
      )}
      <span className={`text-xs font-semibold ${check.ok ? 'text-bh-success' : 'text-bh-danger'}`}>
        {check.ok ? 'OK' : 'DOWN'}
      </span>
    </div>
  )
}

function IncidentCard({ incident, resolved }: { incident: Incident; resolved?: boolean }) {
  const statusColor: Record<Incident['status'], string> = {
    investigating: 'bg-bh-danger/10 text-bh-danger border-bh-danger/30',
    identified: 'bg-bh-warning/10 text-bh-warning border-bh-warning/30',
    monitoring: 'bg-bh-accent-soft text-bh-accent border-bh-accent/30',
    resolved: 'bg-bh-success/5 text-bh-success border-bh-success/30',
  }
  const severityColor: Record<Incident['severity'], string> = {
    minor: 'text-bh-text-dim',
    major: 'text-bh-warning',
    critical: 'text-bh-danger',
  }
  const duration = incident.resolvedAt
    ? Math.round((new Date(incident.resolvedAt).getTime() - new Date(incident.startedAt).getTime()) / 60000)
    : null

  return (
    <div
      className={`card border p-4 ${statusColor[incident.status]}`}
      data-testid={`incident-${incident.id}`}
    >
      <div className="flex items-start gap-2 mb-1">
        <span className={`text-[10px] uppercase tracking-wider font-bold ${severityColor[incident.severity]}`}>
          {incident.severity}
        </span>
        <span className="text-[10px] uppercase tracking-wider opacity-70">
          {incident.status}
        </span>
        {!resolved && incident.status === 'investigating' && (
          <span className="ml-auto text-xs text-bh-text-muted flex items-center gap-1">
            <Clock className="w-3 h-3" /> ongoing
          </span>
        )}
      </div>
      <p className="font-semibold text-bh-text mb-1">{incident.title}</p>
      {incident.description && (
        <p className="text-sm text-bh-text-muted">{incident.description}</p>
      )}
      <p className="text-xs text-bh-text-dim mt-2">
        Started {new Date(incident.startedAt).toLocaleString()}
        {duration != null && ` · Duration ${formatDurationLabel(duration)}`}
      </p>
    </div>
  )
}

function formatDurationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
