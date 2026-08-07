/**
 * The table shell's public surface.
 *
 * A surface needs `DataTable`, the renderer id type, and — for the states it composes itself — the
 * blank state. Everything else is internal to the shell and is imported directly by the files that
 * make it up, so the shape of the shell stays changeable without a migration.
 */

export { DataTable, type DataTableProps } from './DataTable'
export { BlankState } from './states/BlankState'
export { type TableRendererId } from './renderers/types'
export { type TableNavigationMode } from './useTableKeyboard'
export { type MatchingSelection, type SelectAllMatching } from './useTableSelection'
