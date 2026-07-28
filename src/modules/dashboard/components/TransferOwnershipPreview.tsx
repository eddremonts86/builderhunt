import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, CreditCard, Loader2, XCircle } from 'lucide-react'
import { Button } from '~/components/ui'

/**
 * Read-only preview shown inside the transfer-ownership confirm dialog
 * (plans/phase-1/29-stripe-billing-platform/tasks.md §9 task 5). Plain `fetch` + local
 * state, matching this module's own established convention (team.tsx uses
 * manual fetch throughout, not React Query) rather than introducing a
 * QueryClientProvider dependency into OrganizationDangerZone's tests.
 * Fetches `GET /api/organizations/transfer-ownership-preview` on mount —
 * this endpoint takes no target-user parameter: the preview describes what
 * happens to the organization's OWN billing state (masked payment method,
 * next charge, whether the subscription is already scheduled to cancel),
 * which is unaffected by who becomes the new owner.
 */

interface OwnershipTransferPreviewResponse {
  hasBillingCustomer: boolean
  paymentMethod: { brand: string; last4: string } | null
  tier: string
  billingPeriod: string
  currentPeriodEnd: string | null
  nextChargeAmountCents: number | null
  cancelAtPeriodEnd: boolean
}

function formatMoney(amountCents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(amountCents / 100)
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

export interface TransferOwnershipPreviewProps {
  targetName: string
  confirmDisabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function TransferOwnershipPreview({ targetName, confirmDisabled = false, onConfirm, onCancel }: TransferOwnershipPreviewProps) {
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<OwnershipTransferPreviewResponse | null>(null)

  React.useEffect(() => {
    let cancelled = false
    fetch('/api/organizations/transfer-ownership-preview', { credentials: 'include' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Failed to load billing preview')
        if (!cancelled) setPreview(body as OwnershipTransferPreviewResponse)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load billing preview')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-bh-text-muted py-6" data-testid="transfer-ownership-preview-loading">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        Loading billing preview…
      </div>
    )
  }

  if (error || !preview) {
    return (
      <div className="text-sm text-bh-danger py-6" data-testid="transfer-ownership-preview-error">
        <XCircle className="w-4 h-4 inline-block mr-2" aria-hidden="true" />
        {error ?? 'Failed to load billing preview'}
      </div>
    )
  }

  return (
    <div data-testid="transfer-ownership-preview">
      <p className="text-sm text-bh-text-muted mb-4">
        <strong className="text-bh-text">{targetName}</strong> will become the owner of this organization, with full
        control over billing, members, and settings.
      </p>

      {preview.hasBillingCustomer ? (
        <dl className="text-sm space-y-1.5 mb-4 card p-3">
          <div className="flex justify-between">
            <dt className="text-bh-text-muted">Payment method</dt>
            <dd className="flex items-center gap-1.5" data-testid="transfer-ownership-payment-method">
              <CreditCard className="w-3.5 h-3.5" aria-hidden="true" />
              {preview.paymentMethod ? `${preview.paymentMethod.brand} •••• ${preview.paymentMethod.last4}` : 'None on file'}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-bh-text-muted">Plan</dt>
            <dd>{preview.tier} ({preview.billingPeriod})</dd>
          </div>
          {preview.cancelAtPeriodEnd && preview.currentPeriodEnd ? (
            <div className="flex justify-between">
              <dt className="text-bh-text-muted">Status</dt>
              <dd data-testid="transfer-ownership-cancel-notice">Cancels {formatDate(preview.currentPeriodEnd)}</dd>
            </div>
          ) : (
            preview.nextChargeAmountCents !== null && preview.currentPeriodEnd && (
              <div className="flex justify-between">
                <dt className="text-bh-text-muted">Next charge</dt>
                <dd data-testid="transfer-ownership-next-charge">
                  {formatMoney(preview.nextChargeAmountCents)} on {formatDate(preview.currentPeriodEnd)}
                </dd>
              </div>
            )
          )}
        </dl>
      ) : (
        <p className="text-sm text-bh-text-muted mb-4" data-testid="transfer-ownership-no-billing">
          This organization has no active subscription — nothing billing-related changes with this transfer.
        </p>
      )}

      <div className="card border-bh-warning/30 bg-bh-warning/5 p-3 mb-4 flex items-start gap-2 text-sm text-bh-warning">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <p>
          Billing continues uninterrupted under the new owner.{' '}
          <Link to="/settings/billing" className="underline">
            Manage payment method
          </Link>{' '}
          before transferring if you want to replace it first.
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="danger-outline"
          size="sm"
          data-testid="transfer-ownership-confirm"
          disabled={confirmDisabled}
          onClick={onConfirm}
        >
          Confirm transfer
        </Button>
        <Button type="button" variant="secondary" size="sm" data-testid="transfer-ownership-preview-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
