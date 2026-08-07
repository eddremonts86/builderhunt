import { getTableName, type SQL, type Table } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

/**
 * What a client is allowed to ask of one table.
 *
 * A client never names a database column. It names an **id**, and an id that is not in this
 * descriptor cannot reach SQL — there is no path from a request to an `ORDER BY` that does not go
 * through `sortable`, and none to a `WHERE` that does not go through `filterable` or `searchable`.
 * That is the difference between "we validate the sort parameter" and "an unvalidated sort
 * parameter has nowhere to go".
 *
 * Everything here is code. A capability is constructed at module load through
 * `defineTableCapability`, which throws rather than returns — so a table that cannot be paginated
 * safely fails the import, not the request. A request-time failure is a page that 500s for one
 * user on a Tuesday; an import-time failure is a test run that never goes green.
 */

export interface SortableColumn {
  column: PgColumn
  /**
   * `ORDER BY col … NULLS LAST`, and a keyset predicate that knows it.
   *
   * Not cosmetic: Postgres sorts nulls last for `ASC` and first for `DESC` by default, and a
   * row-value comparison ignores null ordering entirely. Declaring it here is what makes the
   * keyset predicate switch to the null-aware form instead of silently skipping rows.
   */
  nullsLast?: boolean
}

/**
 * A value that lives inside a column rather than being one — a key in a jsonb document.
 *
 * `sprint_results.profile->>'country'` is the case that forced this: the location facet the sprint
 * results surface has always shown is computed from a jsonb key, and `PgColumn` cannot name it. The
 * alternative was to drop the facet, which would have been a feature regression disguised as a
 * migration.
 *
 * Filtering and grouping only. **Not sortable**: a sortable expression needs an expression index
 * behind it, and `capability-index.ts` matches indexes by column name — it would report a jsonb
 * path as backed when nothing backs it, which is worse than refusing the sort.
 */
export interface ColumnRef {
  /** Stable identifier, for error messages. Not a database column name. */
  name: string
  sql: SQL
}

export type FilterableRef = PgColumn | ColumnRef

/** True for the expression form. */
export function isColumnRef(value: FilterableRef): value is ColumnRef {
  return 'sql' in value && !('table' in value)
}

/** The SQL for either form, for a `WHERE` or a `GROUP BY`. */
export function refSql(value: FilterableRef): SQL | PgColumn {
  return isColumnRef(value) ? value.sql : value
}

export interface FilterableColumn {
  column: FilterableRef
  /** When present, a value outside this list is a 400 — the filter is an enum, not free text. */
  values?: readonly string[]
  /**
   * Opt in to a facet count for this dimension.
   *
   * Facets are opt-in because each one costs a `GROUP BY` in the request's transaction. A table
   * that declares none pays for two queries: the rows and the total.
   */
  facet?: boolean
}

export interface SortTerm {
  id: string
  dir: 'asc' | 'desc'
}

export interface TableCapability {
  /** Stable id. A cursor minted for this table is rejected by every other one. */
  table: string
  /** An id absent here cannot reach SQL. */
  sortable: Record<string, SortableColumn>
  filterable: Record<string, FilterableColumn>
  groupable: readonly string[]
  /** Free-text search: `ILIKE` over these columns only. */
  searchable: readonly PgColumn[]
  /** Unique column appended to every `ORDER BY`, making the sort a total order. */
  tiebreaker: PgColumn
  /** Default sort when the URL carries none. Must be index-backed (plan 04). */
  defaultSort: SortTerm[]
  /**
   * The tenant column, on a tenant-scoped table.
   *
   * RLS is forced and would exclude other organizations' rows on its own. This is the second
   * layer the security policy requires, not a substitute for the first: an explicit
   * `organization_id = :current` in the emitted `WHERE`, so a table whose policy is ever dropped
   * or mis-migrated fails closed at the query instead of quietly widening.
   *
   * Omitted for genuinely global tables (changelog, roadmap, public content).
   */
  organizationColumn?: PgColumn

  /**
   * This table is not in Postgres.
   *
   * The blog library reads the filesystem, so no index applies to it and the sort-index guard has
   * nothing to check. Marked explicitly rather than skipped by a name pattern, so a table that is
   * genuinely missing its indexes cannot be mistaken for one that never needed them.
   */
  nonSql?: true
}

/**
 * How many distinct values one facet dimension may return.
 *
 * A facet is a list read like any other, and "nothing loads a whole result set" does not stop
 * being true because the rows are counts. A dimension with more distinct values than this is a
 * search box, not a set of chips.
 */
export const FACET_VALUE_LIMIT = 50

export class TableCapabilityError extends Error {
  constructor(table: string, reason: string) {
    super(`Table capability "${table}" is invalid: ${reason}`)
    this.name = 'TableCapabilityError'
  }
}

/**
 * Validate a capability and freeze it.
 *
 * Every check here is a bug that would otherwise surface as wrong data rather than as an error:
 * a default sort naming an id nobody can sort by silently orders by nothing; a tiebreaker from
 * another table produces a predicate that compares unrelated rows; a groupable id with no column
 * behind it groups by a string.
 */
export function defineTableCapability(capability: TableCapability): TableCapability {
  const { table } = capability

  if (!capability.tiebreaker) {
    // A table with no unique column cannot be paginated safely at all: without a total order, a
    // 50-row page boundary landing inside a tie repeats or drops rows, and no amount of care at
    // the call site fixes it.
    throw new TableCapabilityError(table, 'no tiebreaker column — the sort could not be a total order')
  }

  if (capability.defaultSort.length === 0) {
    throw new TableCapabilityError(table, 'defaultSort is empty — page one would have no deterministic order')
  }

  for (const term of capability.defaultSort) {
    if (!(term.id in capability.sortable)) {
      throw new TableCapabilityError(table, `defaultSort names "${term.id}", which is not sortable`)
    }
  }

  const directions = new Set(capability.defaultSort.map((term) => term.dir))
  if (directions.size > 1) {
    throw new TableCapabilityError(
      table,
      'defaultSort mixes asc and desc — a keyset tuple comparison has one direction (see keyset.ts)',
    )
  }

  for (const id of capability.groupable) {
    if (!(id in capability.sortable) && !(id in capability.filterable)) {
      throw new TableCapabilityError(table, `groupable names "${id}", which has no column behind it`)
    }
  }

  // One capability describes one table. Joins are out of scope for this version, and a column
  // from elsewhere in a predicate is the kind of mistake that reads correctly and returns rows
  // from the wrong relation.
  const base = getTableName(capability.tiebreaker.table as Table)
  const foreign: string[] = []
  for (const [id, entry] of Object.entries(capability.sortable)) {
    if (getTableName(entry.column.table as Table) !== base) foreign.push(`sortable.${id}`)
  }
  for (const [id, entry] of Object.entries(capability.filterable)) {
    // An expression is written against this table by construction — it is a `sql` template the
    // capability's author composed from this table's columns — so there is nothing to compare.
    if (isColumnRef(entry.column)) continue
    if (getTableName(entry.column.table as Table) !== base) foreign.push(`filterable.${id}`)
  }
  for (const column of capability.searchable) {
    if (getTableName(column.table as Table) !== base) foreign.push(`searchable.${column.name}`)
  }
  if (foreign.length > 0) {
    throw new TableCapabilityError(table, `columns from another table than "${base}": ${foreign.join(', ')}`)
  }

  return Object.freeze(capability)
}

/** The Drizzle table a capability reads from — the tiebreaker's, which every column shares. */
export function capabilityTable(capability: TableCapability): Table {
  return capability.tiebreaker.table as Table
}

/**
 * Every capability in the app, keyed by table id.
 *
 * Populated as surfaces migrate (plans 07–11). Registering here is what lets a generic handler
 * resolve a table id from a route without each route re-declaring its own allowlist.
 */
export const TABLE_CAPABILITIES: Record<string, TableCapability> = {}

export function registerTableCapability(capability: TableCapability): TableCapability {
  const existing = TABLE_CAPABILITIES[capability.table]
  if (existing && existing !== capability) {
    throw new TableCapabilityError(capability.table, 'already registered by another module')
  }
  TABLE_CAPABILITIES[capability.table] = capability
  return capability
}
