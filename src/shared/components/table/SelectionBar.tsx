import type { ReactNode } from 'react'

import { Button } from '~/components/ui/button'

import type { TableSelectionResult } from './useTableSelection'

interface SelectionBarProps {
  selection: TableSelectionResult
  /** Rows matching the current query, from `PageResult.total`. `null` when it is unknowable. */
  total: number | null
  /** Bulk actions. They receive the predicate token when one exists, so they cannot silently narrow. */
  actions?: ReactNode
}

/**
 * What is selected, said out loud — floating over the last rows rather than pushed above the header.
 *
 * The bar exists because the header checkbox is a lie by omission at 50 rows a page: it selected
 * the loaded ones, and nothing on screen would otherwise say so. When more rows match than are
 * loaded, it offers the second, differently-worded action — and when the table did not implement
 * that action, it offers nothing rather than something that means less than it says.
 *
 * ## Why it floats, and why it floats *inside the table*
 *
 * The reference's point is that bulk actions belong in one place instead of repeating three buttons
 * in every row. It was previously an inline strip between the toolbar and the header, which pushed
 * every row down by 40px the moment you ticked a checkbox — the list moved under the cursor that
 * was selecting it.
 *
 * The dock is `position: sticky` with zero height, so it tracks the viewport while the table is on
 * screen and costs no layout. It is anchored to the table's own box rather than the viewport
 * because a page can hold two tables — `settings/team` renders members and invitations — and a
 * viewport-fixed bar could not say which one "3 selected" refers to.
 */
export function SelectionBar({ selection, total, actions }: SelectionBarProps) {
  const { loadedSelectedCount, matching, canSelectAllMatching, isRequestingMatching } = selection

  if (loadedSelectedCount === 0 && !matching) return null

  // An unknown total cannot establish that more rows match than are loaded, so the
  // "select all matching" affordance stays hidden. Offering it would promise a count the surface
  // has no way to produce — and `selectAllMatching` is itself a server predicate over a set the
  // federation never materialises.
  const moreMatchThanLoaded = total !== null && total > loadedSelectedCount

  return (
    <div className="tbl-selection-dock">
      <div
        className="tbl-selection-bar"
        data-testid="table-selection-bar"
        // Polite: the count changes as fast as the user clicks, and an assertive live region would
        // interrupt them on every checkbox.
        aria-live="polite"
      >
        <p className="tbl-selection-count" data-testid="table-selection-count">
          {matching
            ? `All ${matching.count.toLocaleString()} matching rows selected`
            : `${loadedSelectedCount.toLocaleString()} selected`}
        </p>

        {!matching && canSelectAllMatching && moreMatchThanLoaded && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void selection.requestSelectAllMatching() }}
            loading={isRequestingMatching}
            data-testid="table-select-all-matching"
          >
            Select all {total.toLocaleString()} matching
          </Button>
        )}

        {actions && <div className="flex items-center gap-2">{actions}</div>}

        <Button variant="ghost" size="sm" onClick={selection.clear} data-testid="table-clear-selection">
          Clear
        </Button>
      </div>
    </div>
  )
}
