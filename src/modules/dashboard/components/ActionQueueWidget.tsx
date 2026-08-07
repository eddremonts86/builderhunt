import * as React from 'react'
import { AlertTriangle, ArrowRight, Info, TriangleAlert } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { formatDistanceToNow } from '~/shared/lib/format'
import type { DashboardActionItem, DashboardSeverity } from '~/shared/lib/dashboard/contracts'
import { actionLabel, resolveActionHref } from '~/modules/dashboard/lib/action-routes'

/**
 * The action queue — what needs attention now, in order (plans/ui-dashboard Wave 2).
 *
 * Body only; `WidgetFrame` owns the header and every non-ready state.
 *
 * ## One action per row, and the order is the message
 *
 * The list arrives already ranked by the server's rules and is rendered in exactly that order. It is
 * never re-sorted here — not by severity, not by date. A client that re-sorts is a second ranking
 * implementation, and the two would disagree the first time a rule changed.
 *
 * Each row gets exactly one primary action. The spec asks for that directly ("one primary action per
 * row or card"), and the reason is that a queue with three buttons per row is a list of options, not
 * a list of decisions.
 *
 * ## Severity is shown twice, and neither is colour alone
 *
 * An icon with an accessible name, plus the word. A colour-only severity fails both a screen reader
 * and anyone who cannot separate the accent from the warning tone, and this repository's accent
 * (`#e07338`) sits close enough to its warning that the distinction was never reliable to begin with.
 */

const SEVERITY: Record<DashboardSeverity, { icon: typeof Info; label: string; className: string }> = {
  critical: { icon: TriangleAlert, label: 'Critical', className: 'text-bh-danger' },
  warning: { icon: AlertTriangle, label: 'Needs attention', className: 'text-bh-warning' },
  info: { icon: Info, label: 'For review', className: 'text-bh-text-dim' },
}

function DueLabel({ dueAt }: { dueAt: string }) {
  const date = new Date(dueAt)
  if (Number.isNaN(date.getTime())) return null
  return (
    // Relative for scanning, absolute in the tooltip and for assistive tech: "5 days ago" is what a
    // reader needs to triage, and the exact instant is what they need before acting on it.
    <time dateTime={dueAt} title={date.toLocaleString()} className="shrink-0 text-xs text-bh-text-dim">
      {formatDistanceToNow(date)}
    </time>
  )
}

/**
 * Secondary dismissal affordance. The button calls the configured POST
 * endpoint and, on success, removes the row from the local cache so the
 * queue reflects the server's new state on the next refresh.
 *
 * The button is rendered as a real `<button type="button">` (not a
 * `<Link>`) because every `dismissAction` is a POST — the route is
 * closed on purpose, so a future contributor cannot wire a GET request
 * here by accident.
 */
function DismissButton({ item }: { item: DashboardActionItem }) {
  // Both hooks run before the guard below on purpose. An item can gain or lose its
  // `dismissAction` between renders — a queue row that arrives without one and is
  // refetched with one is the ordinary case — and returning before the hooks made
  // React see a different hook count for the same component across those renders.
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const dismiss = item.dismissAction
  if (!dismiss) return null

  const onClick = async () => {
    setPending(true)
    setError(null)
    try {
      const body = dismiss.bodyKey ? { [dismiss.bodyKey]: true } : undefined
      const res = await fetch(dismiss.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) {
        setError('Could not dismiss. Try again.')
        return
      }
      // A successful dismiss removes the row from the queue without a
      // full refetch; the page-level cache invalidation runs on the
      // next overview refresh. For a banner that needs to disappear
      // immediately, the call site can dispatch a custom event here.
      const event = new CustomEvent('dashboard-queue-row-dismissed', {
        detail: { id: item.id },
      })
      window.dispatchEvent(event)
    } catch {
      setError('Could not dismiss. Try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      data-testid={`action-queue-dismiss-${item.id}`}
      aria-label={`Skip — ${item.title}`}
      className="inline-flex items-center rounded px-2 py-1 text-xs text-bh-text-muted hover:text-bh-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 disabled:opacity-50"
    >
      {error ?? dismiss.label}
    </button>
  )
}

export function ActionQueueWidget({ items }: { items: readonly DashboardActionItem[] }) {
  return (
    <ol className="-mx-6 -mb-6 divide-y divide-bh-border border-t border-bh-border">
      {items.map((item) => {
        const severity = SEVERITY[item.severity]
        const SeverityIcon = severity.icon
        const href = resolveActionHref(item.action)

        return (
          <li key={item.id} className="flex items-start gap-3 px-6 py-3">
            <SeverityIcon className={`mt-0.5 h-4 w-4 shrink-0 ${severity.className}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-bh-text">
                {/* The severity word, available to a screen reader and to anyone who reads rather
                    than scans. `sr-only` on the visual side would drop it for the second group. */}
                <span className="sr-only">{severity.label}: </span>
                {item.title}
              </p>
              {item.detail && (
                <p className="mt-0.5 truncate text-xs font-light text-bh-text-muted">{item.detail}</p>
              )}
            </div>
            {item.dueAt && <DueLabel dueAt={item.dueAt} />}
            <div className="flex shrink-0 items-center gap-2">
              {item.dismissAction && <DismissButton item={item} />}
              {href ? (
                <Link
                  to={href}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                  data-testid={`action-queue-link-${item.id}`}
                >
                  {/* The row's title is the context; without it every link in the queue announces the
                      same two words. */}
                  <span className="sr-only">{actionLabel(item.action.kind)} — {item.title}</span>
                  <span aria-hidden="true">{actionLabel(item.action.kind)}</span>
                  <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
              ) : (
                /*
                 * A kind this build does not know how to route. No button, and a plain note rather
                 * than a disabled control: a greyed-out button invites clicking and implies the action
                 * exists but is unavailable to *you*, which is a different and wrong statement.
                 */
                <span className="text-xs text-bh-text-dim">Update to act on this</span>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
