import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HydrationSignal, HYDRATED_ATTRIBUTE } from './HydrationSignal'

// No @testing-library/react in this codebase yet — mount directly with
// react-dom/client + act, the same primitives testing-library wraps
// (matches the existing TenantQueryProvider.test.tsx pattern).
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
  // Never leak the marker between tests — each test asserts from a clean slate.
  document.documentElement.removeAttribute(HYDRATED_ATTRIBUTE)
})

function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
}

describe('HydrationSignal', () => {
  it('does not mark the document before React mounts it', () => {
    expect(document.documentElement.hasAttribute(HYDRATED_ATTRIBUTE)).toBe(false)
  })

  it('marks the document root once mounted (i.e. after hydration effects flush)', () => {
    mount(<HydrationSignal />)
    expect(document.documentElement.getAttribute(HYDRATED_ATTRIBUTE)).toBe('true')
  })

  it('removes the marker on unmount so a torn-down React tree cannot look hydrated', () => {
    mount(<HydrationSignal />)
    act(() => root!.unmount())
    root = null
    expect(document.documentElement.hasAttribute(HYDRATED_ATTRIBUTE)).toBe(false)
  })

  it('renders no visible DOM of its own', () => {
    mount(<HydrationSignal />)
    expect(container!.innerHTML).toBe('')
  })
})
