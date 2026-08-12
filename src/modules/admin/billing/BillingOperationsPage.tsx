import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Activity, AlertTriangle, BookOpen, CreditCard, Download, ExternalLink, Gauge, RotateCcw, ShieldAlert, Timer } from 'lucide-react'
import { Button, Input, Textarea } from '~/components/ui'

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
  /**
   * The critical SLO conditions among the numbers above, decided server-side by
   * `evaluateBillingAlerts`.
   *
   * Optional because it is newer than the endpoint: a client held on a stale bundle during a deploy
   * would otherwise render `undefined.length`. An absent list is not an empty one, so nothing is
   * claimed when the field does not arrive — see the banner below.
   */
  alerts?: string[]
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

/** Runs `action`, shows a result message, and clears any prior confirm state. Every guarded action shares this shape: confirm → run → feedback. */
function useGuardedAction() {
  const [pending, setPending] = React.useState(false)
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null)

  const run = React.useCallback(async (action: () => Promise<{ ok: boolean; text: string }>) => {
    setPending(true)
    setMessage(null)
    try {
      setMessage(await action())
    } finally {
      setPending(false)
    }
  }, [])

  return { pending, message, run }
}

async function describeResponse(res: Response, successText: string): Promise<{ ok: boolean; text: string }> {
  if (res.status === 401) return { ok: false, text: 'Recent re-authentication required — sign in again and retry.' }
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}))
    return { ok: false, text: body.error === 'already_running' ? 'Already running — this was not started again.' : 'Conflict — refresh and retry.' }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return { ok: false, text: body.error ? String(body.error) : `Failed: ${res.status}` }
  }
  return { ok: true, text: successText }
}

function ReconciliationSection({ lastRun }: { lastRun: { windowEnd: string; result: string } | null }) {
  const [confirming, setConfirming] = React.useState(false)
  const { pending, message, run } = useGuardedAction()

  const trigger = () => run(async () => {
    const res = await fetch('/api/admin/billing/reconcile', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })
    setConfirming(false)
    return describeResponse(res, 'Reconciliation pass completed.')
  })

  return (
    <section className="card p-4" data-testid="billing-operations-reconciliation">
      <h2 className="font-semibold text-sm mb-2">Reconciliation</h2>
      <p className="text-sm text-bh-text-muted mb-3">
        {lastRun
          ? `Last run ${new Date(lastRun.windowEnd).toLocaleString()} — ${lastRun.result}`
          : 'No reconciliation run recorded yet.'}
      </p>
      {!confirming ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => setConfirming(true)} disabled={pending} data-testid="billing-reconcile-trigger">
          Run reconciliation
        </Button>
      ) : (
        <div className="rounded border border-bh-border bg-bh-surface p-2 text-xs">
          <p className="text-bh-text-muted mb-1.5">Compare every organization's live Stripe state against ours and auto-repair drift?</p>
          <div className="flex gap-1.5">
            <Button type="button" variant="primary" size="sm" onClick={trigger} disabled={pending} data-testid="billing-reconcile-confirm">
              {pending ? 'Running…' : 'Run now'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>Cancel</Button>
          </div>
        </div>
      )}
      {message && <p className={`text-xs mt-2 ${message.ok ? 'text-bh-success' : 'text-bh-danger'}`} role="status" data-testid="billing-reconcile-message">{message.text}</p>}
    </section>
  )
}

function WorkerRunSection() {
  const [confirming, setConfirming] = React.useState(false)
  const { pending, message, run } = useGuardedAction()

  const trigger = () => run(async () => {
    const res = await fetch('/api/admin/billing/run-worker', { method: 'POST', credentials: 'include' })
    setConfirming(false)
    return describeResponse(res, 'Worker run completed.')
  })

  return (
    <section className="card p-4" data-testid="billing-operations-worker">
      <h2 className="font-semibold text-sm mb-2">Webhook worker</h2>
      <p className="text-sm text-bh-text-muted mb-3">Claims and processes pending/retryable webhook events, and sweeps expired credit grants.</p>
      {!confirming ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => setConfirming(true)} disabled={pending} data-testid="billing-worker-trigger">
          Run worker
        </Button>
      ) : (
        <div className="rounded border border-bh-border bg-bh-surface p-2 text-xs">
          <p className="text-bh-text-muted mb-1.5">Process the current webhook backlog now?</p>
          <div className="flex gap-1.5">
            <Button type="button" variant="primary" size="sm" onClick={trigger} disabled={pending} data-testid="billing-worker-confirm">
              {pending ? 'Running…' : 'Run now'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>Cancel</Button>
          </div>
        </div>
      )}
      {message && <p className={`text-xs mt-2 ${message.ok ? 'text-bh-success' : 'text-bh-danger'}`} role="status" data-testid="billing-worker-message">{message.text}</p>}
    </section>
  )
}

interface BillingWebhookEventRow {
  id: string
  stripeEventId: string
  eventType: string
  objectType: string
  status: string
  attempts: number
  receivedAt: string
  processedAt: string | null
  nextAttemptAt: string | null
  hasError: boolean
}

const DISCOVERY_STATUS_FILTERS = ['failed', 'pending', 'processing'] as const

function DeadLetterReplaySection() {
  const [statusFilter, setStatusFilter] = React.useState<(typeof DISCOVERY_STATUS_FILTERS)[number]>('failed')
  const [rows, setRows] = React.useState<BillingWebhookEventRow[] | null>(null)
  const [listError, setListError] = React.useState<string | null>(null)
  const [eventId, setEventId] = React.useState('')
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null)
  const [manualConfirming, setManualConfirming] = React.useState(false)
  const { pending, message, run } = useGuardedAction()

  const loadRows = React.useCallback(async (status: string) => {
    setRows(null)
    setListError(null)
    try {
      const res = await fetch(`/api/admin/billing/events?status=${encodeURIComponent(status)}&limit=10`, { credentials: 'include' })
      if (!res.ok) {
        setListError(`Failed to load: ${res.status}`)
        return
      }
      setRows((await res.json()).rows)
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  React.useEffect(() => { loadRows(statusFilter) }, [statusFilter, loadRows])

  const replay = (id: string) => run(async () => {
    const res = await fetch(`/api/admin/billing/events/${encodeURIComponent(id)}/replay`, { method: 'POST', credentials: 'include' })
    setConfirmingId(null)
    setManualConfirming(false)
    setEventId('')
    if (res.status === 404) return { ok: false, text: 'No webhook event found with that id.' }
    const result = await describeResponse(res, 'Event replayed. Safe to repeat — an already-processed event is a no-op.')
    if (result.ok) loadRows(statusFilter)
    return result
  })

  return (
    <section className="card p-4" data-testid="billing-operations-dead-letter">
      <h2 className="font-semibold text-sm mb-2">Dead-letter replay</h2>
      <p className="text-sm text-bh-text-muted mb-3">Find a failed webhook event, or re-process one directly by its row id. Safe to repeat — an already-applied event is a no-op, not a double effect.</p>

      <div className="flex items-center gap-2 mb-2" role="group" aria-label="Filter events by status">
        {DISCOVERY_STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            aria-pressed={statusFilter === s}
            data-testid={`billing-events-filter-${s}`}
            className={`rounded px-2 py-0.5 text-xs font-medium capitalize ${statusFilter === s ? 'bg-bh-accent text-bh-accent-contrast' : 'bg-bh-surface text-bh-text-muted hover:text-bh-text'}`}
          >
            {s}
          </button>
        ))}
      </div>

      {listError && <p className="text-xs text-bh-danger mb-2" role="alert">{listError}</p>}
      {rows === null && !listError && <p className="text-xs text-bh-text-muted mb-2">Loading…</p>}
      {rows !== null && (
        <ul className="mb-3" data-testid="billing-events-list">
          {rows.length === 0 && <li className="text-xs text-bh-text-dim">No {statusFilter} events.</li>}
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 py-1 border-b border-bh-border/50 text-xs" data-testid={`billing-event-row-${row.id}`}>
              <div className="min-w-0">
                <span className="font-mono text-bh-text-dim">{row.id}</span>{' '}
                <span className="text-bh-text-muted">{row.eventType} · {row.attempts} attempt{row.attempts === 1 ? '' : 's'} · {new Date(row.receivedAt).toLocaleString()}</span>
              </div>
              {confirmingId === row.id ? (
                <div className="flex items-center gap-1 shrink-0">
                  <Button type="button" variant="primary" size="sm" onClick={() => replay(row.id)} disabled={pending} data-testid={`billing-event-replay-confirm-${row.id}`}>
                    {pending ? 'Replaying…' : 'Confirm'}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingId(null)} disabled={pending}>Cancel</Button>
                </div>
              ) : (
                <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmingId(row.id)} disabled={pending} className="shrink-0" data-testid={`billing-event-replay-${row.id}`}>
                  Replay
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 mb-2">
        <Input
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
          placeholder="Or enter a row id directly"
          className="max-w-xs"
          data-testid="billing-replay-event-id"
        />
        <Button type="button" variant="secondary" size="sm" onClick={() => setManualConfirming(true)} disabled={pending || eventId.trim().length === 0} data-testid="billing-replay-trigger">
          Replay
        </Button>
      </div>
      {manualConfirming && (
        <div className="rounded border border-bh-border bg-bh-surface p-2 text-xs mb-2">
          <p className="text-bh-text-muted mb-1.5">Replay event <code>{eventId.trim()}</code>?</p>
          <div className="flex gap-1.5">
            <Button type="button" variant="primary" size="sm" onClick={() => replay(eventId.trim())} disabled={pending} data-testid="billing-replay-confirm">
              {pending ? 'Replaying…' : 'Replay now'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setManualConfirming(false)} disabled={pending}>Cancel</Button>
          </div>
        </div>
      )}
      {message && <p className={`text-xs ${message.ok ? 'text-bh-success' : 'text-bh-danger'}`} role="status" data-testid="billing-replay-message">{message.text}</p>}
    </section>
  )
}

function RiskExceptionsSection({ active }: { active: number }) {
  const [organizationId, setOrganizationId] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [durationHours, setDurationHours] = React.useState('24')
  const [revokeExceptionId, setRevokeExceptionId] = React.useState('')
  const issue = useGuardedAction()
  const revoke = useGuardedAction()

  const runIssue = () => issue.run(async () => {
    const hours = Number(durationHours)
    if (!organizationId.trim() || reason.trim().length === 0 || !Number.isFinite(hours) || hours <= 0) {
      return { ok: false, text: 'Organization id, a reason, and a positive duration are required.' }
    }
    const res = await fetch('/api/admin/billing/risk-exceptions', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: organizationId.trim(), reason: reason.trim(), durationMs: hours * 60 * 60 * 1000 }),
    })
    return describeResponse(res, 'Exception issued.')
  })

  const runRevoke = () => revoke.run(async () => {
    if (!organizationId.trim() || !revokeExceptionId.trim()) {
      return { ok: false, text: 'Organization id and exception id are required.' }
    }
    const res = await fetch('/api/admin/billing/risk-exceptions', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: organizationId.trim(), exceptionId: revokeExceptionId.trim() }),
    })
    if (res.status === 404) return { ok: false, text: 'No active exception found with that id.' }
    return describeResponse(res, 'Exception revoked.')
  })

  return (
    <section className="card p-4" data-testid="billing-operations-risk-exceptions-manage">
      <h2 className="font-semibold text-sm mb-2">Risk exceptions</h2>
      <p className="text-sm text-bh-text-muted mb-3">{active} active across all organizations. Issue a time-boxed exception, or revoke one early.</p>
      <div className="grid gap-2 max-w-md mb-2">
        <Input value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} placeholder="Organization id" data-testid="billing-risk-org-id" />
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required, shown in the audit log)" rows={2} data-testid="billing-risk-reason" />
        <div className="flex items-center gap-2">
          <Input type="number" min={1} value={durationHours} onChange={(e) => setDurationHours(e.target.value)} className="w-24" data-testid="billing-risk-duration-hours" />
          <span className="text-xs text-bh-text-dim">hours (max 30 days)</span>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={runIssue} disabled={issue.pending} data-testid="billing-risk-issue">
          {issue.pending ? 'Issuing…' : 'Issue exception'}
        </Button>
        {issue.message && <p className={`text-xs ${issue.message.ok ? 'text-bh-success' : 'text-bh-danger'}`} role="status" data-testid="billing-risk-issue-message">{issue.message.text}</p>}
      </div>
      <div className="grid gap-2 max-w-md">
        <Input value={revokeExceptionId} onChange={(e) => setRevokeExceptionId(e.target.value)} placeholder="Exception id to revoke" data-testid="billing-risk-exception-id" />
        <Button type="button" variant="danger-outline" size="sm" onClick={runRevoke} disabled={revoke.pending} data-testid="billing-risk-revoke">
          {revoke.pending ? 'Revoking…' : 'Revoke exception'}
        </Button>
        {revoke.message && <p className={`text-xs ${revoke.message.ok ? 'text-bh-success' : 'text-bh-danger'}`} role="status" data-testid="billing-risk-revoke-message">{revoke.message.text}</p>}
      </div>
    </section>
  )
}

function AccountingExportSection() {
  const [month, setMonth] = React.useState('')
  const query = month ? `?month=${encodeURIComponent(month)}` : ''

  return (
    <section className="card p-4" data-testid="billing-operations-cost-margin">
      <h2 className="font-semibold text-sm mb-2">Accounting export</h2>
      <p className="text-sm text-bh-text-muted mb-3">One calendar month, aggregated only — no per-organization detail, no raw Stripe payloads.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="max-w-[10rem]" data-testid="billing-export-month" aria-label="Month (defaults to last full month)" />
        <a href={`/api/admin/billing/accounting-export${query}${query ? '&' : '?'}format=csv`} className="inline-flex items-center gap-1 text-bh-accent hover:underline text-sm" data-testid="billing-export-csv">
          <Download className="size-3.5" aria-hidden />CSV
        </a>
        <a href={`/api/admin/billing/accounting-export${query}`} className="inline-flex items-center gap-1 text-bh-accent hover:underline text-sm" data-testid="billing-export-json">
          <Download className="size-3.5" aria-hidden />JSON
        </a>
      </div>
    </section>
  )
}

/**
 * Platform-admin-only billing operations console (plans/phase-1/30-stripe-billing-platform/tasks.md
 * §9-10; plans/UI/tasks.md Wave 5 "Add guarded billing operations actions"). The top summary is a
 * read-only aggregate — no raw webhook payloads, no per-organization detail, no secrets ever render
 * here. Every mutating action below (reconciliation, worker run, dead-letter replay, risk-exception
 * issue/revoke) requires an explicit confirm click, is server-side step-up-gated
 * (`requireRecentPlatformAdminAuthentication`) and audited, and reports its own real result — never a
 * fabricated success.
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
        <div className="flex items-center gap-3 shrink-0">
          <Link to="/admin/refunds" className="inline-flex items-center gap-1 text-sm text-bh-accent hover:underline" data-testid="billing-operations-refunds-link">
            Refunds <ExternalLink className="size-3.5" aria-hidden />
          </Link>
          <Link to="/admin/disputes" className="inline-flex items-center gap-1 text-sm text-bh-accent hover:underline" data-testid="billing-operations-disputes-link">
            Disputes <ExternalLink className="size-3.5" aria-hidden />
          </Link>
          <Button type="button" variant="secondary" size="sm" onClick={load} disabled={loading} data-testid="billing-operations-refresh">
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
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

          {/*
            Rendered only when there is something to report. A permanent "0 alerts" panel trains an
            operator to stop reading the top of the page, which is the one place an alert can appear.
            An absent `alerts` field renders nothing at all rather than "all clear" — see the type.
          */}
          {metrics.alerts && metrics.alerts.length > 0 && (
            <div
              className="card border-bh-danger/40 bg-bh-danger/5 p-4 mb-6"
              role="alert"
              data-testid="billing-operations-alerts"
            >
              <h2 className="text-sm font-semibold text-bh-danger flex items-center gap-2">
                <ShieldAlert className="w-4 h-4" aria-hidden="true" />
                {metrics.alerts.length} billing alert{metrics.alerts.length === 1 ? '' : 's'}
              </h2>
              <ul className="mt-2 space-y-1 text-sm text-bh-text">
                {metrics.alerts.map((alert) => (
                  <li key={alert} data-testid="billing-operations-alert">{alert}</li>
                ))}
              </ul>
            </div>
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
            <ReconciliationSection lastRun={metrics.reconciliation.lastRun} />
            <WorkerRunSection />
            <DeadLetterReplaySection />
            <RiskExceptionsSection active={metrics.riskExceptions.active} />
            <AccountingExportSection />
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
