import * as React from 'react'
import { Coins } from 'lucide-react'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui'
import { listActivePackCatalog } from '~/shared/lib/billing/catalog'

interface CreditGrant {
  id: string
  source: string
  remainingUnits: number
  expiresAt: string
}

interface RecentRefund {
  policyDecision: string
  amountCents: number
  state: string
  createdAt: string
}

const SOURCE_LABELS: Record<string, string> = {
  subscription_monthly: 'Monthly subscription grant',
  subscription_annual_window: 'Annual subscription grant',
  subscription_upgrade_delta: 'Upgrade credit adjustment',
  pack: 'Purchased pack',
  legacy_manual: 'Manually granted',
  promotional: 'Promotional grant',
  operator_trial: 'Trial grant',
}

const REFUND_STATE_LABELS: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'text-bh-warning' },
  succeeded: { label: 'Refunded', className: 'text-bh-success' },
  failed: { label: 'Failed', className: 'text-bh-danger' },
  repair_needed: { label: 'Needs review', className: 'text-bh-danger' },
}

function formatUsd(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`
}

interface CreditBalanceProps {
  grants: CreditGrant[]
  recentRefunds: RecentRefund[]
  canRequestRefund: boolean
  canPurchasePacks: boolean
}

/**
 * Balance-by-source-and-expiry (plans/phase-1/29-stripe-billing-platform/tasks.md §9 task 2) plus a pack
 * purchase flow and a per-grant refund request. Refund eligibility (fully-unused only) is NOT
 * re-derived client-side — `POST /api/billing/refunds` already enforces it and returns a real error
 * for an ineligible grant, so the button is offered for every `pack`-sourced grant and the server's
 * own answer is shown inline rather than duplicating its business rule here.
 */
export function CreditBalance({ grants, recentRefunds, canRequestRefund, canPurchasePacks }: CreditBalanceProps) {
  const packCatalog = React.useMemo(() => listActivePackCatalog(), [])
  const [selectedPack, setSelectedPack] = React.useState<string>(packCatalog[0]?.key ?? '')
  const [purchasing, setPurchasing] = React.useState(false)
  const [refundingId, setRefundingId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)

  const totalRemaining = grants.reduce((sum, g) => sum + g.remainingUnits, 0)

  const purchasePack = async () => {
    setPurchasing(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/checkout/credits', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          catalogKey: selectedPack,
          country: 'DK',
          disclosures: { renewal: true, amount: true, interval: true, cancellationRefundPolicy: true, creditExpiryNonTransferability: true, tax: true, total: true },
          idempotencyKey: crypto.randomUUID(),
          successUrl: `${window.location.origin}/settings/billing/return`,
          cancelUrl: `${window.location.origin}/settings/billing`,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to start checkout')
        return
      }
      window.location.href = data.checkoutUrl
    } finally {
      setPurchasing(false)
    }
  }

  const requestRefund = async (grantId: string) => {
    setRefundingId(grantId)
    setError(null)
    setMessage(null)
    try {
      const res = await fetch('/api/billing/refunds', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantId, idempotencyKey: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to request a refund for this grant')
        return
      }
      setMessage('Refund requested — an operator will review it shortly.')
    } finally {
      setRefundingId(null)
    }
  }

  return (
    <div className="space-y-4" data-testid="credit-balance">
      <div>
        <h3 className="text-sm font-bold text-bh-text flex items-center gap-2">
          <Coins className="w-4 h-4" aria-hidden="true" />
          Credit balance
        </h3>
        <p className="text-xs text-bh-text-muted mt-1" data-testid="credit-balance-total">
          {totalRemaining.toLocaleString()} credits available
        </p>
      </div>

      {grants.length === 0 ? (
        <p className="text-xs text-bh-text-dim">No active credit grants.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {grants.map((grant) => (
            <li key={grant.id} className="flex items-center justify-between gap-2" data-testid={`credit-grant-${grant.id}`}>
              <div>
                <p className="text-bh-text">{SOURCE_LABELS[grant.source] ?? grant.source}</p>
                <p className="text-xs text-bh-text-dim">
                  {grant.remainingUnits.toLocaleString()} credits · expires {new Date(grant.expiresAt).toLocaleDateString()}
                </p>
              </div>
              {canRequestRefund && grant.source === 'pack' && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={refundingId === grant.id}
                  onClick={() => requestRefund(grant.id)}
                  data-testid={`credit-grant-refund-${grant.id}`}
                >
                  {refundingId === grant.id ? 'Requesting…' : 'Request refund'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-xs text-bh-danger" role="alert" data-testid="credit-balance-error">{error}</p>}
      {message && <p className="text-xs text-bh-success" data-testid="credit-balance-message">{message}</p>}

      {canPurchasePacks && packCatalog.length > 0 && (
        <div className="flex items-end gap-2 pt-2 border-t border-bh-border/60">
          <div className="flex-1">
            <Select value={selectedPack} onValueChange={setSelectedPack}>
              <SelectTrigger aria-label="Credit pack" data-testid="pack-purchase-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {packCatalog.map((pack) => (
                  <SelectItem key={pack.key} value={pack.key}>
                    {pack.credits.toLocaleString()} credits — {formatUsd(pack.amountCents)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" onClick={purchasePack} disabled={purchasing} data-testid="pack-purchase-button">
            {purchasing ? 'Starting…' : 'Buy credits'}
          </Button>
        </div>
      )}

      {recentRefunds.length > 0 && (
        <div className="pt-2 border-t border-bh-border/60">
          <p className="text-xs font-semibold text-bh-text-dim uppercase tracking-wide mb-2">Recent refunds</p>
          <ul className="space-y-1 text-xs">
            {recentRefunds.map((refund, i) => (
              <li key={i} className="flex items-center justify-between" data-testid={`recent-refund-${i}`}>
                <span className="text-bh-text-muted">{formatUsd(refund.amountCents)} · {new Date(refund.createdAt).toLocaleDateString()}</span>
                <span className={REFUND_STATE_LABELS[refund.state]?.className ?? 'text-bh-text-muted'}>
                  {REFUND_STATE_LABELS[refund.state]?.label ?? refund.state}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
