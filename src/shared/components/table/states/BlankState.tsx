import { Inbox } from 'lucide-react'
import type { ReactNode } from 'react'

interface BlankStateProps {
  title?: string
  /** How data arrives here. A blank table that does not say is a dead end. */
  description?: ReactNode
  action?: ReactNode
}

/**
 * "There is genuinely nothing here yet."
 *
 * Distinct from `FilteredEmptyState` on purpose — see that file. This one's job is to explain how
 * rows get created, because for a first-run user an empty table is indistinguishable from a broken
 * one.
 */
export function BlankState({ title = 'Nothing here yet', description, action }: BlankStateProps) {
  return (
    <div className="px-4 py-12 text-center" data-testid="table-blank">
      <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-xl border border-bh-border bg-bh-surface-2">
        <Inbox className="h-6 w-6 text-bh-text-muted" aria-hidden="true" />
      </div>
      <p className="mb-1 font-semibold text-bh-text">{title}</p>
      {description && <div className="mx-auto mb-4 max-w-md text-sm text-bh-text-muted">{description}</div>}
      {action}
    </div>
  )
}
