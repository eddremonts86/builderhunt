import * as React from 'react'
import { Link } from '@tanstack/react-router'
import type { DashboardInvitationDistribution } from '~/shared/lib/dashboard/contracts'

/**
 * Interview invitations by state (plans/ui-dashboard Wave 5). Body only; `WidgetFrame` owns the
 * header and every non-ready state.
 *
 * ## Why this is bars and not a funnel
 *
 * The seven states are not a pipeline. `expired` and `revoked` are terminal, `declined` is an answer
 * rather than a failure, and an invitation reaches `booked` without necessarily passing through
 * `opened` — that column only records an open when the candidate loads the portal in a browser that
 * runs the request. A funnel would invite a conversion rate computed from a denominator that does not
 * mean what it looks like.
 *
 * ## Every state is listed, including the zeros
 *
 * A distribution that hides its empty categories changes shape between two workspaces for reasons
 * that have nothing to do with the data, and a reader comparing them learns something false. The
 * zeros are dimmed, not dropped.
 */

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  opened: 'Opened',
  booked: 'Booked',
  declined: 'Declined',
  expired: 'Expired',
  revoked: 'Revoked',
}

/** The two the organizer has to act on, tinted so they read before the rest. */
const NEEDS_ACTION = new Set(['declined', 'expired'])

export function InvitationStatusWidget({ distribution }: { distribution: DashboardInvitationDistribution }) {
  const max = Math.max(1, ...distribution.counts.map((entry) => entry.count))

  return (
    <>
      <p className="-mt-2 mb-3 text-xs font-light text-bh-text-muted">
        Your {distribution.total} interview invitation{distribution.total === 1 ? '' : 's'} by state.
        {distribution.needsAction > 0 && (
          <> <span className="text-bh-warning">{distribution.needsAction} waiting on you.</span></>
        )}
      </p>

      <ul className="flex flex-col gap-2">
        {distribution.counts.map(({ status, count }) => {
          const pct = Math.round((count / max) * 100)
          const highlight = NEEDS_ACTION.has(status) && count > 0
          return (
            <li key={status} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className={`truncate text-xs ${count === 0 ? 'text-bh-text-dim/60' : 'text-bh-text-dim'}`}>
                  {STATUS_LABEL[status] ?? status}
                </span>
                <span className={`shrink-0 font-mono text-xs tabular-nums ${count === 0 ? 'text-bh-text-dim/60' : 'text-bh-text'}`}>
                  {count}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bh-bg-alt">
                <div
                  className={`h-full rounded-full ${highlight ? 'bg-bh-warning' : 'bg-bh-accent'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>

      <Link
        to="/interviews/invitations"
        className="mt-3 inline-block text-xs text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
      >
        Manage invitations
      </Link>
    </>
  )
}
