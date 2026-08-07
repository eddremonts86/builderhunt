import { getTableConfig } from 'drizzle-orm/pg-core'

import { capabilityTable, type TableCapability } from './capability'

/**
 * Declaring a column sortable costs a migration.
 *
 * With `LIMIT 50`, an index the planner can walk returns 50 rows and stops. Without one, Postgres
 * sorts the whole matching set to find the top 50 — so adding pagination to an unindexed sort makes
 * the query *slower* than the unbounded read it replaced. And it only shows up in production, and
 * only once a tenant grows, because a table scan over 200 development rows is instant.
 *
 * That invisibility is why this is a test and not a review checklist.
 */

export interface IndexColumnDescriptor {
  name: string
  /** `undefined` means the index did not state one, so Postgres' default for the direction applies. */
  nulls?: 'first' | 'last'
}

export interface IndexDescriptor {
  name: string
  columns: IndexColumnDescriptor[]
}

/** The indexes a Drizzle table declares, normalised. Unique constraints count — they are indexes. */
export function indexesOf(capability: TableCapability): IndexDescriptor[] {
  const config = getTableConfig(capabilityTable(capability))

  const fromIndexes = config.indexes.map((index) => ({
    name: index.config.name ?? '<unnamed>',
    columns: index.config.columns.map((column) => ({
      name: (column as { name?: string }).name ?? '<expression>',
      nulls: (column as { indexConfig?: { nulls?: 'first' | 'last' } }).indexConfig?.nulls,
    })),
  }))

  // A unique constraint is backed by a unique index, and the planner walks it like any other.
  const fromUnique = config.uniqueConstraints.map((constraint) => ({
    name: constraint.name ?? '<unique>',
    columns: constraint.columns.map((column) => ({ name: column.name })),
  }))

  const primaryKey = config.primaryKeys.map((key) => ({
    name: key.getName(),
    columns: key.columns.map((column) => ({ name: column.name })),
  }))

  // A single-column primary key is an index on that column, and it is the usual tiebreaker.
  const implicitPrimary = config.columns
    .filter((column) => column.primary)
    .map((column) => ({ name: `${config.name}_pkey`, columns: [{ name: column.name }] }))

  return [...fromIndexes, ...fromUnique, ...primaryKey, ...implicitPrimary]
}

export interface CoverageResult {
  sortId: string
  index: string | null
  reason?: string
}

/**
 * Which index backs one sortable column, if any.
 *
 * The shape required is `(organization_id?, …scope, sortColumn, tiebreaker)`:
 *
 * - **The tenant column leads** on a tenant-scoped table, because RLS adds
 *   `organization_id = current_setting(…)` to every query and an index that does not start with it
 *   cannot be walked.
 * - **Scope columns may sit between** the tenant and the sort column — `sprint_id` on
 *   `sprint_results`, for instance. They are equality predicates, so the planner still gets an
 *   ordered range.
 * - **The tiebreaker trails the sort column immediately**, because that is the only shape a tuple
 *   comparison `(score, id) < (:score, :id)` can satisfy with one range scan.
 *
 * Direction is deliberately not checked: Postgres walks a b-tree backwards, so one ascending index
 * serves `ASC` and `DESC` alike. A mixed-direction sort would break that, and plan 03 rejects it.
 *
 * `NULLS LAST` *is* checked. It changes the physical order, so an index without the modifier
 * cannot serve a sort that has it — the walk starts in the wrong place and the planner sorts anyway.
 */
export function findCoveringIndex(
  capability: TableCapability,
  sortId: string,
  indexes: IndexDescriptor[] = indexesOf(capability),
): CoverageResult {
  const entry = capability.sortable[sortId]
  if (!entry) return { sortId, index: null, reason: 'not a sortable id' }

  const sortColumn = entry.column.name
  const tiebreaker = capability.tiebreaker.name
  const tenant = capability.organizationColumn?.name ?? null
  const wantsNullsLast = entry.nullsLast === true

  // Sorting *by* the tiebreaker needs only an index that starts with it (after the tenant).
  if (sortColumn === tiebreaker) {
    const match = indexes.find((index) => {
      const columns = index.columns.map((column) => column.name)
      if (tenant && columns[0] !== tenant) return columns.length === 1 && columns[0] === tiebreaker
      return columns[tenant ? 1 : 0] === tiebreaker
    })
    return { sortId, index: match?.name ?? null, reason: match ? undefined : 'no index leads with the tiebreaker' }
  }

  let reason = `no index of the shape (${[tenant, '…scope', sortColumn, tiebreaker].filter(Boolean).join(', ')})`

  for (const index of indexes) {
    const columns = index.columns
    if (tenant && columns[0]?.name !== tenant) continue

    const at = columns.findIndex((column, position) =>
      column.name === sortColumn && position >= (tenant ? 1 : 0))
    if (at === -1) continue
    if (columns[at + 1]?.name !== tiebreaker) {
      reason = `${index.name} sorts by ${sortColumn} but does not trail it with ${tiebreaker}`
      continue
    }
    if (wantsNullsLast && columns[at].nulls !== 'last') {
      reason = `${index.name} matches the columns but lacks NULLS LAST on ${sortColumn}`
      continue
    }
    return { sortId, index: index.name }
  }

  return { sortId, index: null, reason }
}

/** Every sortable column of one capability, with the index that backs it or `null`. */
export function auditCapabilityIndexes(capability: TableCapability): CoverageResult[] {
  if (capability.nonSql) return []
  const indexes = indexesOf(capability)
  return Object.keys(capability.sortable).map((sortId) => findCoveringIndex(capability, sortId, indexes))
}
