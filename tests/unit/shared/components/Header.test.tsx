/**
 * plans/UI/tasks.md Wave 6 "Build responsive public product navigation".
 *
 * The desktop Product/Learn/Trust dropdown groups and the mobile drawer both
 * expose the same destinations (Explore, Pricing, Blog, Changelog, Roadmap,
 * Status, Security) — this proves the link set and hrefs, not the visual
 * layout (that's covered live in `tests/e2e/public-content.spec.ts`).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { Header } from '~/shared/components/Header'

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('~/shared/lib/auth/client', () => ({
  useSession: mocks.useSession,
  signOut: mocks.signOut,
}))

// This test is about the nav's link set, not the theme system — stub it out
// rather than dealing with ThemeProvider's real localStorage dependency.
vi.mock('~/shared/lib/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark' as const, setTheme: vi.fn() }),
}))

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
  vi.clearAllMocks()
})

async function render(path = '/', authed = false) {
  mocks.useSession.mockReturnValue(authed ? { data: { user: { id: 'u1' } } } : { data: null })
  const rootRoute = createRootRoute({ component: () => <Header /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: [path] }) })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
}

function testIdless() {
  return container!
}

describe('Header — public navigation', () => {
  it('exposes Product, Learn, and Trust dropdown triggers', async () => {
    await render()
    const el = testIdless()
    expect(el.textContent).toContain('Product')
    expect(el.textContent).toContain('Learn')
    expect(el.textContent).toContain('Trust')
  })

  it('opens the mobile drawer and lists every non-home destination with correct hrefs', async () => {
    await render('/pricing')
    const trigger = container!.querySelector('[aria-label="Open menu"]') as HTMLButtonElement
    await act(async () => {
      trigger.click()
    })

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()

    const expected: Record<string, string> = {
      Explore: '/explore',
      Pricing: '/pricing',
      Blog: '/blog',
      Changelog: '/changelog',
      Roadmap: '/roadmap',
      Status: '/status',
      Security: '/security',
    }
    for (const [label, href] of Object.entries(expected)) {
      const link = Array.from(dialog!.querySelectorAll('a')).find((a) => a.textContent === label)
      expect(link, `expected a link labeled "${label}"`).toBeTruthy()
      expect(link!.getAttribute('href')).toBe(href)
    }
  })

  it('marks the current route as aria-current="page" in the drawer', async () => {
    await render('/pricing')
    const trigger = container!.querySelector('[aria-label="Open menu"]') as HTMLButtonElement
    await act(async () => {
      trigger.click()
    })
    const dialog = document.querySelector('[role="dialog"]')
    const pricingLink = Array.from(dialog!.querySelectorAll('a')).find((a) => a.textContent === 'Pricing')
    expect(pricingLink!.getAttribute('aria-current')).toBe('page')

    const exploreLink = Array.from(dialog!.querySelectorAll('a')).find((a) => a.textContent === 'Explore')
    expect(exploreLink!.getAttribute('aria-current')).toBeNull()
  })

  it('shows Sign in / Get started in the drawer for an anonymous visitor', async () => {
    await render('/pricing')
    const trigger = container!.querySelector('[aria-label="Open menu"]') as HTMLButtonElement
    await act(async () => {
      trigger.click()
    })
    const dialog = document.querySelector('[role="dialog"]')
    const labels = Array.from(dialog!.querySelectorAll('a')).map((a) => a.textContent)
    expect(labels).toContain('Sign in')
    expect(labels).toContain('Get started')
  })

  it('shows Dashboard / Sign out in the drawer for an authenticated visitor', async () => {
    await render('/pricing', true)
    const trigger = container!.querySelector('[aria-label="Open menu"]') as HTMLButtonElement
    await act(async () => {
      trigger.click()
    })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog!.textContent).toContain('Dashboard')
    expect(dialog!.textContent).toContain('Sign out')
    expect(dialog!.textContent).not.toContain('Get started')
  })
})
