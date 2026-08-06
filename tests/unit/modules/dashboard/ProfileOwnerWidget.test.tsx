import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { ProfileOwnerWidget } from '~/modules/dashboard/components/ProfileOwnerWidget'
import { PROFILE_VIEW_COHORT_FLOOR, type DashboardProfileOwner } from '~/shared/lib/dashboard/contracts'

/**
 * plans/ui-dashboard Wave 5, "Add an optional verified-profile-owner summary".
 *
 * The privacy property this widget exists to hold is enforced on the server — below the floor the
 * count is not in the response at all. What these pin is the half the server cannot: that the page
 * says a rule applied instead of showing a blank, and that the two independent publication states are
 * not collapsed into one.
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

const BASE: DashboardProfileOwner = {
  builderId: 'identity-a',
  directoryPublished: true,
  portfolioPublished: false,
  windowDays: 30,
  viewsInWindow: 42,
}

async function render(profile: Partial<DashboardProfileOwner> = {}) {
  const merged = { ...BASE, ...profile }
  const rootRoute = createRootRoute({ component: () => <ProfileOwnerWidget profile={merged} /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
}

function testId(id: string): Element | null {
  return container!.querySelector(`[data-testid="${id}"]`)
}

describe('ProfileOwnerWidget', () => {
  it('shows the count and the window it covers', async () => {
    await render({ viewsInWindow: 42, windowDays: 30 })

    expect(testId('profile-owner-views')?.textContent).toBe('42')
    expect(container!.textContent).toContain('last 30 days')
  })

  /**
   * The number is absent from the response, not hidden by the page. What matters here is that the
   * page says a threshold applied: an owner who saw a blank would think the feature was broken, and
   * one who sees "fewer than 5" knows to go to `/me` for the detail.
   */
  it('names the floor rather than rendering a blank when there were too few views', async () => {
    await render({ viewsInWindow: null })

    expect(testId('profile-owner-views')?.textContent).toBe(`Fewer than ${PROFILE_VIEW_COHORT_FLOOR}`)
    expect(container!.textContent).toContain('too few to summarise')
  })

  /*
   * No test here asserts "the small number does not appear in the DOM". It cannot fail: the component
   * is handed `null`, so there is no number to leak. The guarantee lives where the number is decided —
   * see the repository test for the floor. A DOM assertion would look like coverage of the privacy
   * property while testing that a `null` renders as text.
   */

  /**
   * Directory publication and portfolio publication are independent in this codebase. A profile can
   * be listed publicly with no portfolio, or the reverse; one "Published" line would be wrong for
   * everybody in that position.
   */
  it('reports the two publication states separately', async () => {
    await render({ directoryPublished: true, portfolioPublished: false })

    const publication = testId('profile-owner-publication')?.textContent ?? ''
    expect(publication).toContain('Directory listing')
    expect(publication).toContain('Portfolio')
    expect(publication).toContain('Published')
    expect(publication).toContain('Not published')
  })

  it('invites publishing when neither surface is live, and managing when one is', async () => {
    await render({ directoryPublished: false, portfolioPublished: false })
    expect(testId('profile-owner-manage-link')?.textContent).toBe('Publish your profile')

    await act(async () => root!.unmount())
    container!.remove()

    await render({ directoryPublished: false, portfolioPublished: true })
    expect(testId('profile-owner-manage-link')?.textContent).toBe('Manage profile')
  })

  it('sends the owner to the page that owns the setting, not to a duplicate control here', async () => {
    await render()

    expect((testId('profile-owner-manage-link') as HTMLAnchorElement).getAttribute('href')).toBe('/me')
    // No switches, no window picker — those belong on `/me`.
    expect(container!.querySelectorAll('button')).toHaveLength(0)
  })
})
