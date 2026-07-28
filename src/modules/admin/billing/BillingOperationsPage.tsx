import * as React from 'react'
import { Activity, AlertTriangle, BookOpen, CreditCard, Gauge, RotateCcw, ShieldAlert, Timer } from 'lucide-react'
import { Button } from '~/components/ui'

interface WebhookBacklogMetrics {
  pending: number
  processing: number
  failed: number
  ignored: number
  processed: number
}

interface BillingOperationsMetrics {
  liveMode: boolean
  configuration: { version: number; effectiveAt: string; statementDescriptor: string; supportEmail: string } | null
  webhooks: WebhookBacklogMetrics
  grace: { organizationsInGrace: number }
  refunds: { pendingRequests: number }
  disputes: { open: number }
  riskExceptions: { active: number }
  creditInvariants: { staleReservations: number }
  reconciliation: { lastRun: { windowEnd: string; result: string } | null }
  costMargin: { available: false }
  organizationsScanned: number
}

/**
 * These are repo file paths, not app routes — this codebase has no docs-serving route, so they're
 * rendered as plain-text references for an operator to open in their own checkout, never as
 * clickable `<Link>`s (which would either 404 or silently point nowhere).
 */
const RUNBOOKS: Array<{ title: string; path: string }> = [
  { title: 'Live readiness', path: 'docs/operations/stripe-live-readiness.md' },
  { title: 'Webhooks', path: 'docs/operations/stripe-webhooks.md' },
  { title: 'Disputes', path: 'docs/operations/stripe-disputes.md' },
  { title: 'Fraud', path: 'docs/operations/stripe-fraud.md' },
  { title: 'Customer Portal', path: 'docs/operations/stripe-customer-portal.md' },
  { title: 'Database migrations', path: 'docs/operations/stripe-database-migration.md' },
]

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'default',
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
  detail?: string
  tone?: 'default' | 'warning' | 'danger'
  testId: string
}) {
  const toneClass = tone === 'danger' ? 'text-bh-danger' : tone === 'warning' ? 'text-bh-warning' : 'text-bh-text'
  return (
    <div className="card p-4" data-testid={testId}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-bh-text-dim mb-2">
        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        {label}
      </div>
      <p className={`text-2xl font-bold ${toneClass}`}>{value}</p>
      {detail && <p className="text-xs text-bh-text-muted mt-1">{detail}</p>}
    </div>
  )
}

/**
 * Platform-admin-only read-only summary of live billing operational health
 * (plans/phase-1/29-stripe-billing-platform/tasks.md §9 "Build platform billing operations dashboard").
 * Every number here is an aggregate count from `getBillingOperationsMetrics` — no raw webhook
 * payloads, no per-organization detail, no secrets ever render on this page. Reconciliation and
 * cost/margin sections intentionally show "not yet available" rather than a fabricated number:
 * neither has been built yet (plans/phase-1/29-stripe-billing-platform/tasks.md §10, unstarted).
 */
export function BillingOperationsPage() {
  const [metrics, setMetrics] = React.useState<BillingOperationsMetrics | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [loadedAt, setLoadedAt] = React.useState<Date | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/billing/metrics', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      setMetrics(await res.json())
      setLoadedAt(new Date())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  return (
    <div data-testid="admin-billing-operations">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Gauge className="w-6 h-6 text-bh-accent" aria-hidden="true" />
            Billing operations
          </h1>
          <p className="text-sm text-bh-text-muted mt-1">
            Live aggregate health across every organization. Read-only — no raw payloads or per-organization detail.
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={load} disabled={loading} className="shrink-0" data-testid="billing-operations-refresh">
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </header>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger" data-testid="billing-operations-error">
          {error}
        </div>
      )}

      {loading && !metrics && (
        <p className="text-sm text-bh-text-muted" data-testid="billing-operations-loading">Loading…</p>
      )}

      {metrics && (
        <>
          {loadedAt && (
            <p className="text-xs text-bh-text-dim mb-3" data-testid="billing-operations-loaded-at">
              As of {loadedAt.toLocaleTimeString()} · {metrics.organizationsScanned} organization{metrics.organizationsScanned === 1 ? '' : 's'} scanned
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <StatCard
              icon={Activity}
              label="Mode"
              value={metrics.liveMode ? 'Live' : 'Test'}
              tone={metrics.liveMode ? 'default' : 'warning'}
              testId="billing-operations-mode"
            />
            <StatCard
              icon={CreditCard}
              label="Configuration"
              value={metrics.configuration ? `v${metrics.configuration.version}` : 'Not set'}
              detail={metrics.configuration ? metrics.configuration.statementDescriptor : 'No seller profile recorded yet'}
              tone={metrics.configuration ? 'default' : 'danger'}
              testId="billing-operations-configuration"
            />
            <StatCard
              icon={Timer}
              label="Webhook backlog"
              value={metrics.webhooks.pending + metrics.webhooks.processing}
              detail={`${metrics.webhooks.failed} dead-lettered · ${metrics.webhooks.ignored} ignored`}
              tone={metrics.webhooks.failed > 0 ? 'danger' : metrics.webhooks.pending > 0 ? 'warning' : 'default'}
              testId="billing-operations-webhooks"
            />
            <StatCard
              icon={AlertTriangle}
              label="Organizations in grace"
              value={metrics.grace.organizationsInGrace}
              tone={metrics.grace.organizationsInGrace > 0 ? 'warning' : 'default'}
              testId="billing-operations-grace"
            />
            <StatCard
              icon={RotateCcw}
              label="Pending refunds"
              value={metrics.refunds.pendingRequests}
              tone={metrics.refunds.pendingRequests > 0 ? 'warning' : 'default'}
              testId="billing-operations-refunds"
            />
            <StatCard
              icon={ShieldAlert}
              label="Open disputes"
              value={metrics.disputes.open}
              tone={metrics.disputes.open > 0 ? 'warning' : 'default'}
              testId="billing-operations-disputes"
            />
            <StatCard
              icon={ShieldAlert}
              label="Active risk exceptions"
              value={metrics.riskExceptions.active}
              testId="billing-operations-risk-exceptions"
            />
            <StatCard
              icon={AlertTriangle}
              label="Stale credit reservations"
              value={metrics.creditInvariants.staleReservations}
              detail="Reserved past their own deadline — should have been swept to expired"
              tone={metrics.creditInvariants.staleReservations > 0 ? 'danger' : 'default'}
              testId="billing-operations-credit-invariants"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            <section className="card p-4" data-testid="billing-operations-reconciliation">
              <h2 className="font-semibold text-sm mb-2">Reconciliation</h2>
              {metrics.reconciliation.lastRun ? (
                <p className="text-sm text-bh-text-muted">
                  Last run {new Date(metrics.reconciliation.lastRun.windowEnd).toLocaleString()} — {metrics.reconciliation.lastRun.result}
                </p>
              ) : (
                <p className="text-sm text-bh-text-muted">Not yet available — reconciliation has not been built yet.</p>
              )}
            </section>
            <section className="card p-4" data-testid="billing-operations-cost-margin">
              <h2 className="font-semibold text-sm mb-2">Cost &amp; margin</h2>
              <p className="text-sm text-bh-text-muted">Not yet available — cost/margin export has not been built yet.</p>
            </section>
          </div>

          <section className="card p-4" data-testid="billing-operations-runbooks">
            <h2 className="font-semibold text-sm flex items-center gap-2 mb-2">
              <BookOpen className="w-4 h-4" aria-hidden="true" />
              Runbooks
            </h2>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {RUNBOOKS.map((runbook) => (
                <li key={runbook.path} className="text-bh-text-muted">
                  <span className="font-medium text-bh-text">{runbook.title}:</span>{' '}
                  <code className="text-xs">{runbook.path}</code>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
