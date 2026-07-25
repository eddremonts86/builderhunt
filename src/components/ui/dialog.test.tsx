import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Dialog } from './dialog'

// No @testing-library/react in this codebase yet — mount directly with
// react-dom/client + act (matches HydrationSignal.test.tsx /
// TenantQueryProvider.test.tsx). Radix's Dialog owns the focus-trap/
// scroll-lock/portal/Escape/focus-restore mechanics itself (well covered
// upstream); these tests only cover BuilderHunt's own integration surface:
// that open state renders into a portal, that `initialFocusRef` is honored,
// and that Escape still invokes `onClose` for the ordinary (dismissible)
// case.
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
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('Dialog', () => {
  it('renders its content into the document (via portal) only while open', async () => {
    mount(
      <Dialog open onClose={() => {}} title="Test dialog">
        <p>Body copy</p>
      </Dialog>,
    )
    await flush()
    expect(document.body.textContent).toContain('Body copy')
    expect(document.body.textContent).toContain('Test dialog')
  })

  it('renders nothing visible when closed', async () => {
    mount(
      <Dialog open={false} onClose={() => {}} title="Test dialog">
        <p>Body copy</p>
      </Dialog>,
    )
    await flush()
    expect(document.body.textContent ?? '').not.toContain('Body copy')
  })

  it('honors initialFocusRef instead of the first focusable element', async () => {
    function Harness() {
      const searchRef = React.useRef<HTMLInputElement>(null)
      return (
        <Dialog open onClose={() => {}} title="Filters" initialFocusRef={searchRef}>
          <button type="button">First in DOM order</button>
          <input ref={searchRef} aria-label="search" />
        </Dialog>
      )
    }
    mount(<Harness />)
    await flush()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('search')
  })

  it('moves focus inside the dialog on open when no initialFocusRef is given', async () => {
    mount(
      <Dialog open onClose={() => {}} title="Default focus">
        <button type="button">Only control</button>
      </Dialog>,
    )
    await flush()
    // Radix's default: focus the dialog content itself (or its first
    // tabbable descendant) — either way, focus must leave document.body.
    expect(document.activeElement).not.toBe(document.body)
  })

  it('calls onClose on Escape for an ordinary (dismissible) dialog', async () => {
    const onClose = vi.fn()
    mount(
      <Dialog open onClose={onClose} title="Dismissible">
        <button type="button">Ok</button>
      </Dialog>,
    )
    await flush()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
