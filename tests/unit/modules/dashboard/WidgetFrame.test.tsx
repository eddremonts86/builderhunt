import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WidgetFrame } from '~/modules/dashboard/ui/WidgetFrame'
import type { WidgetState } from '~/modules/dashboard/lib/contracts'

/**
 * plans/ui-dashboard Wave 0, "Distinguish every widget state" — verify line: "component snapshots and
 * accessibility tests cover every state; forbidden omits capability details and unavailable never
 * reveals secret/config values."
 *
 * The assertion that matters most is the negative one. This dashboard's failure mode has never been a
 * crash; it is a caught error rendered as an empty list, so a broken endpoint reads as a calm
 * workspace. Two tests below therefore check that the *empty* copy is absent from the error and
 * unavailable states, which is the specific confusion the whole state union exists to prevent.
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

interface Row { id: string }

function render(state: WidgetState<Row[]>, props: { onRetry?: () => void } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <WidgetFrame<Row[]>
        title="Alerts"
        state={state}
        emptyMessage="No alerts yet."
        onRetry={props.onRetry}
      >
        {(rows) => <ul>{rows.map((row) => <li key={row.id}>{row.id}</li>)}</ul>}
      </WidgetFrame>,
    )
  })
  return container!
}

const ROWS: Row[] = [{ id: 'alpha' }, { id: 'beta' }]
const GENERATED_AT = '2027-03-01T10:00:00.000Z'

describe('WidgetFrame', () => {
  it('renders the body only for states that carry data', () => {
    for (const state of [
      { kind: 'ready', data: ROWS, generatedAt: GENERATED_AT },
      { kind: 'stale', data: ROWS, generatedAt: GENERATED_AT, reason: 'cache' },
      { kind: 'partial', data: ROWS, generatedAt: GENERATED_AT, missing: ['sprints'] },
    ] as Array<WidgetState<Row[]>>) {
      const node = render(state)
      expect(node.textContent, state.kind).toContain('alpha')
      if (root) act(() => root!.unmount())
      container?.remove()
      root = null
      container = null
    }
  })

  it('shows a spinner and a named loading message while loading', () => {
    const node = render({ kind: 'loading' })
    expect(node.querySelector('[role="status"]')?.textContent).toContain('Loading alerts')
    expect(node.textContent).not.toContain('alpha')
  })

  it('offers the empty message only when the query genuinely returned nothing', () => {
    const node = render({ kind: 'empty' })
    expect(node.textContent).toContain('No alerts yet.')
  })

  it('never renders the empty copy for a failure', () => {
    // The regression this exists for: a caught fetch error became `[]` and every widget rendered its
    // "nothing here yet" state, so a broken endpoint and a quiet workspace were indistinguishable.
    const errored = render({ kind: 'error', retryable: true })
    expect(errored.textContent).not.toContain('No alerts yet.')
    expect(errored.textContent).toContain('could not be loaded')

    if (root) act(() => root!.unmount())
    container?.remove()
    root = null
    container = null

    const unavailable = render({ kind: 'unavailable', code: 'calendar_disabled' })
    expect(unavailable.textContent).not.toContain('No alerts yet.')
    expect(unavailable.textContent).toContain('unavailable')
  })

  it('offers a retry for a retryable error and calls it', () => {
    const onRetry = vi.fn()
    const node = render({ kind: 'error', retryable: true }, { onRetry })
    const button = Array.from(node.querySelectorAll('button')).find((element) => /try again/i.test(element.textContent ?? ''))
    expect(button).toBeTruthy()
    act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('offers no retry when retrying cannot help', () => {
    const node = render({ kind: 'unavailable', code: 'calendar_disabled' }, { onRetry: () => {} })
    const button = Array.from(node.querySelectorAll('button')).find((element) => /try again/i.test(element.textContent ?? ''))
    expect(button).toBeUndefined()
  })

  it('reveals nothing beyond a short reference code when unavailable', () => {
    // The code is for an operator to grep. Anything longer would eventually carry a hostname, a
    // provider message, or a configuration value.
    const node = render({ kind: 'unavailable', code: 'calendar_disabled' })
    const text = node.textContent ?? ''
    expect(text).toContain('calendar_disabled')
    expect(text).not.toMatch(/https?:\/\//)
    expect(text).not.toMatch(/token|secret|key=/i)
  })

  it('renders absolutely nothing when the role may not see the widget', () => {
    // Not a locked tile and not a title. A placeholder confirms the workspace has the thing and that
    // this person is outside it, which is the disclosure omitting the widget was meant to avoid.
    const node = render({ kind: 'forbidden' })
    expect(node.textContent).toBe('')
    expect(node.querySelector('h3')).toBeNull()
  })

  it('captions stale data with an absolute time, not a relative one', () => {
    // "2 hours ago" is exactly where a stuck projection hides.
    const node = render({ kind: 'stale', data: ROWS, generatedAt: GENERATED_AT, reason: 'cache' })
    const status = node.querySelector('[role="status"]')?.textContent ?? ''
    expect(status).toContain('Showing data as of')
    expect(status).not.toMatch(/ago/)
    expect(status).toMatch(/2027/)
  })

  it('names what is missing from a partial result rather than quietly excluding it', () => {
    const node = render({ kind: 'partial', data: ROWS, generatedAt: GENERATED_AT, missing: ['sprints', 'shortlists'] })
    const text = node.textContent ?? ''
    expect(text).toContain('sprints')
    expect(text).toContain('shortlists')
    expect(text).toContain('Totals exclude')
  })

  it('announces transient states politely rather than as alerts', () => {
    // Seven widgets resolving at once must not fire seven assertive announcements on first paint.
    for (const state of [
      { kind: 'loading' },
      { kind: 'error', retryable: true },
      { kind: 'unavailable', code: 'x' },
    ] as Array<WidgetState<Row[]>>) {
      const node = render(state)
      expect(node.querySelector('[role="alert"]'), state.kind).toBeNull()
      expect(node.querySelector('[role="status"]'), state.kind).not.toBeNull()
      if (root) act(() => root!.unmount())
      container?.remove()
      root = null
      container = null
    }
  })
})
