import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ActionsCell,
  DateCell,
  EmptyCell,
  IdentityCell,
  NumberCell,
  PrimaryCell,
  RatioCell,
  StatusCell,
} from '~/shared/components/table/cells'

/**
 * The nine canonical cells, tested for the things a screenshot cannot show.
 *
 * The visual half of this vocabulary is pinned by `tests/e2e/visual/table-system.spec.ts`. What is
 * here is the half that is invisible and load-bearing: that a date exposes a machine-readable value
 * beside its deliberately-imprecise text, that a truncating cell hands over the complete string,
 * that an empty cell says something rather than being empty, that a status survives greyscale, and
 * that a row's actions can be reached and dismissed from a keyboard.
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
  vi.useRealTimers()
})

function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}

describe('PrimaryCell', () => {
  it('renders the title and the optional metadata line', () => {
    const dom = mount(<PrimaryCell title="Local-first devs" meta="p3-alert-1" />)
    expect(dom.textContent).toContain('Local-first devs')
    expect(dom.querySelector('[data-testid="cell-primary-meta"]')?.textContent).toBe('p3-alert-1')
  })

  it('omits the metadata line entirely rather than rendering an empty one', () => {
    const dom = mount(<PrimaryCell title="Local-first devs" meta="" />)
    expect(dom.querySelector('[data-testid="cell-primary-meta"]')).toBeNull()
  })

  /**
   * The only cell allowed to ellipsize, and the reason it is allowed to: the complete string stays
   * reachable. A cell that clips without this has simply lost the information.
   */
  it('exposes the complete value even though the visible text may be clipped', () => {
    const long = 'A radar name long enough that no column in the app would show all of it at once'
    const dom = mount(<PrimaryCell title={long} />)
    expect(dom.querySelector('.tbl-cell-primary')?.getAttribute('title')).toBe(long)
  })

  /** DESIGN.md:221 keeps mono for literal code and keys; a name in mono reads as copy-pasteable. */
  it('leaves the metadata in the body face unless it is asked for mono', () => {
    expect(mount(<PrimaryCell title="A" meta="reviewed by Ana" />)
      .querySelector('[data-testid="cell-primary-meta"]')?.className).not.toContain('font-mono')
    act(() => root!.unmount())
    container!.remove()
    expect(mount(<PrimaryCell title="A" meta="job:sweep" monoMeta />)
      .querySelector('[data-testid="cell-primary-meta"]')?.className).toContain('font-mono')
  })
})

describe('StatusCell', () => {
  it.each(['success', 'warning', 'danger', 'accent', 'neutral'] as const)('carries the %s tone as data, not as a colour class', (tone) => {
    const dom = mount(<StatusCell label="Active" tone={tone} />)
    expect(dom.querySelector('[data-testid="cell-status"]')?.getAttribute('data-tone')).toBe(tone)
  })

  /** A colour a column author did not choose is a colour that means nothing. */
  it('defaults to neutral', () => {
    expect(mount(<StatusCell label="Queued" />).querySelector('[data-testid="cell-status"]')?.getAttribute('data-tone')).toBe('neutral')
  })

  /**
   * WCAG 1.4.1: the tone is never the only carrier. The state is in words, so the cell survives
   * greyscale, a colour-blind reader and a screen reader alike.
   */
  it('says the state in words as well as in colour', () => {
    expect(mount(<StatusCell label="Refund failed" tone="danger" />).textContent).toContain('Refund failed')
  })

  /** 116px of column and no ellipsis: a half-shown status is a different status. */
  it('does not truncate', () => {
    const chip = mount(<StatusCell label="Awaiting review" />).querySelector('[data-testid="cell-status"]')
    expect(chip?.className).not.toContain('truncate')
  })
})

describe('DateCell', () => {
  it('shows a relative value over an abbreviated absolute one, never a raw ISO string', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T10:00:00Z'))
    const dom = mount(<DateCell value="2026-08-09T10:00:00Z" />)
    expect(dom.querySelector('[data-testid="cell-date-relative"]')?.textContent).toBe('3d ago')
    expect(dom.querySelector('[data-testid="cell-date-absolute"]')?.textContent).toBe('9 Aug 2026')
    expect(dom.textContent).not.toContain('2026-08-09T')
  })

  /**
   * The visible text is deliberately imprecise. Without `datetime` that imprecision would be the
   * only version anything — a screen reader, a scraper, a test — could read.
   */
  it('carries a machine-readable value beside the human one', () => {
    const dom = mount(<DateCell value="2026-08-09T10:00:00Z" />)
    expect(dom.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-09T10:00:00.000Z')
  })

  it('adds the time of day only when asked', () => {
    expect(mount(<DateCell value="2026-08-09T10:00:00Z" withTime />)
      .querySelector('[data-testid="cell-date-absolute"]')?.textContent).toMatch(/9 Aug 2026, \d{2}:\d{2}/)
  })

  /** "Invalid Date" in a cell is a bug report the user cannot file. */
  it.each([null, undefined, '', 'not a date'])('falls back to the empty cell for %s', (value) => {
    const dom = mount(<DateCell value={value as string | null} />)
    expect(dom.querySelector('[data-testid="cell-empty"]')).not.toBeNull()
    expect(dom.textContent).not.toContain('Invalid')
  })

  it('names the absence for a screen reader', () => {
    expect(mount(<DateCell value={null} />).querySelector('.sr-only')?.textContent).toBe('No date')
  })
})

describe('NumberCell', () => {
  it('renders tabular figures and includes the unit', () => {
    const dom = mount(<NumberCell value={1204} unit="ms" />)
    expect(dom.querySelector('[data-testid="cell-number"]')?.textContent).toBe('1,204ms')
    expect(dom.querySelector('[data-testid="cell-number"]')?.className).toContain('tbl-cell-number')
  })

  /** DESIGN.md:221: aligning digits is a job for tabular figures, not for a monospace face. */
  it('does not reach for a monospace face', () => {
    expect(mount(<NumberCell value={7} />).querySelector('[data-testid="cell-number"]')?.className).not.toContain('mono')
  })

  it('shows whole numbers whole', () => {
    expect(mount(<NumberCell value={1204} />).textContent).toBe('1,204')
  })

  it('keeps the requested precision', () => {
    expect(mount(<NumberCell value={0.5} fractionDigits={2} />).textContent).toBe('0.50')
  })

  it.each([null, undefined, NaN])('falls back to the empty cell for %s', (value) => {
    expect(mount(<NumberCell value={value as number | null} />).querySelector('[data-testid="cell-empty"]')).not.toBeNull()
  })
})

describe('RatioCell', () => {
  /**
   * The bar's fill measures 2.79:1 against its track — under SC 1.4.11's 3:1 for a graphical
   * object, and permitted only because the value is *also* text. Drop the number and the cell
   * fails, so this is the assertion that keeps someone from "simplifying" it away.
   */
  it('prints the number as well as drawing the bar', () => {
    const dom = mount(<RatioCell value={0.42} />)
    expect(dom.querySelector('[data-testid="cell-ratio-value"]')?.textContent).toBe('42%')
    expect(dom.querySelector('[data-testid="cell-ratio-fill"]')).not.toBeNull()
  })

  it('gives the bar an accessible name matching the printed value', () => {
    const dom = mount(<RatioCell value={0.42} />)
    expect(dom.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('42%')
  })

  it('accepts an explicit label when a percentage is the wrong words', () => {
    expect(mount(<RatioCell value={0.3} label="12 / 40" />).textContent).toContain('12 / 40')
  })

  it('clamps the bar without lying about the value', () => {
    const dom = mount(<RatioCell value={1.4} />)
    expect((dom.querySelector('[data-testid="cell-ratio-fill"]') as HTMLElement).style.width).toBe('100%')
    expect(dom.querySelector('[data-testid="cell-ratio-value"]')?.textContent).toBe('140%')
  })

  it('falls back to the empty cell rather than drawing a zero-width bar for no data', () => {
    expect(mount(<RatioCell value={null} />).querySelector('[data-testid="cell-empty"]')).not.toBeNull()
  })
})

describe('IdentityCell', () => {
  it('puts the second identifier on a second line rather than in a second column', () => {
    const dom = mount(<IdentityCell name="Ana Ruiz" meta="ana@example.com" />)
    expect(dom.querySelector('[data-testid="cell-identity-meta"]')?.textContent).toBe('ana@example.com')
  })

  /**
   * The name is right beside it in text, so alt text would announce the same person twice — WCAG
   * 1.1.1's own definition of a decorative image.
   */
  it('leaves the avatar out of the accessibility tree', () => {
    const image = mount(<IdentityCell name="Ana Ruiz" avatarUrl="/a.png" />).querySelector('img')
    expect(image?.getAttribute('alt')).toBe('')
  })

  it('falls back to initials, hidden from a screen reader', () => {
    const dom = mount(<IdentityCell name="Ana Ruiz" />)
    const fallback = dom.querySelector('.tbl-avatar-fallback')
    expect(fallback?.textContent).toBe('AR')
    expect(fallback?.getAttribute('aria-hidden')).toBe('true')
  })

  it('handles a single-word name', () => {
    expect(mount(<IdentityCell name="ana" />).querySelector('.tbl-avatar-fallback')?.textContent).toBe('A')
  })
})

describe('EmptyCell', () => {
  /** An empty cell reads as "the table failed to render this"; a dash reads as "there is no value". */
  it('renders a dash for the eye and words for a screen reader', () => {
    const dom = mount(<EmptyCell />)
    expect(dom.querySelector('[aria-hidden="true"]')?.textContent).toBe('—')
    expect(dom.querySelector('.sr-only')?.textContent).toBe('None')
  })

  it('takes a more specific absence when the column has one', () => {
    expect(mount(<EmptyCell label="Never signed in" />).querySelector('.sr-only')?.textContent).toBe('Never signed in')
  })
})

describe('ActionsCell', () => {
  it('shows the one primary action without a menu', () => {
    const dom = mount(<ActionsCell label="Actions for Ana Ruiz" primary={<button type="button">Open</button>} />)
    expect(dom.textContent).toContain('Open')
    expect(dom.querySelector('[data-testid="cell-actions-trigger"]')).toBeNull()
  })

  /** Fifty identically-labelled "More actions" buttons make the column unusable from an element list. */
  it('names the overflow menu for the row it belongs to', () => {
    const dom = mount(<ActionsCell label="Actions for Ana Ruiz" overflow={<button type="button" role="menuitem">Remove</button>} />)
    const trigger = dom.querySelector('[data-testid="cell-actions-trigger"]')
    expect(trigger?.getAttribute('aria-label')).toBe('Actions for Ana Ruiz')
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the menu and marks the trigger expanded', () => {
    const dom = mount(<ActionsCell label="Actions" overflow={<button type="button" role="menuitem">Remove</button>} />)
    act(() => { (dom.querySelector('[data-testid="cell-actions-trigger"]') as HTMLButtonElement).click() })
    expect(dom.querySelector('[data-testid="cell-actions-menu"]')?.getAttribute('role')).toBe('menu')
    expect(dom.querySelector('[data-testid="cell-actions-trigger"]')?.getAttribute('aria-expanded')).toBe('true')
  })

  /**
   * Escape has to put focus back on the trigger. Without that, dismissing the menu drops a keyboard
   * user out of the grid entirely and they restart from the toolbar.
   */
  it('closes on Escape and returns focus to the trigger', () => {
    const dom = mount(<ActionsCell label="Actions" overflow={<button type="button" role="menuitem">Remove</button>} />)
    const trigger = dom.querySelector('[data-testid="cell-actions-trigger"]') as HTMLButtonElement
    act(() => { trigger.click() })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(dom.querySelector('[data-testid="cell-actions-menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('renders nothing but the primary when there is no overflow', () => {
    const dom = mount(<ActionsCell label="Actions" />)
    expect(dom.querySelector('[data-testid="cell-actions"]')?.children.length).toBe(0)
  })
})
