import { Columns3, Search } from 'lucide-react'
import * as React from 'react'

import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery } from '~/shared/lib/table/types'

export interface TableToolbarProps<Row> {
  columns: ColumnDef<Row>[]
  query: TableQuery
  onQueryChange: (next: TableQuery) => void
  facets: PageResult<Row>['facets']
  /** Human labels for filter ids. */
  labels?: Record<string, string>
  hiddenColumns: ReadonlySet<string>
  onToggleColumn: (id: string) => void
  onOpenCommandSheet?: () => void
  searchRef?: React.Ref<HTMLInputElement>
  /**
   * Whether this table has anything to search.
   *
   * Defaults to true, because almost every capability declares `searchable` columns. The roster
   * does not and cannot: the name and email a person would type live on `auth_users`, one join
   * away from a capability that describes one table. A box that silently matches nothing is worse
   * than no box — it reads as "no such member" for a member who is right there on page two.
   */
  searchable?: boolean
  /** Turns a stored dimension value into a readable one — a chip should not read `p3-alert-1`. */
  valueLabel?: (dimension: string, value: string) => string
}

/**
 * Search, facet chips, grouping and column visibility.
 *
 * The chips carry counts straight from `PageResult.facets`, which the server computed with the
 * *other* dimensions applied and this one's not — so a chip says how many rows it would add, not
 * zero. Deriving the counts here from loaded rows instead would produce numbers that are wrong at
 * exactly one moment: when there is more than one page, which is always.
 */
export function TableToolbar<Row>(props: TableToolbarProps<Row>) {
  const { columns, query, onQueryChange, facets, labels = {}, hiddenColumns, onToggleColumn, onOpenCommandSheet, searchRef, searchable = true, valueLabel } = props
  const [columnsOpen, setColumnsOpen] = React.useState(false)

  const groupable = columns.filter((column) => column.groupable)

  function toggleFilterValue(id: string, value: string) {
    const current = query.filters[id] ?? []
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value]
    const filters = { ...query.filters }
    // An empty array is the absence of a filter, not a filter matching nothing — same rule the URL
    // codec enforces, applied here so the two never disagree.
    if (next.length === 0) delete filters[id]
    else filters[id] = next
    onQueryChange({ ...query, filters })
  }

  return (
    <div className="tbl-toolbar" data-testid="table-toolbar">
      {searchable
        ? (
          <div className="relative min-w-[12rem] flex-1">
            <Search className="tbl-toolbar-search-icon" aria-hidden="true" />
            <Input
              ref={searchRef}
              type="search"
              value={query.search}
              onChange={(event) => onQueryChange({ ...query, search: event.target.value })}
              placeholder="Search…"
              aria-label="Search rows"
              className="pl-9"
              data-testid="table-search"
            />
          </div>
          )
        // Still claims the row, so the chips and the column menu sit where they do on every other
        // table rather than sliding left on this one alone.
        : <div className="min-w-[12rem] flex-1" />}

      {Object.entries(facets).map(([id, values]) => (
        <div key={id} className="flex flex-wrap items-center gap-1" role="group" aria-label={labels[id] ?? id}>
          {values.map((facet) => {
            const active = (query.filters[id] ?? []).includes(facet.value)
            return (
              <button
                key={facet.value}
                type="button"
                aria-pressed={active}
                onClick={() => toggleFilterValue(id, facet.value)}
                data-testid={`table-facet-${id}-${facet.value}`}
                className="tbl-facet-chip"
                data-active={active ? 'true' : undefined}
              >
                <span className="truncate">{valueLabel?.(id, facet.value) ?? facet.value}</span>
                <span className="tbl-facet-count">{facet.count.toLocaleString()}</span>
              </button>
            )
          })}
        </div>
      ))}

      {groupable.length > 0 && (
        <label className="tbl-toolbar-group-label">
          <span>Group</span>
          <select
            value={query.groupBy ?? ''}
            onChange={(event) => onQueryChange({ ...query, groupBy: event.target.value === '' ? null : event.target.value })}
            data-testid="table-group-select"
            className="tbl-toolbar-select"
          >
            <option value="">None</option>
            {groupable.map((column) => (
              <option key={column.id} value={column.id}>{column.header}</option>
            ))}
          </select>
        </label>
      )}

      <div className="relative">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setColumnsOpen((open) => !open)}
          aria-expanded={columnsOpen}
          data-testid="table-columns-toggle"
        >
          <Columns3 className="h-4 w-4" aria-hidden="true" />
          Columns
        </Button>
        {columnsOpen && (
          <div
            className="tbl-column-menu"
            role="group"
            aria-label="Column visibility"
          >
            {columns.map((column) => (
              <label key={column.id} className="tbl-column-menu-item">
                <input
                  type="checkbox"
                  checked={!hiddenColumns.has(column.id)}
                  onChange={() => onToggleColumn(column.id)}
                  data-testid={`table-column-${column.id}`}
                />
                <span className="truncate">{column.header}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {onOpenCommandSheet && (
        <Button variant="ghost" size="sm" onClick={onOpenCommandSheet} data-testid="table-command-open">
          <kbd className="kbd">⌘K</kbd>
        </Button>
      )}
    </div>
  )
}
