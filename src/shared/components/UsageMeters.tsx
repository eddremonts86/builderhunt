import * as React from 'react'
import { Link } from '@tanstack/react-router'

export interface UsageCounts {
  savedSearches: number
  savedBuilders: number
}

/** `null` means unlimited — mirrors `BillingUsageLimitsDto`, which encodes it that way because
 *  `JSON.stringify(Infinity)` is `null` regardless of intent. */
export interface UsageLimits {
  savedSearches: number | null
  savedBuilders: number | null
  rssSubscriptions: number | null
}

const ROWS = [
  {
    key: 'savedSearches' as const,
    label: 'Saved searches',
    description: 'Search alerts that notify you when new builders match your criteria.',
  },
  {
    key: 'savedBuilders' as const,
    label: 'Saved builders',
    description: "Builders you've added to your pipeline for tracking and outreach.",
  },
]

/**
 * The saved-item capacity meters, shared by `/settings/billing` and the account summary on `/me`.
 *
 * Only the bars live here, not a card or heading: the two callers frame them differently (a
 * standalone Usage section vs. one block inside the account card) but the bars themselves must read
 * identically, since they describe the same limits enforced by the same API. `limits` covers
 * `rssSubscriptions` too, but `BillingUsageDto` carries no counter for it, so there is deliberately
 * no third bar — a meter with no numerator would be decoration.
 */
export function UsageMeters({ usage, limits, showUpgradeHint = true }: {
  usage: UsageCounts
  limits: UsageLimits
  /** Off where an upgrade link would be redundant next to one the caller already renders. */
  showUpgradeHint?: boolean
}) {
  return (
    <div className="space-y-4">
      {ROWS.map((row) => {
        const limit = limits[row.key]
        const current = usage[row.key]
        const isUnlimited = limit === null
        const pct = isUnlimited ? 0 : Math.min(100, Math.round((current / Math.max(1, limit)) * 100))
        return (
          <div key={row.key} data-testid={`usage-${row.key}`}>
            <div className="flex items-center justify-between text-sm mb-1">
              <span>{row.label}</span>
              <span className="text-bh-text-muted">{current} / {isUnlimited ? '∞' : limit}</span>
            </div>
            <p className="text-xs text-bh-text-dim mb-1.5">{row.description}</p>
            <div className="h-1.5 rounded-full bg-bh-surface overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  isUnlimited ? 'bg-bh-cyan/30' : pct >= 90 ? 'bg-bh-danger' : pct >= 70 ? 'bg-bh-warning' : 'bg-bh-accent'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {showUpgradeHint && !isUnlimited && pct >= 90 && (
              <p className="text-xs text-bh-danger mt-1">
                You're almost at your {row.label.toLowerCase()} limit. Delete unused items or{' '}
                <Link to="/pricing" className="underline">upgrade for more room</Link>.
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
