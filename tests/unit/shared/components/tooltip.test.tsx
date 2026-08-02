/**
 * The icon-rail tooltip.
 *
 * Written after the maintainer reported it as unreadable in dark mode. The cause was a token pair that only
 * works in one theme — `bg-bh-text` with a hard-coded `text-white` — so the tests below assert the *pair*, not
 * the rendered colour: a unit test cannot see a computed colour, but it can see that no class hard-codes a
 * light or dark value that the theme will not flip.
 *
 * The measured result in a real browser, both themes, recorded here so the numbers are not lost:
 * label 16.4:1 dark / 17.7:1 light, secondary text 7.0:1 dark / 7.7:1 light.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Tooltip } from '~/shared/components/Tooltip'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  document.querySelectorAll('[role="tooltip"]').forEach((node) => node.remove())
  container = null
  root = null
})

async function mount(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(node) })
}

/** The tooltip portals to `document.body`, so it is never inside `container`. */
const tooltip = () => document.querySelector('[role="tooltip"]')

/**
 * Opens the tooltip through focus rather than hover.
 *
 * React synthesises `onMouseEnter` from delegated `mouseover`/`mouseout`, so a dispatched native `mouseenter`
 * never reaches the handler and every assertion below would fail against a component that works. Focus is the
 * more meaningful path here anyway: the rail is icon-only, so a keyboard user has no other way to learn what an
 * icon is, and both handlers call the same `show`.
 */
async function hover() {
  const anchor = container!.firstElementChild as HTMLElement
  await act(async () => { anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
}

describe('contrast', () => {
  it('never pairs a theme token with a hard-coded colour', async () => {
    /**
     * The exact defect. `--color-bh-text` is near-black in light and near-white in dark, so
     * `bg-bh-text text-white` renders white-on-white the moment the theme flips — which is what shipped, and
     * what a light-mode-only check would never have caught.
     */
    await mount(<Tooltip label="Admin"><button type="button">icon</button></Tooltip>)
    await hover()

    const classes = tooltip()!.className
    expect(classes).not.toContain('bg-bh-text')
    expect(classes).not.toContain('text-white')
    expect(classes).not.toContain('text-black')
  })

  it('uses a token pair that flips together', async () => {
    // `bg-bh-surface` and `text-bh-text` both move with the theme, so the contrast holds in both by
    // construction rather than by having been checked once.
    await mount(<Tooltip label="Admin"><button type="button">icon</button></Tooltip>)
    await hover()
    expect(tooltip()!.className).toContain('bg-bh-surface')
    expect(tooltip()!.className).toContain('text-bh-text')
  })

  it('has an edge, because a surface-coloured tooltip sits on a surface-coloured panel', async () => {
    await mount(<Tooltip label="Admin"><button type="button">icon</button></Tooltip>)
    await hover()
    expect(tooltip()!.className).toContain('border-bh-border')
  })
})

describe('content', () => {
  it('lists what the area contains, not just its own name again', async () => {
    /**
     * The second half of the report. A tooltip reading "Admin" over an icon already labelled Admin tells a user
     * nothing; the question a hover asks is *what is in there*.
     */
    await mount(
      <Tooltip label="Admin" items={['Metrics', 'Sources', 'Refunds']}>
        <button type="button">icon</button>
      </Tooltip>,
    )
    await hover()
    expect(tooltip()!.textContent).toContain('Admin')
    expect(tooltip()!.textContent).toContain('Metrics')
    expect(tooltip()!.textContent).toContain('Refunds')
  })

  it('puts every entry on its own line', async () => {
    /**
     * The first fix joined them with `·` and the maintainer could not read it. These are destinations, scanned
     * for the one you want; a scan needs rows, so each entry is its own block element and none of them is
     * concatenated into a sentence.
     */
    await mount(
      <Tooltip label="Admin" items={['Metrics', 'Sources', 'Refunds']}>
        <button type="button">icon</button>
      </Tooltip>,
    )
    await hover()

    const rows = [...tooltip()!.querySelectorAll('span.block')].filter((node) => node.children.length === 0)
    expect(rows.map((node) => node.textContent)).toEqual(['Admin', 'Metrics', 'Sources', 'Refunds'])
    expect(tooltip()!.textContent).not.toContain('·')
  })

  it('renders the label alone when there is nothing inside to list', async () => {
    // A single-action icon has no contents, and an empty second line would be a visual hiccup for nothing.
    await mount(<Tooltip label="Back to home"><button type="button">icon</button></Tooltip>)
    await hover()
    expect(tooltip()!.textContent).toBe('Back to home')
  })

  it('lets the contents wrap while the label stays on one line', async () => {
    // The label is an identifier and should never break mid-word; the contents are a list and should wrap
    // inside the max width rather than pushing the tooltip off-screen.
    await mount(
      <Tooltip label="Admin" items={['Operations', 'Money', 'Public']}>
        <button type="button">icon</button>
      </Tooltip>,
    )
    await hover()
    expect(tooltip()!.className).toContain('max-w-')
    expect(tooltip()!.className).not.toContain('whitespace-nowrap')
    expect(tooltip()!.querySelector('span')!.className).toContain('whitespace-nowrap')
  })
})

describe('placement', () => {
  it('sits beside a rail icon rather than centred under it', async () => {
    /**
     * The rail is 60px wide, so its icons are ~30px from the left edge of the window. A bottom-centred tooltip
     * 240px wide therefore starts at -90px — half of it off-screen — and covers the icons below it. `right`
     * puts it in the page, where there is room.
     *
     * jsdom reports a zero rect for everything, so what is asserted is the contract that survives that: the
     * box is positioned from measured numbers, with no `translate` doing the placement behind the style's back.
     */
    await mount(
      <Tooltip label="Admin" items={['Metrics', 'Sources']} placement="right">
        <button type="button">icon</button>
      </Tooltip>,
    )
    await hover()
    const style = (tooltip() as HTMLElement).style
    expect(tooltip()!.className).toContain('fixed')
    expect(style.transform).toBe('')
    expect(style.visibility).toBe('visible')
  })
})

describe('behaviour', () => {
  it('opens on focus, not only on hover', async () => {
    // The rail is icon-only, so a keyboard user has no other way to learn what an icon is.
    await mount(<Tooltip label="Admin"><button type="button">icon</button></Tooltip>)
    const anchor = container!.firstElementChild as HTMLElement
    await act(async () => { anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    expect(tooltip()).not.toBeNull()
  })

  it('closes again on blur', async () => {
    await mount(<Tooltip label="Admin"><button type="button">icon</button></Tooltip>)
    const anchor = container!.firstElementChild as HTMLElement
    await act(async () => { anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    await act(async () => { anchor.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(tooltip()).toBeNull()
  })

  it('does not swallow the pointer', async () => {
    // It sits 8px under the icon it describes; a tooltip that captured clicks would make the icon unusable.
    await mount(<Tooltip label="Admin"><button type="button">icon</button></Tooltip>)
    await hover()
    expect(tooltip()!.className).toContain('pointer-events-none')
  })
})
