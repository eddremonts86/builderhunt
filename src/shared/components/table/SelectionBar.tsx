import type { ReactNode } from 'react'

import { Button } from '~/components/ui/button'

import type { TableSelectionResult } from './useTableSelection'

interface SelectionBarProps {
  selection: TableSelectionResult
  /** Rows matching the current query, from `PageResult.total`. */
  total: number
  /** Bulk actions. They receive the predicate token when one exists, so they cannot silently narrow. */
  actions?: ReactNode
}

/**
 * What is selected, said out loud.
 *
 * The bar exists because the header checkbox is a lie by omission at 50 rows a page: it selected
 * the loaded ones, and nothing on screen would otherwise say so. When more rows match than are
 * loaded, it offers the second, differently-worded action — and when the table did not implement
 * that action, it offers nothing rather than something that means less than it says.
 */
export function SelectionBar({ selection, total, actions }: SelectionBarProps) {
  const { loadedSelectedCount, matching, canSelectAllMatching, isRequestingMatching } = selection

  if (loadedSelectedCount === 0 && !matching) return null

  const moreMatchThanLoaded = total > loadedSelectedCount

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-bh-border bg-bh-surface-2 px-4 py-2"
      data-testid="table-selection-bar"
      // Polite: the count changes as fast as the user clicks, and an assertive live region would
      // interrupt them on every checkbox.
      aria-live="polite"
    >
      <p className="text-sm text-bh-text" data-testid="table-selection-count">
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

      <Button variant="ghost" size="sm" onClick={selection.clear} data-testid="table-clear-selection">
        Clear
      </Button>

      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  )
}
