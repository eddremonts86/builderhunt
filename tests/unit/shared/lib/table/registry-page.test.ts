import { describe, expect, it } from 'vitest'
import { registryPage, type RegistryTableSpec } from '~/shared/lib/table/registry-page'
import type { TableQuery } from '~/shared/lib/table/types'

interface Source {
  source: string
  status: 'active' | 'dormant' | 'attention'
  lastRunAt: string | null
}

const SPEC: RegistryTableSpec<Source> = {
  searchable: (row) => [row.source],
  filterable: { status: (row) => row.status },
  sortable: { source: (row) => row.source, lastRunAt: (row) => row.lastRunAt },
  tiebreaker: (row) => row.source,
}

const ROWS: Source[] = [
  { source: 'github', status: 'active', lastRunAt: '2026-08-01' },
  { source: 'devto', status: 'active', lastRunAt: '2026-08-03' },
  { source: 'reddit', status: 'attention', lastRunAt: null },
  { source: 'gitlab', status: 'dormant', lastRunAt: '2026-07-20' },
]

function query(partial: Partial<TableQuery> = {}): TableQuery {
  return { search: '', filters: {}, sort: [], cursor: null, ...partial } as TableQuery
}

describe('registryPage', () => {
  it('reports the complete set with no next page', () => {
    const page = registryPage(ROWS, query(), SPEC)
    expect(page.rows).toHaveLength(4)
    expect(page.total).toBe(4)
    // A complete set has no next page. Claiming one is the lie `PageResult` exists to prevent.
    expect(page.nextCursor).toBeNull()
  })

  it('counts the filtered set, not the original', () => {
    // `total` drives `aria-rowcount` and the "N of M" label, both of which lie if they count
    // something other than what the filter selected.
    const page = registryPage(ROWS, query({ filters: { status: ['active'] } }), SPEC)
    expect(page.rows.map((r) => r.source)).toEqual(['devto', 'github'])
    expect(page.total).toBe(2)
  })

  it('treats an empty filter array as no filter, never as match-nothing', () => {
    // The difference between an empty table and a full one when a user clears the last checkbox.
    const page = registryPage(ROWS, query({ filters: { status: [] } }), SPEC)
    expect(page.total).toBe(4)
  })

  it('ignores an unknown filter dimension rather than emptying the table', () => {
    const page = registryPage(ROWS, query({ filters: { nonsense: ['x'] } }), SPEC)
    expect(page.total).toBe(4)
  })

  it('searches case-insensitively on the declared fields', () => {
    expect(registryPage(ROWS, query({ search: 'GIT' }), SPEC).rows.map((r) => r.source))
      .toEqual(['github', 'gitlab'])
  })

  it('sorts descending when asked', () => {
    const page = registryPage(ROWS, query({ sort: [{ id: 'source', dir: 'desc' }] }), SPEC)
    // `gitlab` before `github`: they share `git`, and `l` sorts after `h`.
    expect(page.rows.map((r) => r.source)).toEqual(['reddit', 'gitlab', 'github', 'devto'])
  })

  it('puts nulls last in both directions', () => {
    // An absent value is unknown, not smallest. Burying `reddit` at the top of an ascending sort
    // hides exactly the row an operator scanning for a stalled source is looking for.
    const asc = registryPage(ROWS, query({ sort: [{ id: 'lastRunAt', dir: 'asc' }] }), SPEC)
    expect(asc.rows.at(-1)?.source).toBe('reddit')
    const desc = registryPage(ROWS, query({ sort: [{ id: 'lastRunAt', dir: 'desc' }] }), SPEC)
    expect(desc.rows.at(-1)?.source).toBe('reddit')
  })

  it('breaks ties with the tiebreaker so the order is total', () => {
    // Every row shares a status, so the sort column decides nothing and the tiebreaker decides
    // everything. Without it these four order differently between renders, which reads to a user as
    // rows moving under the cursor.
    const tied: Source[] = [
      { source: 'zeta', status: 'active', lastRunAt: '2026-08-01' },
      { source: 'alpha', status: 'active', lastRunAt: '2026-08-01' },
      { source: 'mid', status: 'active', lastRunAt: '2026-08-01' },
    ]
    const spec: RegistryTableSpec<Source> = { ...SPEC, sortable: { status: (row) => row.status } }
    const page = registryPage(tied, query({ sort: [{ id: 'status', dir: 'asc' }] }), spec)
    expect(page.rows.map((r) => r.source)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('drops a sort term naming a column the spec does not declare', () => {
    // The client never gets to name a column. An unknown id falls through to the tiebreaker rather
    // than throwing, because a stale bookmarked URL should render the table, not an error.
    const page = registryPage(ROWS, query({ sort: [{ id: 'privateMetadata', dir: 'asc' }] }), SPEC)
    expect(page.rows.map((r) => r.source)).toEqual(['devto', 'github', 'gitlab', 'reddit'])
  })

  describe('facets', () => {
    it('counts every value the registry defines', () => {
      const page = registryPage(ROWS, query(), SPEC)
      expect(page.facets.status).toEqual([
        { value: 'active', count: 2 },
        { value: 'attention', count: 1 },
        { value: 'dormant', count: 1 },
      ])
    })

    it('excludes a dimension from its own counts', () => {
      // Counting the already-filtered rows would make every unselected checkbox read 0, telling the
      // user that also selecting `dormant` would match nothing.
      const page = registryPage(ROWS, query({ filters: { status: ['active'] } }), SPEC)
      expect(page.facets.status).toEqual([
        { value: 'active', count: 2 },
        { value: 'attention', count: 1 },
        { value: 'dormant', count: 1 },
      ])
    })

    it('keeps a value that currently matches nothing, at zero', () => {
      // An operator needs to see that `attention` exists and matches nothing right now, rather than
      // have it disappear from the control.
      const page = registryPage(ROWS, query({ search: 'git' }), SPEC)
      expect(page.facets.status).toEqual([
        { value: 'active', count: 1 },
        { value: 'attention', count: 0 },
        { value: 'dormant', count: 1 },
      ])
    })
  })

  it('does not mutate the input', () => {
    const original = [...ROWS]
    registryPage(ROWS, query({ sort: [{ id: 'source', dir: 'desc' }] }), SPEC)
    expect(ROWS).toEqual(original)
  })
})
