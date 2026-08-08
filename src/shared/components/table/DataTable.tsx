// table-surface-ok: the shell itself. Its <table> is the sr-only header the grid needs; every surface that renders it carries its own marker.
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
import { buildTableEntries } from './entries'
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
import { ROW_HEIGHT, useTableVirtual, type TableDensity } from './useTableVirtual'

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
  /**
   * Which row is expanded, when the surface wants to own it.
   *
   * Pass both this and `onExpandedChange` and the shell stops keeping its own flag. Needed when
   * opening a row means something to the surface — on `admin/incidents`, expanding a row *is*
   * "edit this incident", and the page has to load it into its form.
   *
   * It is compared against **`rowId`**, which defaults to `rowTestId`. A surface whose test ids are
   * prefixed must pass `rowId` too, or it will hold a raw id while the shell looks for a prefixed
   * one and no row will ever open.
   */
  expandedRowId?: string | null
  onExpandedChange?: (rowId: string | null) => void
  /**
   * Whether the toolbar offers a search box. Defaults to true.
   *
   * Pass `false` when the capability declares no `searchable` columns — the box would accept text
   * and match nothing, which reads as "not found" rather than "not searchable". The team roster is
   * the case: names live on `auth_users`, and a capability describes one table.
   */
  searchable?: boolean
  /**
   * Turns a stored dimension value into something a person can read.
   *
   * Needed when a dimension's values are ids. They have to *stay* ids everywhere the server is
   * involved — the facet is computed over the real column, and two radars may share a name — so the
   * translation happens at the edge, once, and applies to the group header, the facet chips, the
   * command sheet and the filtered-empty copy alike. Anything less would leave `p3-alert-1` on a
   * chip beside a group header reading "Local-first devs".
   */
  valueLabel?: (dimension: string, value: string) => string
  /** Shown when the unfiltered set is empty. */
  emptyState?: React.ReactNode
  /** Human labels for filter ids, used by the chips, the command sheet and the filtered-empty copy. */
  filterLabels?: Record<string, string>
  className?: string

  /** Row height. The table's own concept, not the dashboard's bento/sections preference. */
  density?: TableDensity
  /**
   * Row height in pixels, overriding `density`.
   *
   * The virtualizer measures nothing — `useTableVirtual` says so, and variable heights are
   * deliberately outside plan 06 — so a surface whose row is a card rather than a line of text has
   * to declare how tall that row is. Search is the case: its row *is* a result card.
   *
   * A surface that sets this owes its cell a matching fixed height. Otherwise rows render at their
   * natural height below `VIRTUALIZATION_THRESHOLD` and snap to this one above it, which reads as
   * the list jumping at the hundredth row.
   */
  rowHeight?: number
  /**
   * Render only the visible window.
   *
   * On by default above `VIRTUALIZATION_THRESHOLD` loaded rows. A surface can force it off — the
   * board renderer does, because its lanes scroll horizontally and are individually short.
   */
  virtualize?: boolean
  /** Height of the scroll viewport. Virtualization needs a bounded container to window against. */
  maxHeight?: number | string
  /**
   * How much of the shell's own furniture to show.
   *
   * `full` is every table in the app: a toolbar with search, facet chips, grouping and column
   * visibility, above a visible header row.
   *
   * `minimal` is for a grid whose row *is* a card — search results. There, one column called
   * "Result" makes a column-visibility menu meaningless and a header reading "RESULT" above a list
   * of people reads as a mistake. The header row is hidden visually and **kept in the accessibility
   * tree**: a `role="grid"` with no `role="row"` at `aria-rowindex=1` would make `aria-rowcount`
   * describe a sequence that does not exist.
   */
  chrome?: 'full' | 'minimal'
}

/**
 * Below this many loaded rows, windowing costs more than it saves.
 *
 * An absolutely-positioned canvas and a scroll subscription for thirty rows is machinery in
 * exchange for nothing, and it makes the DOM harder to read in the browser inspector for every
 * small table in the app.
 */
export const VIRTUALIZATION_THRESHOLD = 100

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
    expandedRowId,
    onExpandedChange,
    searchable = true,
    valueLabel,
    emptyState,
    filterLabels,
    className,
    density = 'comfortable',
    rowHeight = ROW_HEIGHT[density],
    virtualize,
    maxHeight,
    chrome = 'full',
  } = props

  const [commandOpen, setCommandOpen] = React.useState(false)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)

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

  const entries = React.useMemo(
    () => buildTableEntries({
      rows,
      columns: visibleColumns,
      query,
      facets: page.facets,
      rowId,
      grouped: renderer === 'grouped',
    }),
    [rows, visibleColumns, query, page.facets, rowId, renderer],
  )

  // The board arranges its own lanes and is excluded below; it never reaches the virtualizer.
  const virtualized = (virtualize ?? entries.length > VIRTUALIZATION_THRESHOLD) && renderer !== 'board'

  // The focused row is a row index; the virtualizer measures entries, and a group header shifts the
  // two apart. Translating here is what makes the focus pin land on the right entry.
  const focusedEntryIndex = entries.findIndex(
    (entry) => entry.kind === 'row' && entry.index === keyboard.position.row,
  )

  const virtual = useTableVirtual({
    count: entries.length,
    scrollRef,
    rowHeight,
    focusedIndex: focusedEntryIndex,
    enabled: virtualized,
  })

  /**
   * Ask for the next page when the *container's* scroll nears its end.
   *
   * Only meaningful once virtualization is on, and that is exactly when it is needed: below the
   * threshold the grid sits in page flow and a surface's own bottom-of-page sentinel sees the
   * viewport scroll, but a windowed grid becomes its own `overflow-y: auto` box and the page barely
   * moves — so that sentinel is either permanently visible (asking for every remaining page at
   * once) or never visible (infinite scroll silently stopping at the hundredth row). Neither is
   * something a surface can fix from outside the container.
   *
   * Firing repeatedly is the caller's to absorb: every `onLoadMore` here already refuses to run
   * while a page is in flight or when there is no cursor left.
   */
  const handleScroll = React.useCallback(() => {
    if (!onLoadMore) return
    const element = scrollRef.current
    if (!element) return
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
    // One viewport of slack, so the next page is requested before the user hits the floor.
    if (remaining <= element.clientHeight) onLoadMore()
  }, [onLoadMore])

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
    expandedRowId,
    onExpandedChange,
    entries,
    valueLabel,
    window: virtual.items,
    totalSize: virtual.totalSize,
    virtualized,
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
      {chrome === 'full' && <TableToolbar
        columns={columns}
        query={query}
        onQueryChange={onQueryChange}
        facets={page.facets}
        labels={filterLabels}
        hiddenColumns={hiddenColumns}
        onToggleColumn={(id) => table.getColumn(id)?.toggleVisibility()}
        onOpenCommandSheet={() => setCommandOpen(true)}
        searchRef={searchRef}
        searchable={searchable}
        valueLabel={valueLabel}
      />}

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
        ref={scrollRef}
        onScroll={virtualized ? handleScroll : undefined}
        className="table-scroll"
        // Virtualization needs a bounded viewport to window against; an unbounded container is
        // always "fully visible" and every row stays mounted.
        style={virtualized ? { maxHeight: maxHeight ?? '70vh', overflowY: 'auto' } : undefined}
        data-testid="data-table"
        data-virtualized={virtualized ? 'true' : undefined}
      >
        <div
          role="row"
          aria-rowindex={HEADER_ROW_INDEX}
          className={cn(
            'sticky top-0 z-20 border-b border-bh-border bg-bh-surface px-4 py-2.5',
            usesGridTemplate ? 'grid items-center gap-3' : 'flex items-center gap-3',
            // Hidden from sight, not from a screen reader: `aria-rowcount` counts this row.
            chrome === 'minimal' && 'sr-only',
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
            valueLabel={valueLabel}
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
        valueLabel={valueLabel}
      />
    </div>
  )
}

/** Re-exported so a surface can render a single row outside the shell (a detail preview, say). */
export { GridRow }
