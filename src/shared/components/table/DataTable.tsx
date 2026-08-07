import {
  columnVisibilityFeature,
  createColumnHelper,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import * as React from 'react'

import { Checkbox } from '~/components/ui/checkbox'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery } from '~/shared/lib/table/types'
import { cn } from '~/shared/lib/utils'

import { GridRow } from './GridRow'
import { SelectionBar } from './SelectionBar'
import { TableCommandSheet } from './TableCommandSheet'
import { TableToolbar } from './TableToolbar'
import {
  ariaColIndex,
  ariaRowCount,
  cellAlignmentClass,
  gridTemplateColumns,
  HEADER_ROW_INDEX,
} from './grid-roles'
import { BoardRenderer } from './renderers/BoardRenderer'
import { GroupedRenderer } from './renderers/GroupedRenderer'
import { StackedRenderer } from './renderers/StackedRenderer'
import { TableRenderer } from './renderers/TableRenderer'
import type { RendererContext, TableRendererId } from './renderers/types'
import { BlankState } from './states/BlankState'
import { ErrorRow } from './states/ErrorRow'
import { FilteredEmptyState } from './states/FilteredEmptyState'
import { SkeletonRows } from './states/SkeletonRows'
import { useTableKeyboard, type TableNavigationMode } from './useTableKeyboard'
import { useTableSelection, type SelectAllMatching } from './useTableSelection'

/**
 * One table, for all nineteen of them.
 *
 * ## Why a div tree and not a `<table>`
 *
 * `role="grid"` over divs, with CSS grid doing the alignment a table would have done. The reason is
 * plan 06: virtualized rows inside a `<tbody>` need spacer rows and `translateY`, which fight
 * sticky group headers and column alignment. Building the layout twice would cost more than owning
 * the ARIA indices — but owning them is a real obligation, so the arithmetic lives in
 * `grid-roles.ts` with its own tests and `pnpm test:a11y` runs axe over the result.
 *
 * ## What it does not do
 *
 * It renders a `PageResult` it is handed. It does not fetch, and it never sorts, filters or groups
 * the rows it was given — the server did that. A shell that re-sorted its 50 loaded rows would be
 * showing "sorted by score" over 50 of 214, which is the precise wrongness this phase removes.
 */

export interface DataTableProps<Row extends Record<string, unknown>> {
  /** Accessible name for the grid. Required: an unnamed grid is a grid a screen reader cannot find. */
  label: string
  columns: ColumnDef<Row>[]
  page: PageResult<Row>
  query: TableQuery
  onQueryChange: (next: TableQuery) => void

  /**
   * Required, and forwarded to each row as `data-testid`.
   *
   * `tests/regression/test-status-and-trust.mjs` and several e2e specs drive rows by id. A shell
   * that generated its own would turn a green suite red for reasons that have nothing to do with
   * tables, so the ids stay the surface's to choose.
   */
  rowTestId: (row: Row) => string
  /** Stable identity for selection. Defaults to `rowTestId`. */
  rowId?: (row: Row) => string

  renderer?: TableRendererId
  navigation?: TableNavigationMode
  status?: 'ready' | 'loading' | 'error'
  error?: { message: string; onRetry?: () => void }

  /** Absolute index of the first loaded row, when the surface pages rather than accumulates. */
  rowOffset?: number
  onPrimaryAction?: (row: Row) => void
  onLoadMore?: () => void

  selectable?: boolean
  onSelectionChange?: (ids: string[]) => void
  selectAllMatching?: SelectAllMatching
  bulkActions?: React.ReactNode

  /** Per-table extra row content — an inline edit form, for instance. The shell knows nothing about it. */
  expansion?: (row: Row) => React.ReactNode
  /** Shown when the unfiltered set is empty. */
  emptyState?: React.ReactNode
  /** Human labels for filter ids, used by the chips, the command sheet and the filtered-empty copy. */
  filterLabels?: Record<string, string>
  className?: string
}

const RENDERERS = {
  table: TableRenderer,
  grouped: GroupedRenderer,
  board: BoardRenderer,
  stacked: StackedRenderer,
} as const

/**
 * The only TanStack Table features this shell registers.
 *
 * v9 makes features opt-in, and the honest list here is short: the server already sorted, filtered,
 * grouped and paginated, so registering `rowSortingFeature` or `rowPaginationFeature` would add
 * state slices for behaviour nothing may perform. Column visibility is genuine client state — it is
 * a property of this viewer's screen, not of the query — so the library owns it.
 *
 * Selection is deliberately *not* `rowSelectionFeature`. See `useTableSelection.ts`: at 50 rows a
 * page the meaningful selection is sometimes a predicate over 3,204 rows that were never loaded,
 * and a row-id map cannot represent that. Two selection models would be one too many.
 */
const tableShellFeatures = tableFeatures({ columnVisibilityFeature })

export function DataTable<Row extends Record<string, unknown>>(props: DataTableProps<Row>) {
  const {
    label,
    columns,
    page,
    query,
    onQueryChange,
    rowTestId,
    rowId = rowTestId,
    renderer = 'table',
    navigation = 'cell',
    status = 'ready',
    error,
    rowOffset = 0,
    onPrimaryAction,
    onLoadMore,
    selectable = false,
    onSelectionChange,
    selectAllMatching,
    bulkActions,
    expansion,
    emptyState,
    filterLabels,
    className,
  } = props

  const [commandOpen, setCommandOpen] = React.useState(false)
  const searchRef = React.useRef<HTMLInputElement>(null)

  const rows = page.rows

  // The column model lives in TanStack Table so column visibility is real, subscribable state
  // rather than a `Set` in this component. They are `display` columns: the cell contract is plan
  // 02's `ColumnDef.cell(row)`, which takes the row rather than a cell context, so there is no
  // accessor for the library to own — and inventing one would give the shell two ideas about how a
  // cell renders.
  const helper = React.useMemo(() => createColumnHelper<typeof tableShellFeatures, Row>(), [])
  const tableColumns = React.useMemo(
    () => helper.columns(columns.map((column) => helper.display({ id: column.id, header: column.header }))),
    [helper, columns],
  )
  const table = useTable({
    features: tableShellFeatures,
    columns: tableColumns,
    data: rows,
    getRowId: (row: Row) => rowId(row),
  }, (state) => ({ columnVisibility: state.columnVisibility }))

  const byId = React.useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns])
  // Not memoised on purpose. What changes the answer is `table.state.columnVisibility`, which the
  // exhaustive-deps rule cannot see behind `getVisibleFlatColumns()` — so a dependency array here
  // is either wrong or lint-suppressed, and a stale column list is a worse bug than mapping twenty
  // columns on a render.
  const visibleColumns = table.getVisibleFlatColumns()
    .map((column) => byId.get(column.id))
    .filter((column): column is ColumnDef<Row> => column !== undefined)
  const hiddenColumns = React.useMemo(
    () => new Set(Object.entries(table.state.columnVisibility ?? {})
      .filter(([, visible]) => visible === false)
      .map(([id]) => id)),
    [table.state.columnVisibility],
  )
  const rowIds = React.useMemo(() => rows.map(rowId), [rows, rowId])

  const selection = useTableSelection({ rowIds, query, onChange: onSelectionChange, selectAllMatching })

  const keyboard = useTableKeyboard({
    rowCount: rows.length,
    columnCount: visibleColumns.length,
    navigation,
    onPrimaryAction: onPrimaryAction ? (index) => { const row = rows[index]; if (row) onPrimaryAction(row) } : undefined,
    onToggleSelect: selectable ? (index) => { const id = rowIds[index]; if (id) selection.toggle(id) } : undefined,
    onExtendSelection: selectable ? selection.extend : undefined,
    onClearSelection: selectable ? selection.clear : undefined,
    onFocusSearch: () => searchRef.current?.focus(),
    onOpenCommandSheet: () => setCommandOpen(true),
    onReachEnd: onLoadMore,
  })

  const context: RendererContext<Row> = {
    columns: visibleColumns,
    page,
    query,
    rows,
    rowId,
    rowTestId,
    rowOffset,
    selectable,
    selection,
    keyboard,
    onPrimaryAction,
    expansion,
  }

  function toggleSort(column: ColumnDef<Row>) {
    if (!column.sortable) return
    const current = query.sort.find((term) => term.id === column.id)
    // Third click clears rather than cycling back to ascending: "no sort" is a state the URL can
    // express, and hiding it behind two more clicks makes the default order unreachable.
    const next: TableQuery['sort'] = current === undefined
      ? [{ id: column.id, dir: 'asc' }]
      : current.dir === 'asc'
        ? [{ id: column.id, dir: 'desc' }]
        : []
    onQueryChange({ ...query, sort: next })
  }

  const Renderer = RENDERERS[renderer] as (props: { context: RendererContext<Row> }) => React.ReactNode
  const isLoading = status === 'loading'
  const hasFilters = query.search.trim() !== '' || Object.values(query.filters).some((values) => values.length > 0)
  const showBlank = !isLoading && rows.length === 0 && !hasFilters
  const showFilteredEmpty = !isLoading && rows.length === 0 && hasFilters
  // A board arranges its own cards; the shared grid template would fight it.
  const usesGridTemplate = renderer === 'table' || renderer === 'grouped'

  return (
    <div className={cn('card overflow-hidden p-0', className)}>
      <TableToolbar
        columns={columns}
        query={query}
        onQueryChange={onQueryChange}
        facets={page.facets}
        labels={filterLabels}
        hiddenColumns={hiddenColumns}
        onToggleColumn={(id) => table.getColumn(id)?.toggleVisibility()}
        onOpenCommandSheet={() => setCommandOpen(true)}
        searchRef={searchRef}
      />

      {selectable && <SelectionBar selection={selection} total={page.total} actions={bulkActions} />}

      <div
        role="grid"
        aria-label={label}
        // From `PageResult.total`, never `rows.length` — the point is that a screen-reader user
        // learns the list is partial without scrolling to the bottom to find out. `+1` covers the
        // header row, which carries `aria-rowindex={1}`.
        aria-rowcount={ariaRowCount(page.total)}
        aria-colcount={visibleColumns.length + (selectable ? 1 : 0) + (expansion ? 1 : 0)}
        aria-busy={isLoading || undefined}
        onKeyDown={keyboard.onKeyDown}
        className="table-scroll"
        data-testid="data-table"
      >
        <div
          role="row"
          aria-rowindex={HEADER_ROW_INDEX}
          className={cn(
            'sticky top-0 z-20 border-b border-bh-border bg-bh-surface px-4 py-2.5',
            usesGridTemplate ? 'grid items-center gap-3' : 'flex items-center gap-3',
          )}
          style={usesGridTemplate
            ? { gridTemplateColumns: gridTemplateColumns(visibleColumns, { selectable, expandable: Boolean(expansion) }) }
            : undefined}
        >
          {selectable && (
            <div role="columnheader" aria-colindex={ariaColIndex(0)} className="flex items-center">
              <Checkbox
                checked={selection.headerState === 'indeterminate' ? 'indeterminate' : selection.headerState}
                onCheckedChange={selection.toggleLoaded}
                // Deliberately not "Select all": at 50 rows a page it selects the loaded ones, and
                // the label says so. "Select all N matching" is a separate control in SelectionBar.
                aria-label="Select loaded rows"
                data-testid="table-select-loaded"
              />
            </div>
          )}
          {visibleColumns.map((column, columnIndex) => {
            const term = query.sort.find((entry) => entry.id === column.id)
            const SortIcon = term === undefined ? ChevronsUpDown : term.dir === 'asc' ? ArrowUp : ArrowDown
            return (
              <div
                key={column.id}
                role="columnheader"
                aria-colindex={ariaColIndex(columnIndex + (selectable ? 1 : 0))}
                aria-sort={column.sortable ? (term ? (term.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                className={cn('flex min-w-0 items-center text-xs font-semibold uppercase tracking-wide text-bh-text-muted', cellAlignmentClass(column))}
              >
                {column.sortable
                  ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column)}
                      data-testid={`table-sort-${column.id}`}
                      className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:text-bh-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
                    >
                      <span className="truncate">{column.header}</span>
                      <SortIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                    </button>
                    )
                  : <span className="truncate px-1">{column.header}</span>}
              </div>
            )
          })}
          {expansion && <div role="columnheader" aria-colindex={ariaColIndex(visibleColumns.length + (selectable ? 1 : 0))}><span className="sr-only">Expand</span></div>}
        </div>

        {isLoading && rows.length === 0 && <SkeletonRows columns={visibleColumns} selectable={selectable} />}
        {showBlank && (emptyState ?? <BlankState />)}
        {showFilteredEmpty && (
          <FilteredEmptyState
            query={query}
            labels={filterLabels}
            onClear={() => onQueryChange({ ...query, search: '', filters: {} })}
          />
        )}
        {rows.length > 0 && <Renderer context={context} />}
        {status === 'error' && error && <ErrorRow message={error.message} onRetry={error.onRetry} />}
      </div>

      <TableCommandSheet
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        columns={columns}
        query={query}
        onQueryChange={onQueryChange}
        facets={page.facets}
        labels={filterLabels}
      />
    </div>
  )
}

/** Re-exported so a surface can render a single row outside the shell (a detail preview, say). */
export { GridRow }
