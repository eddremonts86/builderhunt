import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CheckCircle2, AlertTriangle, XCircle, Activity, Clock } from 'lucide-react'
import { useSession } from '~/shared/lib/auth/client'
import { DashboardLayout } from '~/modules/dashboard/ui/shell/DashboardLayout'
import { TenantQueryProvider } from '~/shared/components/TenantQueryProvider'

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
  uptime30d: number | null
  timestamp: string
}

export const Route = createFileRoute('/_landing/status')({
  component: StatusPage,
})

function StatusIcon({ ok }: { ok: boolean }) {
  if (ok) return <CheckCircle2 className="w-5 h-5 text-bh-success" aria-hidden="true" />
  return <XCircle className="w-5 h-5 text-bh-danger" aria-hidden="true" />
}

function StatusPage() {
  const [status, setStatus] = React.useState<StatusResponse | null>(null)
  const [incidents, setIncidents] = React.useState<Incident[]>([])
  const [lastUpdated, setLastUpdated] = React.useState<string>('')

  const load = React.useCallback(async () => {
    try {
      const [sRes, iRes] = await Promise.all([
        fetch('/api/status'),
        fetch('/api/incidents'),
      ])
      // `/api/status` answers 503 when any component check fails, carrying the
      // same body as a 200. Reading it only on `ok` meant the Components list
      // collapsed to "Checking…" exactly when something was down — a status
      // page that goes blank in an outage is backwards. Render the degraded
      // state; the overall banner already distinguishes the two.
      if (sRes.ok || sRes.status === 503) {
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
    }
  }, [])

  React.useEffect(() => {
    load()
    const id = setInterval(load, 30_000) // refresh every 30s
    return () => clearInterval(id)
  }, [load])

  const { data: session } = useSession()
  const allOk = status?.status === 'ok'
  const openIncidents = incidents.filter((i) => i.status !== 'resolved')

  const content = (
    <div className="container py-12 max-w-4xl animate-fade-in" data-testid="status-page">
      <header className="mb-10">
        <h1 className="text-4xl font-extrabold tracking-tight mb-2 flex items-center gap-3 text-bh-text">
          <Activity className="w-8 h-8 text-bh-accent" aria-hidden="true" />
          System Status
        </h1>
        <p className="text-bh-text-muted text-base">Live status of BuilderHunt services and API latency.</p>
      </header>

      <div
        className={`card p-6 mb-8 border rounded-2xl shadow-sm ${
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
              {status?.uptime30d != null && ` · 30-day uptime: ${status.uptime30d.toFixed(2)}%`}
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

  // Reached from inside the dashboard's floating nav, this page still needs
  // to work for signed-out visitors (public trust page) — so it can't live
  // under `_dashboard/*` (auth-gated). Wrap in the same shell client-side
  // when a session exists, so it doesn't feel like leaving the app.
  // `DashboardLayout`'s topbar renders `OrganizationSwitcher`, which needs a
  // `QueryClient` — `_dashboard/route.tsx` provides one via
  // `TenantQueryProvider`, but this route sits outside that tree entirely
  // (that's the point, for signed-out visitors), so it must supply its own.
  return session?.user ? (
    <TenantQueryProvider activeOrganizationId={session.session?.activeOrganizationId ?? null}>
      <DashboardLayout>{content}</DashboardLayout>
    </TenantQueryProvider>
  ) : content
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
