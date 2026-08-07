/**
 * The data half of the table contract.
 *
 * Deliberately free of any renderer import and of every `src/` import: a repository, a route
 * handler and a component all speak these types, and only one of the three runs in a browser.
 * `columns.ts` is where the rendering half lives.
 */

/** What the user is asking to see, independent of which page of it they are on. */
export interface TableQuery {
  /** Free-text search. Empty string means no search, never "match nothing". */
  search: string
  /**
   * Selected values per filter dimension, keyed by column id.
   *
   * An empty array means "no filter on this dimension" — it is dropped, not treated as a filter
   * that matches nothing. That distinction is the difference between an empty table and a full
   * one when a user clears the last checkbox.
   */
  filters: Record<string, string[]>
  /**
   * Sort terms in priority order. Plan 03 appends a tiebreaker column to whatever is here, because
   * a page boundary landing inside a tie duplicates or drops rows.
   */
  sort: Array<{ id: string; dir: 'asc' | 'desc' }>
  /** Column id to group by, or null. */
  groupBy: string | null
}

/** Which page of that query to return. */
export interface PageRequest {
  /** `null` means page one; the sort then comes from the table capability's default. */
  cursor: string | null
  /** The server clamps this to `TABLE_PAGE_SIZE`; a larger client value is ignored, not honoured. */
  limit: number
}

/** What came back. */
export interface PageResult<Row> {
  rows: Row[]
  /** `null` when this is the last page. */
  nextCursor: string | null
  /**
   * Exact count of the filtered set, not of this page — it drives `aria-rowcount` and the
   * "50 of 214" label, both of which lie if they count only what was fetched.
   */
  total: number
  /** Available filter values and their counts, per filter dimension. */
  facets: Record<string, Array<{ value: string; count: number }>>
}

/** A route's parsed `?…` — the shape `tableSearchSchema` produces. */
export interface TableSearch {
  query: TableQuery
  page: PageRequest
  /** Which renderer the surface should use (`table`, `cards`, …); surfaces define their own set. */
  renderer: string
}
