import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { SemanticTable, type SemanticColumn } from '~/shared/components/table'

/**
 * The half of the table system that is a real `<table>`.
 *
 * What is worth asserting here is what native markup buys and a `role="grid"` over divs would have
 * to rebuild by hand: `scope="col"` on every header, `scope="row"` on the cell that is the row's
 * identity, a caption that names the table, and a scroll region a keyboard can reach.
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

interface Plan { feature: string; free: string; pro: string }

const columns: SemanticColumn<Plan>[] = [
  { id: 'feature', header: 'Feature', rowHeader: true, cell: (row) => row.feature },
  { id: 'free', header: 'Free', align: 'center', cell: (row) => row.free },
  { id: 'pro', header: 'Pro', align: 'end', cell: (row) => row.pro },
]

const rows: Plan[] = [
  { feature: 'Saved searches', free: '3', pro: '50' },
  { feature: 'Monthly credits', free: '0', pro: '140' },
]

function render(overrides: Partial<React.ComponentProps<typeof SemanticTable<Plan>>> = {}) {
  return mount(
    <SemanticTable
      caption="What each plan includes, by feature"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.feature}
      {...overrides}
    />,
  )
}

describe('native table semantics', () => {
  it('is a real table, thead and tbody', () => {
    const dom = render()
    expect(dom.querySelector('table')).not.toBeNull()
    expect(dom.querySelector('thead tr th')).not.toBeNull()
    expect(dom.querySelectorAll('tbody tr').length).toBe(2)
  })

  it('scopes every column header', () => {
    const headers = [...render().querySelectorAll('thead th')]
    expect(headers.map((header) => header.getAttribute('scope'))).toEqual(['col', 'col', 'col'])
  })

  /**
   * The reason this primitive exists at all. Without it a screen reader reads the third cell of the
   * second row as "140" and nothing else; with it, "Pro, Monthly credits, 140".
   */
  it('makes the row\'s identity a row header rather than a cell', () => {
    const dom = render()
    const first = dom.querySelectorAll('tbody tr')[0]
    expect(first.querySelector('th')?.getAttribute('scope')).toBe('row')
    expect(first.querySelector('th')?.textContent).toBe('Saved searches')
    // The remaining two are ordinary cells.
    expect(first.querySelectorAll('td').length).toBe(2)
  })

  it('names the table with a caption, hidden by default', () => {
    const caption = render().querySelector('caption')
    expect(caption?.textContent).toBe('What each plan includes, by feature')
    expect(caption?.className).toBe('sr-only')
  })

  it('shows the caption when the surface asks for it', () => {
    expect(render({ captionVisible: true }).querySelector('caption')?.className).toBeFalsy()
  })
})

describe('the scroll region', () => {
  /**
   * A five-column comparison does not fit a phone, so it scrolls inside its own box — never
   * widening the document. A scrollable region reachable only with a mouse is unreachable to a
   * keyboard user (WCAG 2.1.1), which is what `tabIndex` and the named region are for.
   */
  it('is a keyboard-reachable named region owning its own overflow', () => {
    const region = render().querySelector('[data-testid="semantic-table"]')
    expect(region?.getAttribute('role')).toBe('region')
    expect(region?.getAttribute('tabindex')).toBe('0')
    expect(region?.getAttribute('aria-label')).toBe('What each plan includes, by feature')
    expect(region?.className).toContain('tbl-scroll')
  })

  it('reads the same token container as the interactive grid', () => {
    expect(render().querySelector('[data-testid="semantic-table"]')?.className).toContain('tbl-container')
    expect(render().querySelector('table')?.className).toBe('tbl-semantic')
  })

  it('takes layout classes from the surface without letting it restyle the table', () => {
    expect(render({ className: 'mb-8' }).querySelector('[data-testid="semantic-table"]')?.className).toContain('mb-8')
  })
})

describe('alignment', () => {
  it('carries the alignment as data rather than a per-cell class', () => {
    const dom = render()
    const cells = [...dom.querySelectorAll('tbody tr')[0].children]
    expect(cells.map((cell) => cell.getAttribute('data-align'))).toEqual([null, 'center', 'end'])
    // And the header agrees with its column, so the numbers sit under their own label.
    expect([...dom.querySelectorAll('thead th')].map((th) => th.getAttribute('data-align')))
      .toEqual([null, 'center', 'end'])
  })
})

describe('test ids', () => {
  it('forwards a per-row id when the surface supplies one', () => {
    const dom = render({ rowTestId: (row) => `plan-row-${row.free}` })
    expect(dom.querySelector('[data-testid="plan-row-3"]')?.tagName).toBe('TR')
  })

  /** For surfaces whose own specs drove the element by name before this primitive existed. */
  it('forwards an id for the table element itself', () => {
    expect(render({ tableTestId: 'pricing-pack-table' }).querySelector('table')?.getAttribute('data-testid'))
      .toBe('pricing-pack-table')
  })
})
