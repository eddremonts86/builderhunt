import * as React from 'react'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui'
import { ErrorState } from '~/shared/components/ErrorState'

interface RefundRow {
  id: string
  organizationId: string
  policyDecision: string
  amountCents: number
  state: string
  createdAt: string
}

const POLICY_OPTIONS = [
  { value: 'full_unused_pack', label: 'Full unused pack' },
  { value: 'partial_pack_operator', label: 'Partial pack (operator)' },
  { value: 'full_subscription_invoice', label: 'Full subscription invoice' },
  { value: 'partial_subscription_operator', label: 'Partial subscription (operator)' },
]

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export function RefundQueue() {
  const [organizationId, setOrganizationId] = React.useState('')
  const [refunds, setRefunds] = React.useState<RefundRow[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [decidingId, setDecidingId] = React.useState<string | null>(null)
  const [policyDecision, setPolicyDecision] = React.useState(POLICY_OPTIONS[1].value)
  const [amountCents, setAmountCents] = React.useState('0')
  const [creditRevocationUnits, setCreditRevocationUnits] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  const load = async () => {
    if (!organizationId.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/billing/refunds?organizationId=${encodeURIComponent(organizationId.trim())}`, { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to load refunds')
        setRefunds(null)
        return
      }
      setRefunds(data.refunds)
    } finally {
      setLoading(false)
    }
  }

  const submitDecision = async (refundId: string) => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/billing/refunds', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          refundId,
          policyDecision,
          amountCents: Number(amountCents),
          creditRevocationUnits: creditRevocationUnits ? Number(creditRevocationUnits) : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to record decision')
        return
      }
      setDecidingId(null)
      await load()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="refund-queue" className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Refund queue</h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Review pending refund requests and record operator decisions for partial packs and subscriptions. Sending the refund to Stripe and applying credit revocation happens asynchronously in the billing worker.
        </p>
      </header>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Label htmlFor="refund-queue-org">Organization ID</Label>
          <Input id="refund-queue-org" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} data-testid="refund-queue-org-input" />
        </div>
        <Button onClick={load} disabled={loading || !organizationId.trim()} data-testid="refund-queue-load">
          {loading ? 'Loading…' : 'Load'}
        </Button>
      </div>

      {error && <ErrorState message={error} icon={false} />}

      {refunds && refunds.length === 0 && (
        <p className="text-sm text-bh-text-muted">No refund requests for this organization.</p>
      )}

      {refunds && refunds.length > 0 && (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Refund requests table, scrollable">
        <table className="w-full text-sm" data-testid="refund-queue-table">
          <thead>
            <tr className="text-left text-bh-text-dim border-b border-bh-border">
              <th className="py-2">Policy</th>
              <th className="py-2">Amount</th>
              <th className="py-2">State</th>
              <th className="py-2">Requested</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {refunds.map((refund) => (
              <React.Fragment key={refund.id}>
                <tr className="border-b border-bh-border/50" data-testid={`refund-row-${refund.id}`}>
                  <td className="py-2">{refund.policyDecision}</td>
                  <td className="py-2">{formatUsd(refund.amountCents)}</td>
                  <td className="py-2">{refund.state}</td>
                  <td className="py-2">{new Date(refund.createdAt).toLocaleString()}</td>
                  <td className="py-2 text-right">
                    {refund.state === 'pending' && (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setDecidingId(decidingId === refund.id ? null : refund.id)
                          setAmountCents(String(refund.amountCents))
                        }}
                        data-testid={`refund-decide-${refund.id}`}
                      >
                        Decide
                      </Button>
                    )}
                  </td>
                </tr>
                {decidingId === refund.id && (
                  <tr>
                    <td colSpan={5} className="py-3">
                      <div className="card p-3 space-y-3">
                        <div>
                          <Label htmlFor="refund-policy-select">Policy decision</Label>
                          <Select value={policyDecision} onValueChange={setPolicyDecision}>
                            <SelectTrigger id="refund-policy-select" data-testid="refund-policy-select">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {POLICY_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label htmlFor="refund-amount-input">Amount (cents)</Label>
                          <Input id="refund-amount-input" type="number" value={amountCents} onChange={(e) => setAmountCents(e.target.value)} data-testid="refund-amount-input" />
                        </div>
                        <div>
                          <Label htmlFor="refund-units-input">Credit units to revoke (partial pack only)</Label>
                          <Input id="refund-units-input" type="number" value={creditRevocationUnits} onChange={(e) => setCreditRevocationUnits(e.target.value)} data-testid="refund-units-input" />
                        </div>
                        <Button onClick={() => submitDecision(refund.id)} disabled={saving} data-testid="refund-submit-decision">
                          {saving ? 'Saving…' : 'Record decision'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  )
}
