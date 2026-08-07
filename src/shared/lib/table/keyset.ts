import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import {
  capabilityTable,
  FACET_VALUE_LIMIT,
  isColumnRef,
  refSql,
  type SortTerm,
  type TableCapability,
} from './capability'
import { TABLE_PAGE_SIZE } from './constants'
import {
  createTableCursor,
  queryFingerprint,
  sortDescriptor,
  verifyTableCursor,
  type CursorValue,
} from './cursor'
import type { PageRequest, PageResult, TableQuery } from './types'

/**
 * The only place table filtering, sorting and grouping reach SQL.
 *
 * Three properties make this safe by construction rather than by review:
 *
 * 1. **No client string reaches a column reference.** Ids resolve through `TableCapability` and
 *    nowhere else; an id that is not in the allowlist throws before a query is built. Values are
 *    bound parameters, always.
 * 2. **Every sort is a total order.** The capability's tiebreaker is appended to every `ORDER BY`.
 *    Without it a 50-row page boundary landing inside a tie shows a row twice or not at all — a
 *    silently wrong list, which is worse than a slow one.
 * 3. **No `OFFSET`, ever.** It walks and discards every skipped row, and it shifts under
 *    concurrent writes, so a row inserted mid-paging is seen twice or missed.
 *
 * It must run inside `withTenantContext`. It checks, rather than assuming: a builder that fell
 * back to a global connection when the tenant setting was missing would be a cross-tenant read
 * with no error to notice.
 */

export class TableQueryError extends Error {
  readonly status = 400

  constructor(reason: string) {
    super(reason)
    this.name = 'TableQueryError'
  }
}

/** The sort term the tiebreaker occupies. Not a client-nameable id — `__` cannot pass `COLUMN_ID`. */
export const TIEBREAKER_ID = '__tiebreaker__'

/**
 * A Drizzle transaction or database handle.
 *
 * `any` for the same reason `access-requests.ts:337` uses it: `TenantTransaction`,
 * `PostgresJsDatabase` and a disposable test database all satisfy this structurally, and their
 * generic select-chain types do not unify into anything a caller can chain off. The safety here
 * comes from the capability allowlist, not from this signature.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type KeysetTransaction = {
  select: (fields?: any) => any
  execute: (query: SQL) => Promise<any>
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface KeysetPageOptions<Row> {
  /**
   * Predicates the **surface** owns, rather than ones the client-facing allowlist resolves.
   *
   * `eq(sprintResults.sprintId, id)` is the obvious kind. The less obvious kind is a filter that
   * the shared `TableQuery` deliberately cannot express — sprint results has a "minimum followers"
   * threshold, and `TableQuery.filters` models set membership, not ranges. Rather than grow the
   * shared contract a range operator for one surface (which is how a contract ends up shaped by
   * its first caller's accident, the thing plan 02 set out to avoid), the surface parses and
   * validates that parameter itself and hands the predicate down here.
   *
   * The safety property is unchanged either way: nothing in here is resolved from a client-supplied
   * *id*, and every value is a bound parameter.
   */
  scope?: SQL[]
  /** The projection. Sort columns and the tiebreaker are added internally to build the cursor. */
  select: Record<string, PgColumn | SQL>
  /** Raw row → DTO. The output-minimisation rule: a route returns fields it named, not ORM rows. */
  mapRow: (row: Record<string, unknown>) => Row
}

interface ResolvedSort {
  terms: Array<SortTerm & { column: PgColumn; nullsLast: boolean }>
  dir: 'asc' | 'desc'
  descriptor: string
}

/**
 * Resolve the requested sort, or the capability's default, into columns.
 *
 * An unknown id throws. It deliberately does not fall back to `defaultSort`: a fallback teaches
 * a caller that a typo is harmless, and hides the bug until the day the id matters.
 */
function resolveSort(
  capability: TableCapability,
  requested: TableQuery['sort'],
  groupBy: string | null = null,
): ResolvedSort {
  const requestedSort = requested.length > 0 ? requested : capability.defaultSort

  /*
   * A grouped table has to be ordered by the group column first.
   *
   * Found on the first real surface: grouping sprint results by `source` while sorting by `score`
   * produced **36 group headers for 50 rows**, because the renderer starts a group wherever the
   * value changes and an unrelated sort interleaves the sources. Technically it obeyed "grouping
   * never changes which rows a page contains"; practically it was unreadable.
   *
   * So the group column leads the `ORDER BY`. This does change which rows land on page one, and
   * that is the point — a group split across five pages is not a group. The spec's edge case is
   * about *membership*: search and filters narrow the set, grouping still does not.
   *
   * Only when the group column is also sortable, which is also the only way it can be indexed. A
   * groupable-but-not-sortable column (a jsonb path, say) degrades to run detection, and the
   * capability author should make it sortable if the grouping matters.
   */
  const source = groupBy !== null && groupBy in capability.sortable
    && !requestedSort.some((term) => term.id === groupBy)
    ? [{ id: groupBy, dir: requestedSort[0]?.dir ?? 'asc' }, ...requestedSort]
    : requestedSort

  const directions = new Set(source.map((term) => term.dir))
  if (directions.size > 1) {
    // A row-value comparison has one direction. Emitting a mixed-direction keyset would produce a
    // predicate that looks right and pages wrongly, so this version refuses instead.
    throw new TableQueryError('Mixed sort directions are not supported')
  }
  const dir = source[0]?.dir ?? 'asc'

  const terms: ResolvedSort['terms'] = []
  const seen = new Set<string>()
  for (const term of source) {
    const entry = capability.sortable[term.id]
    if (!entry) throw new TableQueryError(`Unknown sort column: ${term.id}`)
    if (seen.has(term.id)) continue
    seen.add(term.id)
    terms.push({
      ...term,
      column: entry.column,
      nullsLast: entry.nullsLast ?? term.dir === 'asc',
    })
  }

  // The tiebreaker inherits the sort's direction because the comparison it participates in has
  // only one. It is unique, so it is never null. Skipped when the caller is already sorting by
  // that very column — appending it twice would put the same column in the tuple twice.
  const alreadyTiebroken = terms.some((term) => term.column === capability.tiebreaker)
  if (!alreadyTiebroken) {
    terms.push({ id: TIEBREAKER_ID, dir, column: capability.tiebreaker, nullsLast: dir === 'asc' })
  }

  return { terms, dir, descriptor: sortDescriptor(terms.map((term) => ({ id: term.id, dir: term.dir }))) }
}

/** `ILIKE` needs its wildcards escaped, or a user typing `%` searches for everything. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function searchPredicate(capability: TableCapability, search: string): SQL | undefined {
  const term = search.trim()
  if (term === '' || capability.searchable.length === 0) return undefined
  const pattern = `%${escapeLike(term)}%`
  const parts = capability.searchable.map((column) => sql`${column} ilike ${pattern}`)
  return parts.length === 1 ? parts[0] : or(...parts)
}

/** One predicate per active filter dimension, keyed by id so a facet can drop its own. */
function filterPredicates(capability: TableCapability, filters: TableQuery['filters']): Map<string, SQL> {
  const predicates = new Map<string, SQL>()
  for (const [id, values] of Object.entries(filters)) {
    const entry = capability.filterable[id]
    if (!entry) throw new TableQueryError(`Unknown filter column: ${id}`)
    if (values.length === 0) continue
    if (entry.values) {
      const allowed = new Set(entry.values)
      const rejected = values.filter((value) => !allowed.has(value))
      if (rejected.length > 0) {
        throw new TableQueryError(`Unknown value for filter ${id}: ${rejected.join(', ')}`)
      }
    }
    // `inArray` binds every value as a parameter, and accepts an expression as readily as a column
    // — so a jsonb path filters the same way. A value full of quotes and keywords changes the
    // parameter list and nothing structural; asserted in table-keyset-isolation.test.ts.
    //
    // Narrowed at the call site rather than passed as a union: `inArray`'s three overloads each
    // take one shape, and a union matches none of them.
    predicates.set(id, isColumnRef(entry.column)
      ? inArray(entry.column.sql, values)
      : inArray(entry.column, values) as SQL)
  }
  return predicates
}

/**
 * "Strictly after the cursor row", in the ordering the sort defines.
 *
 * Two forms, and the choice is not an optimisation detail. When every sort column is `NOT NULL` a
 * row-value comparison is emitted — `(score, id) < (:score, :id)` — which is the form Postgres can
 * satisfy with one index range scan, and the form plan 04's `EXPLAIN` assertions expect.
 *
 * When any sort column is nullable, that form is *wrong*: a row-value comparison has no notion of
 * `NULLS LAST`, so it silently skips rows on either side of the null boundary. The lexicographic
 * OR-form is emitted instead, with each term's null handling written out.
 */
function keysetPredicate(sort: ResolvedSort, tuple: CursorValue[]): SQL {
  const { terms, dir } = sort
  const comparison = dir === 'asc' ? sql`>` : sql`<`

  const everyTermIsNotNull = terms.every((term) => term.column.notNull)
  if (everyTermIsNotNull) {
    const columns = sql.join(terms.map((term) => sql`${term.column}`), sql`, `)
    const values = sql.join(tuple.map((value) => sql`${value}`), sql`, `)
    return sql`(${columns}) ${comparison} (${values})`
  }

  const branches: SQL[] = []
  for (let i = 0; i < terms.length; i += 1) {
    const parts: SQL[] = []
    for (let j = 0; j < i; j += 1) {
      // `IS NOT DISTINCT FROM` rather than `=`, because `null = null` is null and would drop the
      // branch entirely — the exact way a nullable keyset loses rows.
      parts.push(sql`${terms[j].column} is not distinct from ${tuple[j]}`)
    }
    const after = strictlyAfter(terms[i], tuple[i], comparison)
    if (after === null) continue
    parts.push(after)
    branches.push(sql`(${sql.join(parts, sql` and `)})`)
  }
  if (branches.length === 0) return sql`false`
  return sql`(${sql.join(branches, sql` or `)})`
}

/** `null` means "nothing can come after this value in this term" — the branch is dropped. */
function strictlyAfter(
  term: { column: PgColumn; nullsLast: boolean },
  value: CursorValue,
  comparison: SQL,
): SQL | null {
  if (value === null) {
    // Nulls sort last: past a null there is nothing left in this term.
    if (term.nullsLast) return null
    return sql`${term.column} is not null`
  }
  if (term.nullsLast) return sql`(${term.column} ${comparison} ${value} or ${term.column} is null)`
  return sql`${term.column} ${comparison} ${value}`
}

function orderBy(sort: ResolvedSort): SQL[] {
  return sort.terms.map((term) => {
    const direction = term.dir === 'asc' ? sql`asc` : sql`desc`
    const nulls = term.nullsLast ? sql`nulls last` : sql`nulls first`
    return sql`${term.column} ${direction} ${nulls}`
  })
}

/**
 * The organization this transaction is scoped to.
 *
 * Reading it back rather than taking it as an argument is the point: it proves the transaction
 * really did run `set_config('app.organization_id', …)`. A builder that accepted an id from its
 * caller and ran outside a tenant context would query with RLS's `current_setting` empty, and
 * on any table whose policy is ever weakened that is a cross-tenant read with nothing to notice.
 */
async function requireOrganizationId(tx: KeysetTransaction): Promise<string> {
  const result = (await tx.execute(
    sql`select nullif(current_setting('app.organization_id', true), '') as organization_id`,
  )) as Array<{ organization_id: string | null }>
  const organizationId = result?.[0]?.organization_id ?? null
  if (!organizationId) {
    throw new Error('buildKeysetPage must run inside withTenantContext — app.organization_id is unset')
  }
  return organizationId
}

/**
 * Everything about a page request that is decided before any SQL runs.
 *
 * Split out from execution so the emitted predicates and `ORDER BY` can be asserted directly — a
 * test that has to reach a database to find out whether the tiebreaker is present is a test
 * nobody writes. `keyset.test.ts` renders these with `PgDialect` and reads the SQL.
 */
export interface KeysetPlan {
  sort: ResolvedSort
  /** Organization, scope and search — everything a facet count must keep. */
  base: SQL[]
  /** One entry per active filter dimension, keyed by id so a facet can drop its own. */
  filters: Map<string, SQL>
  /** `base` + every filter. What `total` counts. */
  filtered: SQL[]
  /** `filtered` + the keyset predicate. What the page selects. */
  rowConditions: SQL[]
  /** Digest of the filter and search, minted into the next cursor and checked on the presented one. */
  fingerprint: string
  order: SQL[]
  limit: number
}

export function planKeysetPage(
  capability: TableCapability,
  query: TableQuery,
  page: PageRequest,
  context: { organizationId: string | null; scope?: SQL[] },
): KeysetPlan {
  if (query.groupBy !== null && !capability.groupable.includes(query.groupBy)) {
    throw new TableQueryError(`Unknown group column: ${query.groupBy}`)
  }

  const sort = resolveSort(capability, query.sort, query.groupBy)

  const base: SQL[] = []
  if (capability.organizationColumn && context.organizationId) {
    base.push(eq(capability.organizationColumn, context.organizationId) as SQL)
  }
  base.push(...(context.scope ?? []))
  const search = searchPredicate(capability, query.search)
  if (search) base.push(search)

  const filters = filterPredicates(capability, query.filters)
  const filtered = [...base, ...filters.values()]

  // The cursor is bound to the table, the sort and the organization. Presenting one from another
  // sort would page from the middle of a different ordering; from another organization it would
  // ask "what comes after this row" about rows the caller cannot see.
  const fingerprint = queryFingerprint(query)
  const cursorTuple = page.cursor
    ? verifyTableCursor(page.cursor, {
      table: capability.table,
      sort: sort.descriptor,
      organizationId: context.organizationId,
      query: fingerprint,
    }).k
    : null
  if (cursorTuple && cursorTuple.length !== sort.terms.length) {
    throw new TableQueryError('Cursor does not match the sort')
  }

  return {
    sort,
    base,
    filters,
    filtered,
    rowConditions: cursorTuple ? [...filtered, keysetPredicate(sort, cursorTuple)] : filtered,
    fingerprint,
    order: orderBy(sort),
    // Page size is the server's, not the caller's.
    limit: Math.max(1, Math.min(page.limit || TABLE_PAGE_SIZE, TABLE_PAGE_SIZE)),
  }
}

export async function buildKeysetPage<Row>(
  tx: KeysetTransaction,
  capability: TableCapability,
  query: TableQuery,
  page: PageRequest,
  options: KeysetPageOptions<Row>,
): Promise<PageResult<Row>> {
  const table = capabilityTable(capability)
  const organizationId = capability.organizationColumn ? await requireOrganizationId(tx) : null
  const plan = planKeysetPage(capability, query, page, { organizationId, scope: options.scope })
  const { sort, base, filters, filtered, rowConditions, limit } = plan

  // Sort columns and the tiebreaker must come back even when the caller's projection omits them,
  // or there is nothing to mint the next cursor from.
  const selection: Record<string, unknown> = { ...options.select }
  sort.terms.forEach((term, index) => {
    selection[`__k${index}`] = term.column
  })

  const rawRows = (await tx
    .select(selection)
    .from(table)
    .where(rowConditions.length > 0 ? and(...rowConditions) : undefined)
    .orderBy(...plan.order)
    // One more than the page, so "is there a next page" is an answer rather than a guess. A page
    // that returned exactly `limit` rows and minted a cursor anyway ends in an empty last page.
    .limit(limit + 1)) as Array<Record<string, unknown>>

  const hasMore = rawRows.length > limit
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows

  const [totalRow] = (await tx
    .select({ value: count() })
    .from(table)
    .where(filtered.length > 0 ? and(...filtered) : undefined)) as Array<{ value: number }>

  const facets = await computeFacets(tx, capability, base, filters)

  const last = pageRows.at(-1)
  const nextCursor = hasMore && last
    ? createTableCursor({
      t: capability.table,
      s: sort.descriptor,
      o: organizationId,
      k: sort.terms.map((_, index) => toCursorValue(last[`__k${index}`])),
      q: plan.fingerprint,
    })
    : null

  return {
    rows: pageRows.map((row) => options.mapRow(stripKeyColumns(row, sort.terms.length))),
    nextCursor,
    total: totalRow?.value ?? 0,
    facets,
  }
}

/**
 * Facet counts that cannot disagree with the rows.
 *
 * Each dimension counts with the *other* dimensions' filters applied but not its own. Applying
 * its own is the naive version, and it reports 0 for every unselected value in the dimension the
 * user is currently filtering by — so the chips say "there is nothing else here" at exactly the
 * moment the user is looking for what else is there.
 *
 * They run in the same transaction as the rows, so a concurrent write cannot make the counts
 * describe a different snapshot than the page.
 */
async function computeFacets(
  tx: KeysetTransaction,
  capability: TableCapability,
  base: SQL[],
  filters: Map<string, SQL>,
): Promise<PageResult<unknown>['facets']> {
  const facets: PageResult<unknown>['facets'] = {}
  const table = capabilityTable(capability)

  for (const [id, entry] of Object.entries(capability.filterable)) {
    if (!entry.facet) continue
    const others = [...filters.entries()].filter(([key]) => key !== id).map(([, predicate]) => predicate)
    const conditions = [...base, ...others]

    const expression = refSql(entry.column)
    const rows = (await tx
      .select({ value: sql<string>`${expression}::text`, count: count() })
      .from(table)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(expression)
      .orderBy(desc(count()), asc(expression))
      // A facet is a list read like any other.
      .limit(FACET_VALUE_LIMIT)) as Array<{ value: string | null; count: number }>

    facets[id] = rows
      .filter((row): row is { value: string; count: number } => row.value !== null)
      .map((row) => ({ value: row.value, count: row.count }))
  }

  return facets
}

function toCursorValue(value: unknown): CursorValue {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return String(value)
}

function stripKeyColumns(row: Record<string, unknown>, keyCount: number): Record<string, unknown> {
  const clean: Record<string, unknown> = { ...row }
  for (let index = 0; index < keyCount; index += 1) delete clean[`__k${index}`]
  return clean
}
