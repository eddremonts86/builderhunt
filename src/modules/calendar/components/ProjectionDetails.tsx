import { ExternalLink, Lock, X } from 'lucide-react'
import { Button } from '~/components/ui'

/**
 * Read-only detail panel for a calendar projection (plan:
 * calendar-scheduling-interview-intelligence, Phase 4 "Add calendar layer UI").
 *
 * Projections are views of something that lives elsewhere, so this panel offers no edit affordance
 * at all — not a disabled one. A greyed-out Save button invites the user to wonder what unlocks it;
 * an explicit "managed elsewhere" statement plus a link to the source answers the question instead.
 */

export interface ProjectionItem {
  kind: 'job_projection' | 'alert_projection' | 'job_run' | 'alert_result'
  title: string
  startsAt: string
  endsAt: string
  sourceType: string
  sourceId: string
  safeSourceRoute: string
  estimateOnly: boolean
  state?: string
  matchCount?: number
}

const KIND_LABELS: Record<ProjectionItem['kind'], string> = {
  job_projection: 'Scheduled job',
  alert_projection: 'Scheduled alert check',
  job_run: 'Completed job run',
  alert_result: 'Alert matches',
}

function formatInstant(value: string): string {
  return new Date(value).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export interface ProjectionDetailsProps {
  item: ProjectionItem
  onClose: () => void
}

export function ProjectionDetails({ item, onClose }: ProjectionDetailsProps) {
  return (
    <aside
      // A dialog role would trap focus for something that is purely informational; a labelled region
      // lets a keyboard user read it and move on.
      role="region"
      aria-label={`${KIND_LABELS[item.kind]} details`}
      className="mb-6 rounded-xl border border-bh-border bg-bh-surface p-4"
      data-testid="projection-details"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-bh-text-muted" data-testid="projection-kind">
            {KIND_LABELS[item.kind]}
          </p>
          <h3 className="mt-1 text-base font-medium">{item.title}</h3>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close details" data-testid="projection-close">
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-bh-text-muted">
            {/* The label itself carries the distinction: an estimate is not a record, and calling both
                "when" would flatten the difference the feed works to preserve. */}
            {item.estimateOnly ? 'Expected at' : 'Happened at'}
          </dt>
          <dd data-testid="projection-when">{formatInstant(item.startsAt)}</dd>
        </div>
        {item.estimateOnly && (
          <div className="sm:col-span-2">
            <dt className="text-bh-text-muted">Certainty</dt>
            <dd data-testid="projection-estimate-note">
              This is an estimate of when we intend to run, not a promise that anything will be found.
            </dd>
          </div>
        )}
        {item.state && (
          <div>
            <dt className="text-bh-text-muted">Outcome</dt>
            <dd data-testid="projection-state">{item.state}</dd>
          </div>
        )}
        {typeof item.matchCount === 'number' && (
          <div>
            <dt className="text-bh-text-muted">Matches</dt>
            <dd data-testid="projection-match-count">{item.matchCount}</dd>
          </div>
        )}
      </dl>

      <p className="mt-4 flex items-center gap-2 text-xs text-bh-text-muted" data-testid="projection-readonly-note">
        <Lock className="size-3.5 shrink-0" aria-hidden />
        Managed by the system. You cannot move or edit this from the calendar.
      </p>

      <a
        href={item.safeSourceRoute}
        className="mt-3 inline-flex items-center gap-1.5 text-sm text-bh-accent underline underline-offset-2"
        data-testid="projection-source-link"
      >
        <ExternalLink className="size-3.5" aria-hidden />
        Go to the source
      </a>
    </aside>
  )
}
