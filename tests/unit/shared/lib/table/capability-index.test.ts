import { describe, expect, it } from 'vitest'

import { sprintResults } from '~/shared/lib/db/schema'
// Imported for the side effect: a capability registers itself when its module is evaluated, so
// without this the sweep below would pass by finding nothing at all.
import '~/shared/lib/table/capabilities'
import { defineTableCapability, TABLE_CAPABILITIES } from '~/shared/lib/table/capability'
import {
  auditCapabilityIndexes,
  findCoveringIndex,
  indexesOf,
  type IndexDescriptor,
} from '~/shared/lib/table/capability-index'

/**
 * The guard: a sortable column with no index behind it fails the build.
 *
 * It is a test rather than a review checklist because the failure it prevents is invisible where
 * anyone would look for it. Sorting 200 development rows without an index is instant; the same
 * query against a tenant with 200,000 rows sorts the whole set to return 50, which is *slower*
 * than the unbounded read pagination was supposed to fix.
 */

const capability = defineTableCapability({
  table: 'sprint_results_guard_fixture',
  sortable: {
    score: { column: sprintResults.score },
    createdAt: { column: sprintResults.createdAt },
    source: { column: sprintResults.source },
    id: { column: sprintResults.id },
  },
  filterable: {},
  groupable: [],
  searchable: [],
  tiebreaker: sprintResults.id,
  defaultSort: [{ id: 'createdAt', dir: 'desc' }],
  organizationColumn: sprintResults.organizationId,
})

describe('every registered capability', () => {
  /**
   * A sweep rather than a list, so a capability is checked the day it is registered.
   *
   * It only sweeps what has been imported, which is why the barrel above is imported for its side
   * effect — and why this asserts the registry is *not* empty. A guard that passes over zero tables
   * is the most convincing kind of wrong.
   */
  it('covers every registered capability', () => {
    expect(Object.keys(TABLE_CAPABILITIES).length).toBeGreaterThan(0)
  })

  it('has an index behind every sortable column', () => {
    const uncovered = Object.values(TABLE_CAPABILITIES).flatMap((registered) =>
      auditCapabilityIndexes(registered)
        .filter((result) => result.index === null)
        .map((result) => `${registered.table}.${result.sortId}: ${result.reason}`))

    expect(uncovered).toEqual([])
  })
})

describe('the sprint-results sort indexes plan 07 will need', () => {
  it.each([
    ['createdAt', 'sprint_results_org_sprint_created_id_idx'],
    ['score', 'sprint_results_org_sprint_score_id_idx'],
    ['source', 'sprint_results_org_sprint_source_id_idx'],
  ])('backs %s with %s', (sortId, expected) => {
    expect(findCoveringIndex(capability, sortId).index).toBe(expected)
  })

  it('backs a sort by the tiebreaker itself', () => {
    expect(findCoveringIndex(capability, 'id').index).not.toBeNull()
  })
})

describe('what the guard refuses', () => {
  const tenant = 'organization_id'
  const fixture = (columns: string[][]): IndexDescriptor[] =>
    columns.map((names, position) => ({
      name: `idx_${position}`,
      columns: names.map((name) => ({ name })),
    }))

  /**
   * The bogus-sortable-entry case the checklist asks to verify by hand, kept as a test so it stays
   * verified. `matchedVariant` is a real column with no index behind it.
   */
  it('a sortable column with no index at all', () => {
    const bogus = defineTableCapability({
      ...capability,
      sortable: { ...capability.sortable, matchedVariant: { column: sprintResults.matchedVariant } },
    })
    const result = findCoveringIndex(bogus, 'matchedVariant')
    expect(result.index).toBeNull()
    expect(result.reason).toContain('no index of the shape')
  })

  /** RLS adds `organization_id = …` to every query, so an index that does not start with it cannot be walked. */
  it('an index that does not lead with the tenant column', () => {
    const indexes = fixture([['sprint_id', 'score', 'id']])
    const result = findCoveringIndex(capability, 'score', indexes)
    expect(result.index).toBeNull()
  })

  /** Without the trailing tiebreaker the tuple comparison cannot be answered by one range scan. */
  it('an index that omits the trailing tiebreaker', () => {
    const indexes = fixture([[tenant, 'sprint_id', 'score']])
    const result = findCoveringIndex(capability, 'score', indexes)
    expect(result.index).toBeNull()
    expect(result.reason).toContain('does not trail it with id')
  })

  it('an index whose tiebreaker is not immediately after the sort column', () => {
    const indexes = fixture([[tenant, 'score', 'source', 'id']])
    expect(findCoveringIndex(capability, 'score', indexes).index).toBeNull()
  })

  /** `NULLS LAST` changes the physical order, so the walk starts in the wrong place without it. */
  it('an index missing NULLS LAST for a sort that declares it', () => {
    const nullable = defineTableCapability({
      ...capability,
      sortable: { source: { column: sprintResults.source, nullsLast: true } },
      defaultSort: [{ id: 'source', dir: 'asc' }],
    })
    const withoutModifier: IndexDescriptor[] = [
      { name: 'plain', columns: [{ name: tenant }, { name: 'source' }, { name: 'id' }] },
    ]
    const withModifier: IndexDescriptor[] = [
      { name: 'nulls_last', columns: [{ name: tenant }, { name: 'source', nulls: 'last' }, { name: 'id' }] },
    ]

    expect(findCoveringIndex(nullable, 'source', withoutModifier).reason).toContain('NULLS LAST')
    expect(findCoveringIndex(nullable, 'source', withModifier).index).toBe('nulls_last')
  })
})

describe('what the guard accepts', () => {
  /** Scope columns are equality predicates, so the planner still gets an ordered range behind them. */
  it('scope columns between the tenant and the sort column', () => {
    const indexes: IndexDescriptor[] = [{
      name: 'scoped',
      columns: ['organization_id', 'sprint_id', 'score', 'id'].map((name) => ({ name })),
    }]
    expect(findCoveringIndex(capability, 'score', indexes).index).toBe('scoped')
  })

  it('reads unique constraints and primary keys as indexes, because they are', () => {
    const names = indexesOf(capability).map((index) => index.name)
    expect(names).toContain('sprint_results_sprint_source_unique')
    expect(names).toContain('sprint_results_pkey')
  })

  it('skips a capability marked non-SQL rather than failing it', () => {
    const fileBacked = { ...capability, nonSql: true as const }
    expect(auditCapabilityIndexes(fileBacked)).toEqual([])
  })
})
