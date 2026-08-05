import * as React from 'react'
import { AlertTriangle, Clock, Loader2, RotateCw } from 'lucide-react'
import { BentoTileHeader } from '~/modules/dashboard/ui/bento/Bento'
import { Button } from '~/components/ui'
import { hasWidgetData, type WidgetState } from '~/modules/dashboard/lib/contracts'

/**
 * The one place a widget's non-ready states are rendered (plans/ui-dashboard Wave 0, "Distinguish
 * every widget state").
 *
 * ## Why the frame owns this and not each widget
 *
 * Before this, every widget rendered its own "nothing here" copy from an empty array, and the page
 * produced that array by catching failed fetches. Seven widgets meant seven different empty states,
 * seven different (absent) error states, and one shared bug: a failure and a genuinely quiet
 * workspace looked identical. Centralizing means a widget body only ever runs with data in hand, and
 * every failure looks the same to a user and to a screen reader.
 *
 * ## What each state is allowed to say
 *
 * - **empty** may suggest what to create. It is the only state that knows there is nothing.
 * - **error** offers a retry and says nothing about why. Upstream messages carry request parameters
 *   and occasionally credentials; the search connectors' `detail: 'Source unavailable'` convention is
 *   the same decision.
 * - **unavailable** carries a short code and no configuration value, provider text, or URL. It is the
 *   state for "retrying will not help", so it does not offer a retry.
 * - **forbidden** renders **nothing at all** — not a locked tile, not a name. A placeholder saying
 *   "Billing (no access)" confirms the workspace has billing and that this person is outside it,
 *   which is a disclosure the widget was omitted to avoid.
 * - **stale** and **partial** render the data with a caption. They are the two states where showing
 *   something is right and showing it unqualified is not.
 *
 * The status line is `role="status"` rather than `role="alert"`: a widget arriving stale is not an
 * interruption, and seven simultaneous alerts on first paint would be unusable.
 */

export interface WidgetFrameProps<T> {
  title: string
  icon?: React.ComponentType<{ className?: string }>
  tone?: 'accent' | 'success' | 'warning' | 'cyan' | 'dim'
  state: WidgetState<T>
  /** Rendered right of the title in every state that shows a header. */
  action?: React.ReactNode
  /** What the user could do about an empty workspace. Omitted when there is nothing to suggest. */
  emptyAction?: React.ReactNode
  emptyMessage?: string
  onRetry?: () => void
  /** Receives data only in `ready`, `stale` and `partial`. There is no way to call it otherwise. */
  children: (data: T) => React.ReactNode
}

/** Absolute time, spelled out. A widget caption is exactly where "2 hours ago" hides a stuck job. */
function formatGeneratedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'an unknown time'
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function WidgetFrame<T>({
  title, icon, tone = 'accent', state, action, emptyAction, emptyMessage, onRetry, children,
}: WidgetFrameProps<T>) {
  const headingId = React.useId()

  // Renders nothing — no header, no box, no name. See the note above.
  if (state.kind === 'forbidden') return null

  const header = <BentoTileHeader id={headingId} title={title} icon={icon} tone={tone} action={action} />

  if (state.kind === 'loading') {
    return (
      <>
        {header}
        <div className="flex items-center gap-2 py-8 text-sm text-bh-text-dim" role="status">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <span>Loading {title.toLowerCase()}…</span>
        </div>
      </>
    )
  }

  if (state.kind === 'empty') {
    return (
      <>
        {header}
        <div className="py-8 text-center">
          <p className="text-sm font-light text-bh-text-muted">
            {emptyMessage ?? `No ${title.toLowerCase()} yet.`}
          </p>
          {emptyAction && <div className="mt-3">{emptyAction}</div>}
        </div>
      </>
    )
  }

  if (state.kind === 'error') {
    return (
      <>
        {header}
        <div className="py-8 text-center" role="status">
          <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-bh-warning" aria-hidden="true" />
          {/* Deliberately says nothing about the cause. */}
          <p className="text-sm text-bh-text-muted">{title} could not be loaded.</p>
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry} className="mt-3">
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </Button>
          )}
        </div>
      </>
    )
  }

  if (state.kind === 'unavailable') {
    return (
      <>
        {header}
        <div className="py-8 text-center" role="status">
          <p className="text-sm text-bh-text-muted">{title} is unavailable right now.</p>
          {/* A short code an operator can grep for, and nothing an attacker can learn from. */}
          <p className="mt-1 text-xs text-bh-text-dim">Reference: {state.code}</p>
        </div>
      </>
    )
  }

  if (!hasWidgetData(state)) {
    // Unreachable while `WidgetState` has exactly the members above; kept so adding a member is a
    // type error here rather than a blank tile in production.
    const exhaustive: never = state
    return exhaustive
  }

  return (
    <>
      {header}
      {state.kind === 'stale' && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-bh-text-dim" role="status">
          <Clock className="h-3 w-3" aria-hidden="true" />
          <span>Showing data as of {formatGeneratedAt(state.generatedAt)}.</span>
        </p>
      )}
      {state.kind === 'partial' && (
        <p className="mb-3 text-xs text-bh-warning" role="status">
          Incomplete — {state.missing.join(', ')} could not be included. Totals exclude{' '}
          {state.missing.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      {children(state.data)}
    </>
  )
}
