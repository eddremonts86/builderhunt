// SavedQueryVisibilityBadge — minimal rendering suite.
//
// The badge is a one-state-per-prop component; the security-meaningful
// behaviour is "private" must never render as Team and vice versa, and
// the data-visibility attribute must reflect the prop so e2e / css
// tests can target it deterministically.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SavedQueryVisibilityBadge } from '~/modules/dashboard/components/SavedQueryVisibilityBadge'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let host: HTMLDivElement
let root: Root
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function renderBadge(visibility: 'private' | 'organization') {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(<SavedQueryVisibilityBadge visibility={visibility} />)
  })
  return host
}

describe('SavedQueryVisibilityBadge', () => {
  it('renders "Private" for visibility=private and exposes data-visibility=private', () => {
    const host = renderBadge('private')
    const badge = host.querySelector('[data-testid="saved-query-visibility-badge"]')
    expect(badge?.textContent).toContain('Private')
    expect(badge?.getAttribute('data-visibility')).toBe('private')
  })

  it('renders "Team" for visibility=organization and exposes data-visibility=organization', () => {
    const host = renderBadge('organization')
    const badge = host.querySelector('[data-testid="saved-query-visibility-badge"]')
    expect(badge?.textContent).toContain('Team')
    expect(badge?.getAttribute('data-visibility')).toBe('organization')
  })
})
