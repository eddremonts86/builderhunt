import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { DataTable } from '~/shared/components/table'
import { SEARCH_CARD_ROW_HEIGHT } from '~/shared/components/table/useTableVirtual'
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

describe('the canonical anatomy', () => {
  it('is the table container, not a generic card', () => {
    const dom = render()
    const shell = dom.querySelector('[data-testid="table-container"]')
    expect(shell?.className).toContain('tbl-container')
    // `.card` is 24px-radius with 1.5rem of padding; the reference's table is a 14px-radius clipped
    // surface whose toolbar sits flush against its own edge. Sharing the class is how the toolbar
    // ended up inset from the header rule below it.
    expect(shell?.className).not.toContain('card')
  })

  it.each([['sm', 44], ['md', 52], ['lg', 64]] as const)('inherits %s density as %spx from the container', (density, height) => {
    const shell = render({ density }).querySelector('[data-testid="table-container"]') as HTMLElement
    expect(shell.getAttribute('data-density')).toBe(density)
    // The one place row height crosses from TypeScript into CSS: `ROW_HEIGHT` is what the
    // virtualizer offsets by, so writing it back is what stops painted and computed from drifting.
    expect(shell.style.getPropertyValue('--tbl-row-height')).toBe(`${height}px`)
  })

  it('defaults to md, the reference\'s default density', () => {
    expect(render().querySelector('[data-testid="table-container"]')?.getAttribute('data-density')).toBe('md')
  })

  /** A cell may not choose its own height — see `useTableVirtual.ts`. Density is the container's. */
  it('lets a specialized renderer name its row height without inventing a fourth density', () => {
    const shell = render({ rowHeight: SEARCH_CARD_ROW_HEIGHT }).querySelector('[data-testid="table-container"]') as HTMLElement
    expect(shell.style.getPropertyValue('--tbl-row-height')).toBe('176px')
  })

  it('gives the toolbar, header and rows their token classes and nothing else', () => {
    const dom = render()
    expect(dom.querySelector('[data-testid="table-toolbar"]')?.className).toBe('tbl-toolbar')
    expect(dom.querySelector('[role="row"][aria-rowindex="1"]')?.className).toContain('tbl-header-row')
    expect(dom.querySelector('[data-testid="result-r1"]')?.className).toContain('tbl-row')
  })
})

describe('column kinds and geometry', () => {
  const classified: ColumnDef<Result>[] = [
    { id: 'id', header: 'ID', kind: 'primary', cell: (row) => row.id, priority: 'primary' },
    { id: 'source', header: 'Source', kind: 'status', cell: (row) => row.source, sortable: true },
    { id: 'score', header: 'Score', kind: 'number', cell: (row) => row.score, sortable: true },
  ]

  /**
   * A date, a status or a number sharing the free width with everything else truncates on a narrow
   * screen. Only the primary column flexes; the rest take the reference's fixed tracks.
   */
  it('lays the row out from the column kinds', () => {
    const row = render({ columns: classified }).querySelector('[data-testid="result-r1"]') as HTMLElement
    expect(row.style.gridTemplateColumns)
      .toBe('var(--tbl-col-primary) var(--tbl-col-status) var(--tbl-col-number)')
    expect(row.style.columnGap).toBe('var(--tbl-column-gap)')
  })

  /**
   * Fixed tracks can want more width than a phone has. Every row carries the same floor so they
   * stay in column with each other, and the overflow belongs to `.tbl-scroll`, never the document.
   */
  it('gives every row and the header the same minimum width', () => {
    const dom = render({ columns: classified })
    const header = dom.querySelector('[role="row"][aria-rowindex="1"]') as HTMLElement
    const row = dom.querySelector('[data-testid="result-r1"]') as HTMLElement
    expect(row.style.minWidth).toBe('516px') // 240 + 116 + 88 + 2 gaps x 20 + 2 x 16 padding
    expect(header.style.minWidth).toBe(row.style.minWidth)
  })

  /**
   * The header would still render a clickable control announcing `aria-sort`. Ordering a status
   * column sorts by the internal enum's spelling, which is an order nobody means.
   */
  it('refuses a sort affordance on a status column even when the author asked for one', () => {
    const dom = render({ columns: classified })
    expect(dom.querySelector('[data-testid="table-sort-source"]')).toBeNull()
    const header = [...dom.querySelectorAll('[role="columnheader"]')].find((element) => element.textContent?.includes('Source'))
    expect(header?.getAttribute('aria-sort')).toBeNull()
    // And still offers it where there is a real order.
    expect(dom.querySelector('[data-testid="table-sort-score"]')).not.toBeNull()
  })

  it('leaves unclassified columns on the pre-adoption proportional sizing', () => {
    const row = render().querySelector('[data-testid="result-r1"]') as HTMLElement
    expect(row.style.gridTemplateColumns).toContain('minmax(0,')
    expect(row.style.minWidth).toBe('')
  })
})

describe('row variants', () => {
  /**
   * The reference's danger/degraded and muted/paused rows. Before this the surfaces tinted one cell
   * red, which produced a red *status chip* in a row that otherwise looked healthy.
   */
  it('paints the whole row from the surface\'s tone', () => {
    const dom = render({ rowTone: (row) => (row.id === 'r2' ? 'danger' : row.id === 'r3' ? 'muted' : undefined) })
    expect(dom.querySelector('[data-testid="result-r1"]')?.getAttribute('data-tone')).toBeNull()
    expect(dom.querySelector('[data-testid="result-r2"]')?.getAttribute('data-tone')).toBe('danger')
    expect(dom.querySelector('[data-testid="result-r3"]')?.getAttribute('data-tone')).toBe('muted')
  })

  /** Dimming a row is not a way to disable it: it stays selectable and keyboard-reachable. */
  it('is presentation only', () => {
    const dom = render({ rowTone: () => 'muted', selectable: true })
    const row = dom.querySelector('[data-testid="result-r1"]')
    expect(row?.getAttribute('aria-disabled')).toBeNull()
    expect(dom.querySelector('[data-testid="result-r1-select"]')).not.toBeNull()
  })

  it('marks a selected row as selected, distinctly from a tone', () => {
    const dom = render({ selectable: true })
    act(() => { (dom.querySelector('[data-testid="result-r1-select"]') as HTMLElement).click() })
    expect(dom.querySelector('[data-testid="result-r1"]')?.getAttribute('data-state')).toBe('selected')
  })
})

describe('the footer', () => {
  /**
   * `X of Y`, and never page numbers. Phase 3 replaced offsets with keyset cursors because an
   * offset repeats and drops rows when the set changes between two requests — drawing "1 2 3 … 64"
   * over a cursor API would mean either lying about the buttons or bringing that bug back.
   */
  it('says how much of the set is loaded', () => {
    const dom = render()
    expect(dom.querySelector('[data-testid="table-footer-count"]')?.textContent).toBe('3 of 214')
  })

  it('offers the cursor rather than a page number when there is more', () => {
    const onLoadMore = vi.fn()
    const dom = render({ onLoadMore })
    act(() => { (dom.querySelector('[data-testid="table-footer-more"]') as HTMLButtonElement).click() })
    expect(onLoadMore).toHaveBeenCalled()
    expect(dom.querySelector('[data-testid="table-footer"]')?.textContent).not.toMatch(/\bPage\b|\b1\s+2\s+3\b/)
  })

  it('says what it knows when the total is unknowable', () => {
    const dom = render({ page: { ...page, total: null } })
    expect(dom.querySelector('[data-testid="table-footer-count"]')?.textContent).toBe('3 loaded')
  })

  /** A footer reading "10 of 10" under every settings table is furniture. */
  it('is absent for a small bounded table with no cursor', () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, source: 'github', score: index }))
    const dom = render({ page: { rows, nextCursor: null, total: 6, facets: {} } })
    expect(dom.querySelector('[data-testid="table-footer"]')).toBeNull()
  })

  it('is present once the set is bigger than the page', () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, source: 'github', score: index }))
    const dom = render({ page: { rows, nextCursor: null, total: 40, facets: {} } })
    expect(dom.querySelector('[data-testid="table-footer-count"]')?.textContent).toBe('6 of 40')
  })
})

describe('the selection bar', () => {
  /**
   * It used to be an inline strip between the toolbar and the header, which pushed every row down
   * 40px the moment a checkbox was ticked — the list moved under the cursor selecting it.
   */
  it('floats in a zero-height dock rather than displacing the rows', () => {
    const dom = render({ selectable: true })
    act(() => { (dom.querySelector('[data-testid="table-select-loaded"]') as HTMLElement).click() })
    const bar = dom.querySelector('[data-testid="table-selection-bar"]')
    expect(bar?.parentElement?.className).toBe('tbl-selection-dock')
  })

  it('sits after the grid, so its sticky dock resolves against the bottom of the table', () => {
    const dom = render({ selectable: true })
    act(() => { (dom.querySelector('[data-testid="table-select-loaded"]') as HTMLElement).click() })
    const children = [...(dom.querySelector('[data-testid="table-container"]')?.children ?? [])]
    const grid = children.findIndex((child) => child.getAttribute('role') === 'grid')
    const dock = children.findIndex((child) => child.className === 'tbl-selection-dock')
    expect(dock).toBeGreaterThan(grid)
  })
})

describe('page size', () => {
  it('is the shared constant, not a literal in this component', () => {
    expect(TABLE_PAGE_SIZE).toBe(50)
  })
})

describe('virtualization', () => {
  const manyRows: Result[] = Array.from({ length: 500 }, (_, index) => ({
    id: `v${index}`,
    source: index % 2 === 0 ? 'github' : 'gitlab',
    score: 500 - index,
  }))
  const manyPage: PageResult<Result> = { rows: manyRows, nextCursor: null, total: 500, facets: {} }

  /**
   * Pagination bounds what the database returns. It does not bound what the browser holds:
   * infinite scroll appends, and a minute of scrolling leaves thousands of rows paying for every
   * later render, hover and re-sort.
   */
  it('renders a window, not five hundred rows', () => {
    const dom = render({ page: manyPage, virtualize: true })
    const rendered = dom.querySelectorAll('[data-testid^="result-v"]')
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(100)
  })

  it('still reports the full total, so a screen reader is not told the list is short', () => {
    const dom = render({ page: manyPage, virtualize: true })
    expect(dom.querySelector('[role="grid"]')?.getAttribute('aria-rowcount')).toBe('501')
  })

  /** Announcing "row 3 of 500" for the third row *of the window* is the failure axe cannot see. */
  it('gives each rendered row its absolute index, not its position in the window', () => {
    const dom = render({ page: manyPage, virtualize: true })
    const rendered = [...dom.querySelectorAll('[data-testid^="result-v"]')]
    for (const element of rendered) {
      const id = element.getAttribute('data-testid')!.replace('result-v', '')
      expect(element.getAttribute('aria-rowindex')).toBe(String(Number(id) + 2))
    }
  })

  it('gives the scrolling content the height of the whole list', () => {
    const dom = render({ page: manyPage, virtualize: true })
    expect(dom.querySelector('[data-testid="table-virtual-canvas"]')).not.toBeNull()
  })

  /** Machinery for thirty rows costs more than it saves, and clutters the inspector for every small table. */
  it('is off below the threshold', () => {
    const dom = render()
    expect(dom.querySelector('[data-virtualized]')).toBeNull()
    expect(dom.querySelector('[data-testid="table-virtual-canvas"]')).toBeNull()
    expect(dom.querySelectorAll('[data-testid^="result-r"]').length).toBeGreaterThanOrEqual(3)
  })

  /** The board's lanes scroll horizontally and are individually short — see the spec's recorded decision. */
  it('is never applied to the board renderer', () => {
    const dom = render({ page: manyPage, renderer: 'board', virtualize: true })
    expect(dom.querySelector('[data-virtualized]')).toBeNull()
  })

  it('keeps the focused row mounted after the window scrolls past it', () => {
    const dom = render({ page: manyPage, virtualize: true })
    const grid = dom.querySelector('[role="grid"]') as HTMLElement

    // Move the focus far down the list; the window is still at the top.
    for (let press = 0; press < 30; press += 1) {
      act(() => grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    }

    const focusable = [...dom.querySelectorAll('[role="gridcell"][tabindex="0"]')]
    expect(focusable.length).toBe(1)
    // Without the pin this row would be unmounted and focus would have fallen to <body>.
    expect(focusable[0].closest('[role="row"]')?.getAttribute('aria-rowindex')).toBe('32')
  })
})
