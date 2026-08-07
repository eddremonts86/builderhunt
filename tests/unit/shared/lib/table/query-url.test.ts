import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { TABLE_PAGE_SIZE } from '~/shared/lib/table/constants'
import {
  emptyTableSearch,
  serializeTableSearch,
  tableSearchSchema,
  tableSearchToParams,
} from '~/shared/lib/table/query-url'
import type { TableSearch } from '~/shared/lib/table/types'

const COLUMN_IDS = ['name', 'createdAt', 'score', 'tier', 'status'] as const

/**
 * Canonical table state.
 *
 * "Canonical" is doing real work here. The codec drops what it can restore from a default — an
 * empty search, an empty filter array, the default renderer — so the round trip is an identity on
 * canonical values, not on every value of the type. Generating an empty filter array and then
 * asserting it survives would be testing the codec against a shape it is documented to collapse.
 */
const arbitraryTableSearch: fc.Arbitrary<TableSearch> = fc.record({
  query: fc.record({
    search: fc.string(),
    filters: fc.dictionary(
      fc.constantFrom(...COLUMN_IDS),
      fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 4 }),
      { maxKeys: 3 },
    ),
    sort: fc.uniqueArray(
      fc.record({ id: fc.constantFrom(...COLUMN_IDS), dir: fc.constantFrom<'asc' | 'desc'>('asc', 'desc') }),
      { selector: (term) => term.id, maxLength: 3 },
    ),
    groupBy: fc.option(fc.constantFrom(...COLUMN_IDS), { nil: null }),
  }),
  page: fc.record({
    cursor: fc.option(fc.string({ minLength: 1 }), { nil: null }),
    limit: fc.constant(TABLE_PAGE_SIZE),
  }),
  renderer: fc.constantFrom('table', 'cards', 'board'),
})

describe('tableSearchSchema round trip', () => {
  it('parse(serialize(q)) deep-equals q for any canonical state', () => {
    fc.assert(
      fc.property(arbitraryTableSearch, (search) => {
        expect(tableSearchSchema(serializeTableSearch(search))).toEqual(search)
      }),
      { numRuns: 500 },
    )
  })

  /**
   * The shell writes the URL and the loader reads it back on every interaction, so the second
   * write must produce the same URL as the first. If it does not, a table drifts one keystroke at
   * a time away from the link that opened it.
   */
  it('is idempotent through a real URLSearchParams, not only through the record form', () => {
    fc.assert(
      fc.property(arbitraryTableSearch, (search) => {
        const once = tableSearchToParams(search)
        const reparsed = tableSearchSchema(fromParams(once))
        expect(tableSearchToParams(reparsed).toString()).toBe(once.toString())
      }),
      { numRuns: 500 },
    )
  })
})

describe('tableSearchSchema tolerance', () => {
  it('ignores parameters it does not recognise, so a stale link still opens', () => {
    const parsed = tableSearchSchema({ q: 'ada', utm_source: 'newsletter', tab: 'roadmap' })
    expect(parsed.query.search).toBe('ada')
    expect(parsed.query.filters).toEqual({})
  })

  it('drops a sort term with an unknown direction rather than rejecting the whole URL', () => {
    expect(tableSearchSchema({ sort: 'name:sideways,score:desc' }).query.sort).toEqual([
      { id: 'score', dir: 'desc' },
    ])
  })

  it('drops a sort id that is not a column id shape', () => {
    expect(tableSearchSchema({ sort: 'name;drop table:asc' }).query.sort).toEqual([])
  })

  it('keeps the first of two terms for the same column', () => {
    expect(tableSearchSchema({ sort: 'name:asc,name:desc' }).query.sort).toEqual([
      { id: 'name', dir: 'asc' },
    ])
  })

  it('ignores a group by a malformed column id', () => {
    expect(tableSearchSchema({ group: '1; select' }).query.groupBy).toBeNull()
  })
})

describe('tableSearchSchema filters', () => {
  it('reads a repeated parameter as a multi-value filter', () => {
    expect(tableSearchSchema({ 'filter.tier': ['pro', 'team'] }).query.filters).toEqual({
      tier: ['pro', 'team'],
    })
  })

  it('collapses a duplicated value so the round trip stays lossless', () => {
    expect(tableSearchSchema({ 'filter.tier': ['pro', 'pro'] }).query.filters).toEqual({ tier: ['pro'] })
  })

  /** An empty dimension means "no filter here", not "match nothing" — the difference between a full table and an empty one when the last checkbox is cleared. */
  it('treats an empty value list as no filter at all', () => {
    expect(tableSearchSchema({ 'filter.tier': [] }).query.filters).toEqual({})
    expect(tableSearchSchema({ 'filter.tier': '' }).query.filters).toEqual({})
  })

  it('ignores a filter whose id is not a column id shape', () => {
    expect(tableSearchSchema({ 'filter.tier;drop': ['pro'] }).query.filters).toEqual({})
  })
})

describe('page size', () => {
  /** Page size is what the server is willing to serve. A link that could widen its own page is a link that can ask for the whole table. */
  it('is never read from the URL', () => {
    expect(tableSearchSchema({ limit: '5000' }).page.limit).toBe(TABLE_PAGE_SIZE)
    expect(serializeTableSearch({ ...emptyTableSearch(), page: { cursor: null, limit: 5000 } })).toEqual({})
  })

  it('defaults an absent cursor to page one', () => {
    expect(tableSearchSchema({}).page.cursor).toBeNull()
    expect(tableSearchSchema({ cursor: '' }).page.cursor).toBeNull()
  })
})

describe('serializeTableSearch', () => {
  it('omits every default, so a pristine table has a clean URL', () => {
    expect(serializeTableSearch(emptyTableSearch())).toEqual({})
    expect(tableSearchToParams(emptyTableSearch()).toString()).toBe('')
  })

  it('repeats a multi-value filter rather than joining it', () => {
    const params = tableSearchToParams({
      ...emptyTableSearch(),
      query: { search: '', filters: { tier: ['pro', 'team'] }, sort: [], groupBy: null },
    })
    expect(params.getAll('filter.tier')).toEqual(['pro', 'team'])
  })
})

/** `URLSearchParams` → the record shape `validateSearch` receives, repeated keys as arrays. */
function fromParams(params: URLSearchParams): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key)
    record[key] = values.length > 1 ? values : values[0]
  }
  return record
}
