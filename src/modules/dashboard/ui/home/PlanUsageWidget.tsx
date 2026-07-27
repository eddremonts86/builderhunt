import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Gauge } from 'lucide-react'
import { PLAN_LIMITS, type PlanTier } from '~/shared/lib/billing-shared'
import { BentoTileHeader } from '~/modules/dashboard/ui/bento/Bento'

/**
 * How much of the plan is used.
 *
 * Limits come from `PLAN_LIMITS` in billing-shared.ts, the same table the API
 * enforces against, and the tier from `GET /api/plans/me`. That matters: a raw
 * "Saved searches 1" tells you nothing, while "1 of 3" tells you when you are
 * about to be blocked. `Infinity` limits render as a count with no bar, because
 * a progress bar against no limit is a lie.
 */

export interface PlanUsage {
  tier: PlanTier
  savedSearches: number
  savedBuilders: number
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const unlimited = !Number.isFinite(limit)
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100))
  // Warn before the wall, not at it.
  const tone = pct >= 90 ? 'bg-bh-danger' : pct >= 70 ? 'bg-bh-warning' : 'bg-bh-accent'

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-bh-text-dim">{label}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-bh-text">
          {used.toLocaleString()}
          {!unlimited && <span className="text-bh-text-dim">/{limit.toLocaleString()}</span>}
        </span>
      </div>
      {!unlimited && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bh-bg-alt">
          <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

export function PlanUsageWidget({ usage }: { usage: PlanUsage }) {
  const limits = PLAN_LIMITS[usage.tier]

  return (
    <>
      <BentoTileHeader
        title="Plan usage"
        icon={Gauge}
        tone="warning"
        action={(
          <Link
            to="/settings/billing"
            className="shrink-0 rounded border border-bh-border bg-bh-bg-alt px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-bh-text-muted hover:text-bh-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
          >
            {usage.tier}
          </Link>
        )}
      />
      <div className="flex flex-col gap-3">
        <Meter label="Saved searches" used={usage.savedSearches} limit={limits.savedSearches} />
        <Meter label="Tracked builders" used={usage.savedBuilders} limit={limits.savedBuilders} />
      </div>
    </>
  )
}
