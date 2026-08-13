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
    <div className="tbl-state" data-testid="table-blank">
      <div className="tbl-state-icon">
        <Inbox className="h-6 w-6" aria-hidden="true" />
      </div>
      <p className="tbl-state-title">{title}</p>
      {description && <div className="tbl-state-description">{description}</div>}
      {action}
    </div>
  )
}
