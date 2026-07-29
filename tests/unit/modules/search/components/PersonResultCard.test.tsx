// PersonResultCard — slot rendering.
//
// Verifies that the optional `actions` slot renders between the
// score ring and the View link, so the alerts inbox / search results /
// builder profile can drop in an "Add to list" / "Track" button
// without changing this component's signature for everyone else.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PersonResultCard, type PersonCardData } from '~/modules/search/components/PersonResultCard'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const builder: PersonCardData = {
  id: 'b-1',
  username: 'octocat',
  displayName: 'Octo Cat',
  source: 'github',
  profileUrl: 'https://github.com/octocat',
}

let host: HTMLDivElement
let root: Root
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(actions: React.ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(<PersonResultCard builder={builder} actions={actions} />)
  })
  return host
}

describe('PersonResultCard', () => {
  it('renders without an actions slot (backwards-compatible)', () => {
    const host = render(undefined)
    const card = host.querySelector('[data-testid="person-card-b-1"]')
    expect(card).toBeTruthy()
    expect(host.querySelector('[data-testid="add-to-list"]')).toBeNull()
  })

  it('renders the actions slot when provided', () => {
    const host = render(
      <button type="button" data-testid="add-to-list">Add to list</button>,
    )
    const card = host.querySelector('[data-testid="person-card-b-1"]')
    expect(card).toBeTruthy()
    expect(host.querySelector('[data-testid="add-to-list"]')).toBeTruthy()
  })
})
