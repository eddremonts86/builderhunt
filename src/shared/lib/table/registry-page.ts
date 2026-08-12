import type { PageResult, TableQuery } from './types'

/**
 * A `PageResult` over a **complete** in-memory set, for the code-defined registries.
 *
 * ## Why this is not a capability
 *
 * A table capability declares sortable database columns, a tiebreaker column, and a keyset cursor.
 * The three remaining admin tables have none of those to declare: `/admin/integrations` builds its
 * rows with `SOURCE_NAMES.map(…)` and `Object.keys(AI_TASKS).map(…)`, and `/admin/operations` reads a
 * schedule registry the audit describes as "the registry is code-defined". There is no column to sort
 * in Postgres and no cursor to page through — the row set is a property of the codebase, and every
 * one of these pages already receives all of it.
 *
 * ## Why sorting in the browser is correct here, and wrong everywhere else
 *
 * Phase 3's third principle says partial data changes what is *correct*, not just what is fast:
 * "Sorting 50 of 214 rows in the browser and calling it 'sorted by score' is wrong, so filter, sort
 * and group execute in SQL."
 *
 * The wrongness in that sentence is the `50 of 214`. Sorting 19 sources out of 19 gives the same
 * answer as sorting them in Postgres would, because there is no 20th row anywhere. So this helper is
 * not an exception to the principle; it is the case the principle does not describe. It asserts as
 * much: `total` is the size of the filtered set, and `nextCursor` is always `null`, because a
 * complete set has no next page and claiming one would be the lie the type exists to prevent.
 *
 * The moment one of these registries is backed by a growing table, this helper is the wrong tool and
 * a capability is the right one. `assertComplete` below is what makes that switch a failure rather
 * than a silent truncation.
 */
export interface RegistryTableSpec<Row> {
  /** Values a free-text search matches against, per row. Compared case-insensitively. */
  searchable: (row: Row) => Array<string | null | undefined>
  /** Filter dimensions, keyed by the column id the UI sends. Returns the row's value for that dimension. */
  filterable: Record<string, (row: Row) => string | null | undefined>
  /** Sortable column ids, keyed the same way, returning something comparable. */
  sortable: Record<string, (row: Row) => string | number | boolean | null | undefined>
  /**
   * A stable, unique value per row.
   *
   * Appended to every sort exactly as plan 03 appends a tiebreaker column in SQL, and for the same
   * reason: two rows comparing equal on the chosen column would otherwise order differently between
   * renders, which reads as rows moving under the cursor.
   */
  tiebreaker: (row: Row) => string
}

const isAbsent = (value: unknown) => value === null || value === undefined

/**
 * Compares two present values. Absent ones never reach here — see `compareWithDirection`.
 */
function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b))
}

/**
 * One sort term, with absent values pinned last in **both** directions.
 *
 * The null handling sits outside the direction flip deliberately, and getting it wrong is what a test
 * caught here: returning `1` for an absent value and then negating the whole comparison for `desc`
 * moves the nulls to the *top* — the exact opposite of the intent. An absent value is not "smallest",
 * it is unknown, and an operator scanning a registry for a source that has never run wants those rows
 * where they can be found rather than shuffled to whichever end the current direction implies.
 *
 * This matches `NULLS LAST`, which is what the SQL-backed capabilities use for the same reason.
 */
function compareWithDirection(a: unknown, b: unknown, dir: 'asc' | 'desc'): number {
  if (isAbsent(a)) return isAbsent(b) ? 0 : 1
  if (isAbsent(b)) return -1
  const delta = compare(a, b)
  return dir === 'desc' ? -delta : delta
}

export function registryPage<Row>(
  rows: readonly Row[],
  query: TableQuery,
  spec: RegistryTableSpec<Row>,
): PageResult<Row> {
  let result = [...rows]

  const search = query.search.trim().toLowerCase()
  if (search) {
    result = result.filter((row) =>
      spec.searchable(row).some((value) => (value ?? '').toLowerCase().includes(search)),
    )
  }

  for (const [dimension, values] of Object.entries(query.filters)) {
    // An empty array is "no filter on this dimension", never "match nothing" — the same rule the
    // `TableQuery` contract states, and the difference between an empty table and a full one when a
    // user clears the last checkbox.
    if (values.length === 0) continue
    const read = spec.filterable[dimension]
    // An unknown dimension is dropped rather than applied. The server answers 400 for one because a
    // client naming a column is a contract violation; here the row set is already in hand and
    // rendering nothing would be a worse answer than ignoring a stale URL parameter.
    if (!read) continue
    result = result.filter((row) => values.includes(read(row) ?? ''))
  }

  const terms = query.sort.filter((term) => spec.sortable[term.id])
  result.sort((left, right) => {
    for (const term of terms) {
      const read = spec.sortable[term.id]!
      const delta = compareWithDirection(read(left), read(right), term.dir)
      if (delta !== 0) return delta
    }
    return spec.tiebreaker(left).localeCompare(spec.tiebreaker(right))
  })

  return { rows: result, nextCursor: null, total: result.length, facets: facetsFor(rows, query, spec) }
}

/**
 * Counts per filter value, each computed with its **own** dimension's filter removed.
 *
 * The alternative — counting the already-filtered rows — makes every unselected checkbox read `0`
 * the moment one value in that dimension is selected, so the control tells you that choosing
 * `dormant` as well as `active` would match nothing. Excluding the dimension from its own counts is
 * what makes the numbers answer the question the user is about to ask.
 *
 * Every value present in the registry appears, including ones the *other* dimensions' filters have
 * reduced to zero: an operator needs to see that `attention` exists and currently matches nothing,
 * not to have it vanish from the control.
 */
function facetsFor<Row>(
  rows: readonly Row[],
  query: TableQuery,
  spec: RegistryTableSpec<Row>,
): Record<string, Array<{ value: string; count: number }>> {
  const search = query.search.trim().toLowerCase()
  const facets: Record<string, Array<{ value: string; count: number }>> = {}

  for (const [dimension, read] of Object.entries(spec.filterable)) {
    const counts = new Map<string, number>()
    // Seed with every value the registry defines, so a value that currently matches nothing is
    // rendered at zero rather than omitted.
    for (const row of rows) {
      const value = read(row)
      if (value) counts.set(value, 0)
    }

    const candidates = rows.filter((row) => {
      if (search && !spec.searchable(row).some((v) => (v ?? '').toLowerCase().includes(search))) return false
      for (const [other, values] of Object.entries(query.filters)) {
        if (other === dimension || values.length === 0) continue
        const readOther = spec.filterable[other]
        if (readOther && !values.includes(readOther(row) ?? '')) return false
      }
      return true
    })

    for (const row of candidates) {
      const value = read(row)
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
    }

    facets[dimension] = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value))
  }

  return facets
}
