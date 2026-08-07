import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery } from '~/shared/lib/table/types'

import type { TableEntry } from '../entries'
import type { TableKeyboardResult } from '../useTableKeyboard'
import type { TableSelectionResult } from '../useTableSelection'
import type { VirtualWindowItem } from '../useTableVirtual'

/** Which presentation `?as=` selected. One model, four of these. */
export type TableRendererId = 'table' | 'grouped' | 'board' | 'stacked'

/**
 * Everything a renderer is given, and the complete list of what it may do.
 *
 * A renderer arranges rows. It does not filter, sort or group them — the server did that, and a
 * renderer that re-did any of it would be sorting the loaded 50 of 214 and calling the result
 * "sorted by score", which is the specific wrongness this phase exists to remove.
 */
export interface RendererContext<Row> {
  columns: ColumnDef<Row>[]
  page: PageResult<Row>
  query: TableQuery
  rows: Row[]
  rowId: (row: Row) => string
  rowTestId: (row: Row) => string
  /** Absolute index of the first loaded row, for `aria-rowindex`. */
  rowOffset: number
  selectable: boolean
  selection: TableSelectionResult
  keyboard: TableKeyboardResult
  onPrimaryAction?: (row: Row) => void
  expansion?: (row: Row) => React.ReactNode

  /**
   * The flat list of rows and group headers, and the slice of it that is mounted.
   *
   * `entries` is the whole loaded set; `window` names which indices into it are rendered. When
   * virtualization is off the window covers every entry, so a renderer never needs two code paths.
   */
  entries: TableEntry<Row>[]
  window: VirtualWindowItem[]
  /** Height of the scrolling content, so the scrollbar reflects the full list. */
  totalSize: number
  virtualized: boolean
}
