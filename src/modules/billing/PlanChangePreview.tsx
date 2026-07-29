import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, Loader2, XCircle } from 'lucide-react'
import { Button } from '~/components/ui'

/**
 * Preview and confirm a subscription plan change (plans/phase-1/30-stripe-billing-platform/tasks.md §7
 * "Implement subscription preview and change matrix" / "Enforce Team downgrade seat blockers").
 * Fetches `POST /api/billing/subscription/preview` on mount and shows the resolved charge/credit/
 * effective-date numbers — never anything the client itself computed. When the organization's
 * current seat usage exceeds the target one-seat tier's limit, the API returns a `seatBlocker`
 * instead of letting the change proceed; this component renders that as a blocking banner linking
 * to `/settings/team` and disables the confirm action entirely. Never evicts a member or cancels an
 * invitation itself — freeing seats is the owner's own action, elsewhere.
 */

interface SubscriptionPreviewResponse {
  currentCatalogKey: string
  newCatalogKey: string
  direction: 'upgrade' | 'downgrade' | 'lateral'
  timing: 'immediate' | 'scheduled'
  stripeAmountDue: number
  stripeCurrency: string
  nextPaymentDate: string
  creditDelta: number
  effectiveAt: string
  fingerprint: string
  seatBlocker?: { currentSeatsUsed: number; targetSeatLimit: number; manageTeamUrl: string }
}

interface SubscriptionChangeResponse {
  applied: 'immediate' | 'scheduled'
  newCatalogKey: string
  effectiveAt: string
  creditDelta: number
}

interface ApiErrorBody {
  error: string
  code?: string
}

async function fetchPreview(newCatalogKey: string): Promise<SubscriptionPreviewResponse> {
  const response = await fetch('/api/billing/subscription/preview', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newCatalogKey }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error((body as ApiErrorBody).error ?? `Failed to preview (${response.status})`)
  return body as SubscriptionPreviewResponse
}

async function submitChange(input: { newCatalogKey: string; fingerprint: string; idempotencyKey: string }): Promise<SubscriptionChangeResponse> {
  const response = await fetch('/api/billing/subscription/change', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await response.json()
  if (!response.ok) throw new Error((body as ApiErrorBody).error ?? `Failed to change plan (${response.status})`)
  return body as SubscriptionChangeResponse
}

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(amountCents / 100)
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

export interface PlanChangePreviewProps {
  newCatalogKey: string
  onChanged?: (result: SubscriptionChangeResponse) => void
  onCancel?: () => void
}

export function PlanChangePreview({ newCatalogKey, onChanged, onCancel }: PlanChangePreviewProps) {
  const previewQuery = useQuery({
    queryKey: ['billing', 'subscription', 'preview', newCatalogKey],
    queryFn: () => fetchPreview(newCatalogKey),
  })

  const changeMutation = useMutation({
    mutationFn: (preview: SubscriptionPreviewResponse) =>
      submitChange({ newCatalogKey: preview.newCatalogKey, fingerprint: preview.fingerprint, idempotencyKey: crypto.randomUUID() }),
    onSuccess: (result) => onChanged?.(result),
  })

  if (previewQuery.isLoading) {
    return (
      <div className="card p-5 flex items-center gap-2 text-sm text-bh-text-muted" data-testid="plan-change-preview-loading">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        Loading preview…
      </div>
    )
  }

  if (previewQuery.isError || !previewQuery.data) {
    return (
      <div className="card border-bh-danger/30 bg-bh-danger/5 p-5 text-sm text-bh-danger" data-testid="plan-change-preview-error">
        <XCircle className="w-4 h-4 inline-block mr-2" aria-hidden="true" />
        {previewQuery.error instanceof Error ? previewQuery.error.message : 'Failed to load preview'}
      </div>
    )
  }

  const preview = previewQuery.data
  const blocked = Boolean(preview.seatBlocker)

  return (
    <section className="card p-5" data-testid="plan-change-preview">
      {preview.seatBlocker && (
        <div className="card border-bh-warning/30 bg-bh-warning/5 p-3 mb-4 flex items-start gap-2 text-sm text-bh-warning" data-testid="plan-change-seat-blocker">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            You have <strong>{preview.seatBlocker.currentSeatsUsed}</strong> seats in use, but this plan only
            allows <strong>{preview.seatBlocker.targetSeatLimit}</strong>. Remove members or cancel outstanding
            invitations on{' '}
            <Link to={preview.seatBlocker.manageTeamUrl as '/settings/team'} className="underline">
              the team page
            </Link>{' '}
            before switching.
          </p>
        </div>
      )}

      <h2 className="text-base font-semibold mb-1" data-testid="plan-change-heading">
        {preview.direction === 'upgrade' ? 'Upgrade' : preview.direction === 'downgrade' ? 'Downgrade' : 'Plan change'} to {preview.newCatalogKey}
      </h2>

      <dl className="text-sm space-y-1.5 mb-4">
        <div className="flex justify-between">
          <dt className="text-bh-text-muted">Due now</dt>
          <dd data-testid="plan-change-amount-due">{formatMoney(preview.stripeAmountDue, preview.stripeCurrency)}</dd>
        </div>
        {preview.creditDelta > 0 && (
          <div className="flex justify-between">
            <dt className="text-bh-text-muted">Extra credits added</dt>
            <dd data-testid="plan-change-credit-delta">{preview.creditDelta.toLocaleString()}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-bh-text-muted">{preview.timing === 'immediate' ? 'Effective' : 'Takes effect'}</dt>
          <dd data-testid="plan-change-effective-at">{formatDate(preview.effectiveAt)}</dd>
        </div>
      </dl>

      {changeMutation.isError && (
        <p className="text-xs text-bh-danger mb-3" data-testid="plan-change-error">
          {changeMutation.error instanceof Error ? changeMutation.error.message : 'Failed to change plan'}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          data-testid="plan-change-confirm"
          disabled={blocked || changeMutation.isPending}
          onClick={() => changeMutation.mutate(preview)}
        >
          {changeMutation.isPending ? 'Confirming…' : preview.timing === 'immediate' ? 'Confirm and pay' : 'Schedule change'}
          <ArrowRight className="w-3 h-3" aria-hidden="true" />
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" size="sm" data-testid="plan-change-cancel" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </section>
  )
}
