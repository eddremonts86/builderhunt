/**
 * The table shell's public surface.
 *
 * Two primitives and one cell vocabulary. `DataTable` for collections you operate, `SemanticTable`
 * for bounded tables you read, and the eight cell presentations both draw from — a surface that
 * imports these cannot invent a tenth date format or a fifth status chip, which is the entire point
 * of the visual contract.
 *
 * Everything else is internal to the shell and is imported directly by the files that make it up,
 * so the shape of the shell stays changeable without a migration.
 */

export { DataTable, type DataTableProps } from './DataTable'
export { SemanticTable, type SemanticColumn } from './SemanticTable'
export {
  ActionsCell,
  DateCell,
  EmptyCell,
  IdentityCell,
  NumberCell,
  PrimaryCell,
  RatioCell,
  StatusCell,
  type StatusTone,
} from './cells'
export { ROW_HEIGHT, SEARCH_CARD_ROW_HEIGHT, type TableDensity } from './useTableVirtual'
export { BlankState } from './states/BlankState'
export { type TableRendererId } from './renderers/types'
export { type TableNavigationMode } from './useTableKeyboard'
export { type MatchingSelection, type SelectAllMatching } from './useTableSelection'
