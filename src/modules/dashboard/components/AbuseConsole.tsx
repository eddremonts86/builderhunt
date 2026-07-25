import * as React from 'react'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui'
import { ErrorState } from '~/shared/components/ErrorState'

interface AbuseSignalRow {
  id: string
  type: string
  severity: string
  details: Record<string, unknown> | null
  userId: string | null
  organizationId: string | null
  requestId: string | null
  createdAt: string
}

interface StageInfo {
  stage: string
  riskScore: number
  reason: string | null
  updatedAt: string
}

interface AccountCluster {
  userIds: string[]
  sharedDeviceHashes: string[]
  sharedIpAddresses: string[]
}

const ACTION_OPTIONS = [
  { value: 'clear', label: 'Clear (reset to observe)' },
  { value: 'warn', label: 'Warn' },
  { value: 'stepup', label: 'Force step-up' },
  { value: 'block', label: 'Block' },
]

/** Platform-admin abuse console (abuse-and-usage-integrity Phase 5 task 3). Composes the recent
 * `abuse_signals` feed (with each signal's current enforcement stage) and the linked-account
 * cluster read model (its own pre-existing route from Phase 3) into one review surface, with
 * inline manual actions per account — same expand-a-row-no-modal pattern as `RefundQueue`. */
export function AbuseConsole() {
  const [signals, setSignals] = React.useState<AbuseSignalRow[] | null>(null)
  const [stageByUserId, setStageByUserId] = React.useState<Record<string, StageInfo | null>>({})
  const [clusters, setClusters] = React.useState<AccountCluster[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [actingSignalId, setActingSignalId] = React.useState<string | null>(null)
  const [action, setAction] = React.useState(ACTION_OPTIONS[0].value)
  const [reason, setReason] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [feedRes, clustersRes] = await Promise.all([
        fetch('/api/admin/abuse?limit=100', { credentials: 'include' }),
        fetch('/api/admin/abuse/clusters', { credentials: 'include' }),
      ])
      const feedData = await feedRes.json()
      const clustersData = await clustersRes.json()
      if (!feedRes.ok) {
        setError(feedData.error ?? 'Failed to load abuse signals')
        return
      }
      setSignals(feedData.signals)
      setStageByUserId(feedData.stageByUserId ?? {})
      if (clustersRes.ok) setClusters(clustersData.clusters)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const submitAction = async (userId: string) => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/abuse', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action, reason: reason.trim() || undefined }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to record action')
        return
      }
      setActingSignalId(null)
      setReason('')
      await load()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="abuse-console" className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Abuse console</h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Review recent abuse signals and linked-account clusters, and manually clear, warn, force
          step-up, or block an account. Every manual action is audited.
        </p>
      </header>

      {error && <ErrorState message={error} icon={false} />}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent abuse signals</h2>
          <Button variant="secondary" onClick={load} disabled={loading} data-testid="abuse-console-refresh">
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>

        {signals && signals.length === 0 && <p className="text-sm text-bh-text-muted">No abuse signals recorded.</p>}

        {signals && signals.length > 0 && (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Abuse signals table, scrollable">
            <table className="w-full text-sm" data-testid="abuse-signals-table">
              <thead>
                <tr className="text-left text-bh-text-dim border-b border-bh-border">
                  <th className="py-2">Type</th>
                  <th className="py-2">Severity</th>
                  <th className="py-2">User</th>
                  <th className="py-2">Stage</th>
                  <th className="py-2">Created</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {signals.map((signal) => {
                  const stageInfo = signal.userId ? stageByUserId[signal.userId] : null
                  return (
                    <React.Fragment key={signal.id}>
                      <tr className="border-b border-bh-border/50" data-testid={`abuse-signal-row-${signal.id}`}>
                        <td className="py-2">{signal.type}</td>
                        <td className="py-2">{signal.severity}</td>
                        <td className="py-2 font-mono text-xs">{signal.userId ?? '—'}</td>
                        <td className="py-2">{stageInfo?.stage ?? '—'}</td>
                        <td className="py-2">{new Date(signal.createdAt).toLocaleString()}</td>
                        <td className="py-2 text-right">
                          {signal.userId && (
                            <Button
                              variant="secondary"
                              onClick={() => {
                                setActingSignalId(actingSignalId === signal.id ? null : signal.id)
                                setReason('')
                              }}
                              data-testid={`abuse-account-action-toggle-${signal.userId}`}
                            >
                              Act on account
                            </Button>
                          )}
                        </td>
                      </tr>
                      {signal.userId && actingSignalId === signal.id && (
                        <tr>
                          <td colSpan={6} className="py-3">
                            <div className="card p-3 space-y-3">
                              <div>
                                <Label htmlFor="abuse-action-select">Action</Label>
                                <Select value={action} onValueChange={setAction}>
                                  <SelectTrigger id="abuse-action-select" data-testid="abuse-account-action-select">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {ACTION_OPTIONS.map((opt) => (
                                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div>
                                <Label htmlFor="abuse-action-reason">Reason (optional)</Label>
                                <Input id="abuse-action-reason" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="abuse-account-action-reason" />
                              </div>
                              <Button onClick={() => submitAction(signal.userId!)} disabled={saving} data-testid="abuse-account-action-submit">
                                {saving ? 'Saving…' : 'Apply action'}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Linked-account clusters</h2>
        <p className="text-sm text-bh-text-muted">
          Accounts sharing a device hash or IP address in the last 30 days. Review-only — clusters
          never trigger enforcement on their own.
        </p>
        {clusters && clusters.length === 0 && <p className="text-sm text-bh-text-muted">No linked-account clusters detected.</p>}
        {clusters && clusters.length > 0 && (
          <ul className="space-y-2" data-testid="abuse-clusters-list">
            {clusters.map((cluster, index) => (
              <li key={index} className="card p-3 text-sm" data-testid={`abuse-cluster-row-${index}`}>
                <div className="font-mono text-xs">{cluster.userIds.join(', ')}</div>
                <div className="text-bh-text-muted mt-1">
                  {cluster.sharedDeviceHashes.length > 0 && `${cluster.sharedDeviceHashes.length} shared device(s)`}
                  {cluster.sharedDeviceHashes.length > 0 && cluster.sharedIpAddresses.length > 0 && ', '}
                  {cluster.sharedIpAddresses.length > 0 && `${cluster.sharedIpAddresses.length} shared IP(s)`}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {loading && !signals && <p className="text-sm text-bh-text-muted">Loading…</p>}
    </div>
  )
}
