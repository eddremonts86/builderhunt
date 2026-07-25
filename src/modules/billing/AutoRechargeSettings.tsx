import * as React from 'react'
import { AlertTriangle, Zap } from 'lucide-react'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui'
import { LoadingState } from '~/shared/components/LoadingState'
import { ErrorState } from '~/shared/components/ErrorState'

interface PackOption {
  key: string
  amountCents: number
  credits: number
}

const PACK_OPTIONS: PackOption[] = [
  { key: 'starter_300', amountCents: 1500, credits: 300 },
  { key: 'scale_1000', amountCents: 4500, credits: 1000 },
  { key: 'max_5000', amountCents: 29900, credits: 5000 },
]

interface AutoRechargeRule {
  organizationId: string
  enabled: boolean
  packCatalogKey: string | null
  balanceThresholdUnits: number | null
  monthlyCapCents: number | null
  state: string
  lastFailureAt: string | null
  lastFailureReason: string | null
}

interface AutoRechargeResponse {
  rule: AutoRechargeRule | null
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

async function fetchRule(): Promise<AutoRechargeRule | null> {
  const res = await fetch('/api/billing/auto-recharge', { credentials: 'include' })
  if (!res.ok) return null
  const data = (await res.json()) as AutoRechargeResponse
  return data.rule
}

export function AutoRechargeSettings() {
  const [rule, setRule] = React.useState<AutoRechargeRule | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [packCatalogKey, setPackCatalogKey] = React.useState(PACK_OPTIONS[0].key)
  const [balanceThresholdUnits, setBalanceThresholdUnits] = React.useState('50')
  const [monthlyCapCents, setMonthlyCapCents] = React.useState('10000')
  const [acknowledged, setAcknowledged] = React.useState(false)

  React.useEffect(() => {
    fetchRule().then((r) => {
      setRule(r)
      setLoading(false)
    })
  }, [])

  const enable = async () => {
    if (!acknowledged) {
      setError('You must acknowledge that this card will be charged automatically, without further confirmation.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/auto-recharge', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          packCatalogKey,
          balanceThresholdUnits: Number(balanceThresholdUnits),
          monthlyCapCents: Number(monthlyCapCents),
          acknowledgedOffSessionCharge: true,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to enable auto-recharge')
        return
      }
      setRule(data.rule)
    } finally {
      setSaving(false)
    }
  }

  const disable = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/auto-recharge', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to disable auto-recharge')
        return
      }
      setRule(data.rule)
    } finally {
      setSaving(false)
    }
  }

  const openPortal = async () => {
    const res = await fetch('/api/billing/portal', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnUrl: window.location.href }),
    })
    const data = await res.json()
    if (res.ok && data.url) window.location.href = data.url
  }

  if (loading) {
    return (
      <div className="card p-5">
        <LoadingState message="Loading auto-recharge…" />
      </div>
    )
  }

  const isPaused = rule?.state === 'paused_needs_auth' || rule?.state === 'paused_failed'

  return (
    <section className="card p-5" data-testid="auto-recharge-settings">
      <h2 className="font-semibold mb-1 flex items-center gap-2">
        <Zap className="w-4 h-4 text-bh-accent" aria-hidden="true" />
        Auto-recharge
      </h2>
      <p className="text-xs text-bh-text-dim mb-4">
        Automatically buy a credit pack when your balance runs low. Off by default — at most 3 charges or $1,000 per 24 hours, shared with manual pack purchases.
      </p>

      {error && <ErrorState message={error} icon={false} className="mb-4" />}

      {isPaused && (
        <div className="mb-4 p-3 rounded border border-bh-warning/30 bg-bh-warning/5 text-sm" data-testid="auto-recharge-paused">
          <div className="flex items-start gap-2 text-bh-warning">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">Auto-recharge is paused</p>
              <p className="text-xs text-bh-text-muted mt-0.5">{rule?.lastFailureReason ?? 'Payment needs your attention.'}</p>
              <Button variant="secondary" className="mt-2" onClick={openPortal} data-testid="auto-recharge-resolve">
                Resolve in Billing Portal
              </Button>
            </div>
          </div>
        </div>
      )}

      {rule?.enabled ? (
        <div className="space-y-3">
          <dl className="text-sm grid grid-cols-2 gap-2">
            <dt className="text-bh-text-dim">Pack</dt>
            <dd data-testid="auto-recharge-pack">{PACK_OPTIONS.find((p) => p.key === rule.packCatalogKey)?.credits ?? '—'} credits</dd>
            <dt className="text-bh-text-dim">Threshold</dt>
            <dd data-testid="auto-recharge-threshold">{rule.balanceThresholdUnits} credits</dd>
            <dt className="text-bh-text-dim">Monthly cap</dt>
            <dd data-testid="auto-recharge-cap">{formatUsd(rule.monthlyCapCents ?? 0)}</dd>
            <dt className="text-bh-text-dim">Status</dt>
            <dd data-testid="auto-recharge-state">{rule.state}</dd>
          </dl>
          <Button variant="secondary" onClick={disable} disabled={saving} data-testid="auto-recharge-disable">
            Disable auto-recharge
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <Label htmlFor="auto-recharge-pack-select">Pack to purchase</Label>
            <Select value={packCatalogKey} onValueChange={setPackCatalogKey}>
              <SelectTrigger id="auto-recharge-pack-select" data-testid="auto-recharge-pack-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PACK_OPTIONS.map((pack) => (
                  <SelectItem key={pack.key} value={pack.key}>
                    {pack.credits} credits — {formatUsd(pack.amountCents)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="auto-recharge-threshold-input">Recharge when balance falls below</Label>
            <Input
              id="auto-recharge-threshold-input"
              type="number"
              min={0}
              value={balanceThresholdUnits}
              onChange={(e) => setBalanceThresholdUnits(e.target.value)}
              data-testid="auto-recharge-threshold-input"
            />
          </div>
          <div>
            <Label htmlFor="auto-recharge-cap-input">Monthly cap (USD cents, max 100000 = $1,000)</Label>
            <Input
              id="auto-recharge-cap-input"
              type="number"
              min={1}
              max={100000}
              value={monthlyCapCents}
              onChange={(e) => setMonthlyCapCents(e.target.value)}
              data-testid="auto-recharge-cap-input"
            />
          </div>
          <label className="flex items-start gap-2 text-xs text-bh-text-muted">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5"
              data-testid="auto-recharge-acknowledge"
            />
            I understand my saved card will be charged automatically, without further confirmation, when my balance falls below the threshold above.
          </label>
          <Button onClick={enable} disabled={saving} data-testid="auto-recharge-enable">
            Enable auto-recharge
          </Button>
        </div>
      )}
    </section>
  )
}
