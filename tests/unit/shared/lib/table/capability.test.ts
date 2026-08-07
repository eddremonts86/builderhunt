import { describe, expect, it } from 'vitest'

import {
  capabilityTable,
  defineTableCapability,
  registerTableCapability,
  TABLE_CAPABILITIES,
  TableCapabilityError,
  type TableCapability,
} from '~/shared/lib/table/capability'
import { organizations, sprintResults } from '~/shared/lib/db/schema'

function valid(overrides: Partial<TableCapability> = {}): TableCapability {
  return {
    table: 'sprint_results',
    sortable: {
      score: { column: sprintResults.score },
      createdAt: { column: sprintResults.createdAt },
    },
    filterable: { source: { column: sprintResults.source, facet: true } },
    groupable: ['source'],
    searchable: [sprintResults.matchedVariant],
    tiebreaker: sprintResults.id,
    defaultSort: [{ id: 'score', dir: 'desc' }],
    organizationColumn: sprintResults.organizationId,
    ...overrides,
  }
}

describe('defineTableCapability', () => {
  it('returns a frozen capability when everything resolves', () => {
    const capability = defineTableCapability(valid())
    expect(Object.isFrozen(capability)).toBe(true)
    expect(capabilityTable(capability)).toBe(sprintResults)
  })

  /**
   * A capability is validated at import, not at request time, because the two failures are not
   * equally visible: a request-time throw is one user's 500 on a Tuesday, and an import-time throw
   * is a test run that never goes green.
   */
  it('throws when the tiebreaker is missing', () => {
    expect(() => defineTableCapability(valid({ tiebreaker: undefined as never })))
      .toThrow(TableCapabilityError)
    expect(() => defineTableCapability(valid({ tiebreaker: undefined as never })))
      .toThrow(/no tiebreaker column/)
  })

  it('throws when defaultSort names a column nobody can sort by', () => {
    expect(() => defineTableCapability(valid({ defaultSort: [{ id: 'nope', dir: 'desc' }] })))
      .toThrow(/defaultSort names "nope"/)
  })

  it('throws when defaultSort is empty — page one would have no deterministic order', () => {
    expect(() => defineTableCapability(valid({ defaultSort: [] })))
      .toThrow(/defaultSort is empty/)
  })

  it('throws when defaultSort mixes directions, which a tuple comparison cannot express', () => {
    expect(() => defineTableCapability(valid({
      defaultSort: [{ id: 'score', dir: 'desc' }, { id: 'createdAt', dir: 'asc' }],
    }))).toThrow(/mixes asc and desc/)
  })

  it('throws when a groupable id has no column behind it', () => {
    expect(() => defineTableCapability(valid({ groupable: ['nothing'] })))
      .toThrow(/groupable names "nothing"/)
  })

  /** One capability, one table. A column from elsewhere produces a predicate that reads correctly and returns rows from the wrong relation. */
  it('throws when a column belongs to another table', () => {
    expect(() => defineTableCapability(valid({
      filterable: { source: { column: sprintResults.source }, name: { column: organizations.name } },
    }))).toThrow(/columns from another table.*filterable\.name/)
  })
})

describe('registerTableCapability', () => {
  it('registers under the table id and is idempotent for the same object', () => {
    const capability = defineTableCapability(valid({ table: 'registry_probe' }))
    registerTableCapability(capability)
    registerTableCapability(capability)
    expect(TABLE_CAPABILITIES.registry_probe).toBe(capability)
    delete TABLE_CAPABILITIES.registry_probe
  })

  it('refuses a second capability claiming the same table id', () => {
    const first = defineTableCapability(valid({ table: 'registry_clash' }))
    const second = defineTableCapability(valid({ table: 'registry_clash' }))
    registerTableCapability(first)
    expect(() => registerTableCapability(second)).toThrow(/already registered/)
    delete TABLE_CAPABILITIES.registry_clash
  })
})
