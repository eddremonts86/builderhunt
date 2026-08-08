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

/**
 * How far a page's boundaries can be trusted.
 *
 * `exact` is every SQL surface: a keyset page over a total order, so a row is served once and the
 * total counts the same set the rows came from.
 *
 * `provider-best-effort` is the federated search (plan 11). Its pages are numbered pages of
 * third-party APIs, and an upstream that reorders or renumbers between two requests shifts the set
 * underneath. Saying so is the point — the alternative was to keep the same field names and let a
 * caller assume the guarantee the SQL surfaces give.
 *
 * `approximate` is the local semantic leg, and it is a third thing rather than a synonym for the
 * second. Its pages *are* a keyset over a total order, so no row is ever served twice or stepped
 * over — but the candidate set comes from an HNSW index, which explores `ef_search` neighbours and
 * returns the best it found. A row can therefore be missed entirely. Folding that into
 * `provider-best-effort` would blame a third party for the index's own approximation, and folding
 * it into `exact` would promise recall nothing here can promise.
 */
export type PageConsistency = 'exact' | 'provider-best-effort' | 'approximate'

/** What came back. */
export interface PageResult<Row> {
  rows: Row[]
  /** `null` when this is the last page. */
  nextCursor: string | null
  /**
   * Exact count of the filtered set, not of this page — it drives `aria-rowcount` and the
   * "50 of 214" label, both of which lie if they count only what was fetched.
   *
   * `null` when the count is genuinely unknowable, which is the federated search's case: counting
   * would mean exhausting every upstream, and the endpoints do not offer a count to exhaust. A
   * fabricated number here would reach `aria-rowcount` and be read out to a screen-reader user as
   * fact, so the type carries the uncertainty rather than a sentinel like `0` or `-1` that every
   * consumer would have to remember the meaning of.
   */
  total: number | null
  /** Available filter values and their counts, per filter dimension. */
  facets: Record<string, Array<{ value: string; count: number }>>
  /** Defaults to `exact` when absent — every SQL surface, which is all of them but search. */
  consistency?: PageConsistency
}

/** A route's parsed `?…` — the shape `tableSearchSchema` produces. */
export interface TableSearch {
  query: TableQuery
  page: PageRequest
  /** Which renderer the surface should use (`table`, `cards`, …); surfaces define their own set. */
  renderer: string
}
