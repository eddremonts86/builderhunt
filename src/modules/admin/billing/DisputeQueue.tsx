import * as React from 'react'
import { Button, Input, Label } from '~/components/ui'
import { ErrorState } from '~/shared/components/ErrorState'

interface DisputeRow {
  id: string
  organizationId: string
  grantId: string | null
  stripeDisputeId: string
  amountCents: number
  reason: string | null
  stripeStatus: string
  outcome: string
  evidenceDueBy: string | null
  fundsReinstatedAt: string | null
  createdAt: string
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function outcomeBadgeClass(outcome: string): string {
  if (outcome === 'won') return 'text-bh-success'
  if (outcome === 'lost') return 'text-bh-danger'
  return 'text-bh-warning'
}

/**
 * Read-only chargeback view for §8 task 5 — no operator "decide" action here (evidence submission
 * and the won/lost outcome both live in the Stripe Dashboard, see `billing/disputes.ts`'s module
 * comment). This surfaces which grants are frozen and how soon an evidence deadline is due.
 */
export function DisputeQueue() {
  const [organizationId, setOrganizationId] = React.useState('')
  const [disputes, setDisputes] = React.useState<DisputeRow[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = async () => {
    if (!organizationId.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/billing/disputes?organizationId=${encodeURIComponent(organizationId.trim())}`, { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to load disputes')
        setDisputes(null)
        return
      }
      setDisputes(data.disputes)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div data-testid="dispute-queue" className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Dispute queue</h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Chargebacks freeze their linked pack grant automatically. Evidence submission and the won/lost outcome are handled in the Stripe Dashboard — this view is read-only.
        </p>
      </header>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Label htmlFor="dispute-queue-org">Organization ID</Label>
          <Input id="dispute-queue-org" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} data-testid="dispute-queue-org-input" />
        </div>
        <Button onClick={load} disabled={loading || !organizationId.trim()} data-testid="dispute-queue-load">
          {loading ? 'Loading…' : 'Load'}
        </Button>
      </div>

      {error && <ErrorState message={error} icon={false} />}

      {disputes && disputes.length === 0 && (
        <p className="text-sm text-bh-text-muted">No disputes for this organization.</p>
      )}

      {disputes && disputes.length > 0 && (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Disputes table, scrollable">
          <table className="w-full text-sm" data-testid="dispute-queue-table">
            <thead>
              <tr className="text-left text-bh-text-dim border-b border-bh-border">
                <th className="py-2 px-2 whitespace-nowrap">Reason</th>
                <th className="py-2 px-2 whitespace-nowrap">Amount</th>
                <th className="py-2 px-2 whitespace-nowrap">Stripe status</th>
                <th className="py-2 px-2 whitespace-nowrap">Outcome</th>
                <th className="py-2 px-2 whitespace-nowrap">Evidence due</th>
                <th className="py-2 px-2 whitespace-nowrap">Opened</th>
              </tr>
            </thead>
            <tbody>
              {disputes.map((dispute) => (
                <tr className="border-b border-bh-border/50" key={dispute.id} data-testid={`dispute-row-${dispute.id}`}>
                  <td className="py-2 px-2 whitespace-nowrap">{dispute.reason ?? '—'}</td>
                  <td className="py-2 px-2 whitespace-nowrap">{formatUsd(dispute.amountCents)}</td>
                  <td className="py-2 px-2 whitespace-nowrap">{dispute.stripeStatus}</td>
                  <td className={`py-2 px-2 whitespace-nowrap font-medium ${outcomeBadgeClass(dispute.outcome)}`}>{dispute.outcome}</td>
                  <td className="py-2 px-2 whitespace-nowrap">{dispute.evidenceDueBy ? new Date(dispute.evidenceDueBy).toLocaleString() : '—'}</td>
                  <td className="py-2 px-2 whitespace-nowrap">{new Date(dispute.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
