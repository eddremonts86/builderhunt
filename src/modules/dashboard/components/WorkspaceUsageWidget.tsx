import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'
import type { DashboardUsage } from '~/shared/lib/dashboard/contracts'

/**
 * Workspace usage, from the canonical billing summary (plans/ui-dashboard Wave 4, "Replace legacy
 * Plan Usage with canonical Workspace Usage").
 *
 * Body only; `WidgetFrame` owns the header and every non-ready state.
 *
 * ## Why it replaces `PlanUsageWidget`
 *
 * The old widget read `GET /api/plans/me` — the *legacy* endpoint, which
 * `/api/billing/summary` was introduced to replace and which now delegates to the same service
 * during migration. Worse, it then looked the limits up **client-side** from `PLAN_LIMITS`, and had
 * to inline its own copy of `resolveLegacyPlanTier` to do it because the real helper is server-only.
 * Two implementations of "what is this plan allowed", one of them in the browser, is exactly how a
 * dashboard ends up promising a quota the API then refuses.
 *
 * Everything shown here is now computed by the server from the canonical summary, including the
 * warning. The client re-derives nothing.
 *
 * ## Seats, not saved objects
 *
 * The old meters were saved searches and tracked builders — counts that grow slowly and that nobody
 * is blocked by in practice. What actually stops work is a full seat allowance (nobody else can be
 * invited) and an empty credit balance (paid actions are refused), so those are what this shows.
 *
 * ## An absent section is not an empty one
 *
 * A member's payload has no `usage` key at all, so `WidgetFrame` renders `forbidden` — nothing, not
 * a locked tile. This component is never reached for them.
 */

function Meter({ label, used, allowed }: { label: string; used: number; allowed: number }) {
  // `allowed: 0` means unlimited on this plan, not "zero seats". A progress bar against no limit is
  // a lie, so it renders as a bare count.
  const unlimited = allowed <= 0
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / allowed) * 100))
  const tone = pct >= 100 ? 'bg-bh-danger' : pct >= 80 ? 'bg-bh-warning' : 'bg-bh-accent'

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-bh-text-dim">{label}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-bh-text">
          {used.toLocaleString()}
          {!unlimited && <span className="text-bh-text-dim">/{allowed.toLocaleString()}</span>}
        </span>
      </div>
      {!unlimited && (
        <div
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bh-bg-alt"
          role="progressbar"
          aria-label={label}
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={allowed}
        >
          <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

export function WorkspaceUsageWidget({ usage }: { usage: DashboardUsage }) {
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-xs text-bh-text-dim">Plan</span>
        <Link
          to="/settings/billing"
          className="shrink-0 rounded border border-bh-border bg-bh-bg-alt px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-bh-text-muted hover:text-bh-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
        >
          {usage.tier}
        </Link>
      </div>

      <div className="flex flex-col gap-3">
        {usage.seats && <Meter label="Seats used" used={usage.seats.used} allowed={usage.seats.allowed} />}
        {usage.creditBalanceUnits !== null && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs text-bh-text-dim">Credits</span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-bh-text">
              {usage.creditBalanceUnits.toLocaleString()}
            </span>
          </div>
        )}
      </div>

      {usage.warning && (
        /*
         * Already evaluated by the server. The client does not re-derive a threshold: two
         * implementations of "are we near the limit" is two answers, and the one on the dashboard
         * would be the one nobody updates.
         */
        <p className="mt-3 flex items-start gap-1.5 text-xs text-bh-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{usage.warning.message}</span>
        </p>
      )}
    </>
  )
}
