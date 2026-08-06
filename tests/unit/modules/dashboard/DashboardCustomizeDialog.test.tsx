import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DashboardCustomizeDialog, type CustomizableWidget } from '~/modules/dashboard/components/DashboardCustomizeDialog'

/**
 * plans/ui-dashboard Wave 6, "Build accessible dashboard customization controls" — verify line:
 * "keyboard/touch/screen-reader flows pass".
 *
 * The three assertions that carry weight are all about what a *non-visual* user gets: that a critical
 * widget is present-and-explained rather than quietly absent, that every switch is named after its
 * widget rather than being the fourteenth "Switch", and that the density choice is a radio group
 * rather than two buttons that look like one. None of those are visible in a screenshot, and all
 * three are the difference between a usable dialog and a decorative one.
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

const WIDGETS: CustomizableWidget[] = [
  { id: 'action-queue', title: 'Needs your attention', criticality: 'critical' },
  { id: 'activity', title: 'Builder recency', criticality: 'standard' },
  { id: 'source-mix', title: 'Source coverage', criticality: 'standard' },
]

interface Handlers {
  onToggleHidden?: (id: string) => void
  onDensityChange?: (density: 'bento' | 'sections') => void
  onReset?: () => void
  onClose?: () => void
}

function render(hiddenWidgetIds: string[] = [], handlers: Handlers = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <DashboardCustomizeDialog
        open
        onClose={handlers.onClose ?? (() => {})}
        widgets={WIDGETS}
        hiddenWidgetIds={hiddenWidgetIds}
        density="bento"
        onToggleHidden={handlers.onToggleHidden ?? (() => {})}
        onDensityChange={handlers.onDensityChange ?? (() => {})}
        onReset={handlers.onReset ?? (() => {})}
      />,
    )
  })
  // Radix portals the content outside the container.
  return document.body
}

describe('DashboardCustomizeDialog', () => {
  it('lists a critical widget, disabled and explained, rather than omitting it', () => {
    /*
     * Omitting it would be the easy implementation and the wrong one: a user who cannot find
     * "Needs your attention" among the toggles concludes the dialog is incomplete, where one who
     * finds it locked with a reason learns the rule.
     */
    const body = render()
    expect(body.textContent).toContain('Needs your attention')
    expect(body.textContent).toContain('Always shown')

    // And there is no control for it — the rule lives in `orderedWidgets`, so offering a switch here
    // would offer an action that silently does nothing.
    const criticalSwitch = body.querySelector('[aria-label="Show Needs your attention"]')
    expect(criticalSwitch).toBeNull()
  })

  it('names every switch after its widget', () => {
    // "Switch" repeated fourteen times is not a list anyone can navigate by voice or by rotor.
    const body = render()
    expect(body.querySelector('[aria-label="Show Builder recency"]')).not.toBeNull()
    expect(body.querySelector('[aria-label="Show Source coverage"]')).not.toBeNull()
  })

  it('reflects a hidden widget as off rather than absent', () => {
    const body = render(['source-mix'])
    const control = body.querySelector('[aria-label="Show Source coverage"]')
    expect(control?.getAttribute('data-state')).toBe('unchecked')
    // Still listed: a hidden widget the user cannot find is a widget they cannot restore.
    expect(body.textContent).toContain('Source coverage')
  })

  it('applies a toggle immediately, with no Save step', () => {
    // No form, so no unsaved state to lose and no way for the dialog and the page behind it to
    // disagree about what the layout is.
    const onToggleHidden = vi.fn()
    const body = render([], { onToggleHidden })
    const control = body.querySelector('[aria-label="Show Builder recency"]') as HTMLElement
    act(() => { control.click() })
    expect(onToggleHidden).toHaveBeenCalledWith('activity')

    expect(body.textContent).not.toMatch(/\bSave\b/)
  })

  it('offers density as a radio group, not as two buttons that look like one', () => {
    // Two mutually exclusive options with a shared name are what a screen reader announces as
    // "1 of 2" and what arrow keys move between.
    const body = render()
    const group = body.querySelector('[role="radiogroup"]')
    expect(group).not.toBeNull()
    expect(group?.querySelectorAll('input[type="radio"]')).toHaveLength(2)
    expect(group?.getAttribute('aria-labelledby')).toBeTruthy()
  })

  it('changes density through the same store as everything else', () => {
    const onDensityChange = vi.fn()
    const body = render([], { onDensityChange })
    const sections = Array.from(body.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
      .find((input) => input.value === 'sections')
    act(() => { sections!.click() })
    expect(onDensityChange).toHaveBeenCalledWith('sections')
  })

  it('offers a reset', () => {
    const onReset = vi.fn()
    const body = render(['source-mix'], { onReset })
    const button = Array.from(body.querySelectorAll('button')).find((element) => /reset/i.test(element.textContent ?? ''))
    act(() => { button!.click() })
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
