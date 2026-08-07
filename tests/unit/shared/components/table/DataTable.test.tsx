import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { DataTable } from '~/shared/components/table'
import type { ColumnDef } from '~/shared/lib/table/columns'
import { TABLE_PAGE_SIZE } from '~/shared/lib/table/constants'
import type { PageResult, TableQuery } from '~/shared/lib/table/types'

/**
 * One fixture through all four renderers and all four states.
 *
 * The assertions that matter here are the ones nobody sees in a screenshot: `aria-rowcount`
 * describing the filtered set rather than the loaded page, group headers showing the server's
 * aggregate rather than a count of what happens to be loaded, and the difference between "no data"
 * and "your filter excluded it".
 */

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
})

function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}

interface Result extends Record<string, unknown> {
  id: string
  source: string
  score: number
}

const columns: ColumnDef<Result>[] = [
  { id: 'id', header: 'ID', cell: (row) => row.id, value: (row) => row.id, priority: 'primary' },
  {
    id: 'source',
    header: 'Source',
    cell: (row) => row.source,
    value: (row) => row.source,
    sortable: true,
    groupable: true,
  },
  { id: 'score', header: 'Score', cell: (row) => row.score, value: (row) => row.score, sortable: true, align: 'end' },
]

const rows: Result[] = [
  { id: 'r1', source: 'github', score: 90 },
  { id: 'r2', source: 'github', score: 80 },
  { id: 'r3', source: 'gitlab', score: 70 },
]

/** 214 rows match; three are loaded. Every "partial data" assertion depends on that gap. */
const page: PageResult<Result> = {
  rows,
  nextCursor: 'cursor-2',
  total: 214,
  facets: { source: [{ value: 'github', count: 140 }, { value: 'gitlab', count: 74 }] },
}

const query: TableQuery = { search: '', filters: {}, sort: [], groupBy: null }

function render(overrides: Partial<React.ComponentProps<typeof DataTable<Result>>> = {}) {
  return mount(
    <DataTable
      label="Sprint results"
      columns={columns}
      page={page}
      query={query}
      onQueryChange={() => {}}
      rowTestId={(row) => `result-${row.id}`}
      {...overrides}
    />,
  )
}

describe('the ARIA grid', () => {
  it('names itself, so a screen reader can find it', () => {
    const grid = render().querySelector('[role="grid"]')
    expect(grid?.getAttribute('aria-label')).toBe('Sprint results')
  })

  /**
   * The one that matters. `rows.length` would say 3 and a screen-reader user would believe the list
   * is three rows long. `total` says 214, so they know it is partial without scrolling to find out.
   */
  it('counts the filtered set, not the loaded rows', () => {
    const grid = render().querySelector('[role="grid"]')
    expect(grid?.getAttribute('aria-rowcount')).toBe('215') // 214 rows + the header row
  })

  it('gives the header row index 1 and the first data row index 2', () => {
    const dom = render()
    const rowElements = dom.querySelectorAll('[role="row"]')
    expect(rowElements[0]?.getAttribute('aria-rowindex')).toBe('1')
    expect(dom.querySelector('[data-testid="result-r1"]')?.getAttribute('aria-rowindex')).toBe('2')
  })

  /** A surface that pages rather than accumulates still announces the absolute position. */
  it('offsets the row index when the surface is not on page one', () => {
    const dom = render({ rowOffset: 100 })
    expect(dom.querySelector('[data-testid="result-r1"]')?.getAttribute('aria-rowindex')).toBe('102')
  })

  it('marks a sortable header with aria-sort and leaves the others alone', () => {
    const dom = render({ query: { ...query, sort: [{ id: 'score', dir: 'desc' }] } })
    const headers = [...dom.querySelectorAll('[role="columnheader"]')]
    const score = headers.find((header) => header.textContent?.includes('Score'))
    const id = headers.find((header) => header.textContent?.includes('ID'))
    expect(score?.getAttribute('aria-sort')).toBe('descending')
    expect(id?.getAttribute('aria-sort')).toBeNull()
  })
})

describe('row test ids', () => {
  /** `tests/regression/test-status-and-trust.mjs` and several e2e specs drive rows by these. */
  it('are the surface\'s, forwarded verbatim', () => {
    const dom = render()
    expect(dom.querySelector('[data-testid="result-r1"]')).not.toBeNull()
    expect(dom.querySelector('[data-testid="result-r3"]')).not.toBeNull()
  })
})

describe('the four renderers', () => {
  it.each(['table', 'grouped', 'board', 'stacked'] as const)('renders every row as %s', (renderer) => {
    const dom = render({ renderer, query: { ...query, groupBy: 'source' } })
    for (const row of rows) {
      expect(dom.querySelector(`[data-testid="result-${row.id}"]`)).not.toBeNull()
    }
  })

  it('keeps the server\'s row order — no renderer re-sorts what it was given', () => {
    for (const renderer of ['table', 'grouped', 'stacked'] as const) {
      const dom = render({ renderer, query: { ...query, sort: [{ id: 'score', dir: 'asc' }] } })
      const ids = [...dom.querySelectorAll('[data-testid^="result-"]')]
        .map((element) => element.getAttribute('data-testid'))
        .filter((id) => id && !id.endsWith('-select'))
      // Ascending by score would be r3, r2, r1. The server sent r1, r2, r3, so that is what shows.
      expect(ids).toEqual(['result-r1', 'result-r2', 'result-r3'])
    }
  })
})

describe('group headers', () => {
  /**
   * The count that looks right and is wrong. `github` holds 140 rows; two of them are loaded. A
   * header reading "github (2)" is what a loaded-rows count produces, and it is the number an
   * operator would act on.
   */
  it('show the server\'s aggregate for the whole group, with the loaded count beside it', () => {
    const dom = render({ renderer: 'grouped', query: { ...query, groupBy: 'source' } })
    expect(dom.querySelector('[data-testid="table-group-github-total"]')?.textContent).toContain('140')
    expect(dom.querySelector('[data-testid="table-group-github-loaded"]')?.textContent).toContain('2')
  })

  it('show no total rather than a wrong one when the server sent no facet for the dimension', () => {
    const dom = render({
      renderer: 'grouped',
      query: { ...query, groupBy: 'source' },
      page: { ...page, facets: {} },
    })
    expect(dom.querySelector('[data-testid="table-group-github-total"]')).toBeNull()
    expect(dom.querySelector('[data-testid="table-group-github-loaded"]')?.textContent).toContain('2')
  })
})

describe('the four states', () => {
  it('loading shows skeleton rows in the real column widths, not a spinner', () => {
    const dom = render({ status: 'loading', page: { ...page, rows: [], total: 0 } })
    expect(dom.querySelector('[data-testid="table-skeleton"]')).not.toBeNull()
    expect(dom.querySelector('[role="grid"]')?.getAttribute('aria-busy')).toBe('true')
  })

  it('empty explains that there is nothing here', () => {
    const dom = render({ page: { ...page, rows: [], total: 0 } })
    expect(dom.querySelector('[data-testid="table-blank"]')).not.toBeNull()
    expect(dom.querySelector('[data-testid="table-filtered-empty"]')).toBeNull()
  })

  /** The distinction most tables get wrong: "no data" reads as broken when the truth is "you have a chip selected". */
  it('filtered-empty is a different state, and it names the filters', () => {
    const dom = render({
      page: { ...page, rows: [], total: 0 },
      query: { ...query, filters: { source: ['gitlab'] } },
    })
    const state = dom.querySelector('[data-testid="table-filtered-empty"]')
    expect(state).not.toBeNull()
    expect(state?.textContent).toContain('gitlab')
    expect(dom.querySelector('[data-testid="table-blank"]')).toBeNull()
  })

  it('error keeps the loaded rows visible and offers retry', () => {
    const onRetry = vi.fn()
    const dom = render({ status: 'error', error: { message: 'Could not load page 2', onRetry } })
    expect(dom.querySelector('[data-testid="result-r1"]')).not.toBeNull()
    expect(dom.querySelector('[data-testid="table-error"]')?.textContent).toContain('Could not load page 2')

    act(() => { (dom.querySelector('[data-testid="table-error-retry"]') as HTMLButtonElement).click() })
    expect(onRetry).toHaveBeenCalled()
  })
})

describe('selection honesty', () => {
  it('labels the header checkbox for what it selects', () => {
    const dom = render({ selectable: true })
    const checkbox = dom.querySelector('[data-testid="table-select-loaded"]')
    expect(checkbox?.getAttribute('aria-label')).toBe('Select loaded rows')
  })

  /** Offering it without an implementation is how "select all" comes to mean "select these 50". */
  it('hides "select all matching" when the surface did not implement it', () => {
    const dom = render({ selectable: true })
    act(() => { (dom.querySelector('[data-testid="table-select-loaded"]') as HTMLElement).click() })
    expect(dom.querySelector('[data-testid="table-selection-count"]')?.textContent).toContain('3 selected')
    expect(dom.querySelector('[data-testid="table-select-all-matching"]')).toBeNull()
  })

  it('offers it, with the matching count, when the surface did', () => {
    const dom = render({ selectable: true, selectAllMatching: async () => ({ count: 214, token: 't' }) })
    act(() => { (dom.querySelector('[data-testid="table-select-loaded"]') as HTMLElement).click() })
    expect(dom.querySelector('[data-testid="table-select-all-matching"]')?.textContent).toContain('214')
  })
})

describe('the toolbar', () => {
  it('shows facet chips carrying the server\'s counts', () => {
    const dom = render()
    expect(dom.querySelector('[data-testid="table-facet-source-github"]')?.textContent).toContain('140')
    expect(dom.querySelector('[data-testid="table-facet-source-gitlab"]')?.textContent).toContain('74')
  })

  it('sorting a column asks the surface for a new query rather than reordering locally', () => {
    const onQueryChange = vi.fn()
    const dom = render({ onQueryChange })
    act(() => { (dom.querySelector('[data-testid="table-sort-score"]') as HTMLButtonElement).click() })
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ sort: [{ id: 'score', dir: 'asc' }] }))
  })

  /** Third press clears: "no sort" is a state the URL can express, and hiding it makes the default order unreachable. */
  it('cycles ascending, descending, none', () => {
    const onQueryChange = vi.fn()
    render({ onQueryChange, query: { ...query, sort: [{ id: 'score', dir: 'desc' }] } })
    act(() => { (container!.querySelector('[data-testid="table-sort-score"]') as HTMLButtonElement).click() })
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ sort: [] }))
  })

  it('hides a column when its visibility is toggled off', () => {
    const dom = render()
    act(() => { (dom.querySelector('[data-testid="table-columns-toggle"]') as HTMLButtonElement).click() })
    act(() => { (dom.querySelector('[data-testid="table-column-score"]') as HTMLInputElement).click() })

    const headers = [...dom.querySelectorAll('[role="columnheader"]')].map((header) => header.textContent)
    expect(headers.some((text) => text?.includes('Score'))).toBe(false)
    expect(headers.some((text) => text?.includes('Source'))).toBe(true)
  })
})

describe('page size', () => {
  it('is the shared constant, not a literal in this component', () => {
    expect(TABLE_PAGE_SIZE).toBe(50)
  })
})
