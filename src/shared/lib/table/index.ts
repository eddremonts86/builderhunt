/**
 * The table contract's client-safe surface.
 *
 * Everything a component, a route or a repository needs to describe a table, put its state in a
 * URL and read a page back.
 *
 * **`cursor.ts` is not re-exported here, and that is deliberate.** Plan 02's checklist asks for it,
 * but it imports `node:crypto`, and this module is what the shell (plan 05) will import. The repo
 * has already paid for that mistake once in a different form: on 2026-07-28 a single exported
 * route symbol that referenced the server layer dragged the `postgres` driver into the client
 * bundle, and type-check, lint, 4236 unit tests and a production build all passed while every page
 * was dead (see `scripts/check-route-client-boundary.mjs`). Re-exporting the cursor helpers here
 * would put one `import { TABLE_PAGE_SIZE } from '~/shared/lib/table'` between us and the same
 * failure — with the same absence of a signal.
 *
 * Only the server mints and verifies cursors; a client holds one as an opaque string. Server code
 * imports `~/shared/lib/table/cursor` directly, and the cursor's *types* are re-exported below so
 * a shared signature can still name them without pulling the implementation.
 */

export { TABLE_PAGE_SIZE } from './constants'
export type { ColumnDef } from './columns'
export type { CursorExpectation, CursorValue, TableCursorPayload } from './cursor'
export {
  emptyTableSearch,
  serializeTableSearch,
  tableSearchSchema,
  tableSearchToParams,
} from './query-url'
export type { PageRequest, PageResult, TableQuery, TableSearch } from './types'
