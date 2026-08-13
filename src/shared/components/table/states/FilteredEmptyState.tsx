import { FilterX } from 'lucide-react'

import { Button } from '~/components/ui/button'
import type { TableQuery } from '~/shared/lib/table/types'

interface FilteredEmptyStateProps {
  query: TableQuery
  onClear: () => void
  /** Human labels for filter ids, so the message says "Source" rather than "source". */
  labels?: Record<string, string>
  /** And for the values themselves, when they are ids rather than words. */
  valueLabel?: (dimension: string, value: string) => string
}

/**
 * "Your filters excluded everything" — a *different* state from "there is nothing here".
 *
 * Most tables show one message for both, and it reads as "this feature has no data" when the truth
 * is "you have a chip selected". The user then leaves, or worse, files a bug. So this one names the
 * filters that are active and offers the single action that fixes it.
 */
export function FilteredEmptyState({ query, onClear, labels = {}, valueLabel }: FilteredEmptyStateProps) {
  const active: string[] = []
  if (query.search.trim() !== '') active.push(`search "${query.search.trim()}"`)
  for (const [id, values] of Object.entries(query.filters)) {
    if (values.length === 0) continue
    active.push(`${labels[id] ?? id}: ${values.map((value) => valueLabel?.(id, value) ?? value).join(', ')}`)
  }

  return (
    <div className="tbl-state" data-testid="table-filtered-empty">
      <div className="tbl-state-icon">
        <FilterX className="h-6 w-6" aria-hidden="true" />
      </div>
      <p className="tbl-state-title">No rows match these filters</p>
      {active.length > 0 && (
        <p className="tbl-state-description">Active: {active.join(' · ')}</p>
      )}
      <Button variant="secondary" size="sm" onClick={onClear} data-testid="table-clear-filters">
        Clear filters
      </Button>
    </div>
  )
}
