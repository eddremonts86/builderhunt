import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Mail } from 'lucide-react'
import { formatDistanceToNow } from '~/shared/lib/format'
import { BentoTileHeader, BentoTileList } from '~/modules/dashboard/ui/bento/Bento'
import { LinkButton } from '~/components/ui'

/**
 * What the alerts fired recently.
 *
 * Backed by `GET /api/alerts/triggers`
 * (src/shared/lib/repositories/organization-alerts.ts `listOrganizationTriggers`),
 * already ordered by `matchedAt` descending. The shell badges the unread count in
 * the rail; this widget is the part that says *what* happened, which the count
 * alone cannot.
 */

export interface AlertTrigger {
  id: string
  alertId: string
  builderId: string | null
  eventType: string
  matchedAt: string
  readAt: string | null
}

/** `alert_triggers.event_type` values, given a human label. */
const EVENT_LABELS: Record<string, string> = {
  new_match: 'New match',
  new_repo: 'New repository',
  new_post: 'New post',
  activity_spike: 'Activity spike',
  profile_change: 'Profile updated',
}

function labelFor(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType.replace(/_/g, ' ')
}

export function AlertsWidget({ triggers }: { triggers: readonly AlertTrigger[] }) {
  const unread = triggers.filter((t) => !t.readAt).length

  return (
    <>
      <BentoTileHeader
        title="Alerts"
        icon={Mail}
        tone="cyan"
        action={triggers.length > 0 ? (
          <Link
            to="/alerts"
            className="flex items-center gap-1 rounded px-0.5 text-xs font-semibold text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
          >
            Inbox <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        ) : undefined}
      />

      {triggers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-bh-border bg-bh-bg-alt/50 p-4 text-center">
          <Mail className="mx-auto mb-2 h-8 w-8 text-bh-text-dim opacity-50" aria-hidden="true" />
          <p className="mb-1 text-sm font-semibold text-bh-text">Nothing fired yet</p>
          <p className="mb-3 text-xs font-light text-bh-text-muted">
            Alerts watch a saved search and tell you when someone new matches.
          </p>
          <LinkButton
            to="/alerts"
            variant="secondary"
            size="sm"
            className="py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
          >
            Set up an alert
          </LinkButton>
        </div>
      ) : (
        <>
          {unread > 0 && (
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-bh-accent">
              {unread} unread
            </p>
          )}
          <BentoTileList>
            <ul>
              {triggers.slice(0, 5).map((trigger) => (
                <li key={trigger.id} className="flex items-center gap-2 px-6 py-2.5">
                  {/* A dot only where it carries state: unread vs read. */}
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${trigger.readAt ? 'bg-bh-border-strong' : 'bg-bh-accent'}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-bh-text">
                    {labelFor(trigger.eventType)}
                    {trigger.readAt === null && <span className="sr-only"> (unread)</span>}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-bh-text-dim">
                    {formatDistanceToNow(new Date(trigger.matchedAt))}
                  </span>
                </li>
              ))}
            </ul>
          </BentoTileList>
        </>
      )}
    </>
  )
}
