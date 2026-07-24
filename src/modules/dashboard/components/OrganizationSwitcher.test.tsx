import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { TenantQueryProvider } from '~/shared/components/TenantQueryProvider'
import { OrganizationSwitcher } from './OrganizationSwitcher'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const organizations = [
  { id: 'org-a', name: 'Acme', slug: 'acme', role: 'owner' as const, isPersonal: false },
  { id: 'org-b', name: 'Personal workspace', slug: 'personal-org-b', role: 'owner' as const, isPersonal: true },
]

const memberOrganizations = [
  { id: 'org-a', name: 'Acme', slug: 'acme', role: 'member' as const, isPersonal: false },
]

type OrganizationFixture = typeof organizations[number] | typeof memberOrganizations[number]

let container: HTMLDivElement | null = null
let root: Root | null = null
let fetchMock: ReturnType<typeof vi.fn>
let switchShouldFail = false
let organizationsResponse: OrganizationFixture[] = organizations

beforeEach(() => {
  switchShouldFail = false
  organizationsResponse = organizations
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/organizations') && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify(organizationsResponse), { status: 200 })
    }
    if (url.endsWith('/api/organizations') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'org-new', name: 'New Team', slug: 'new-team-abc123' }), { status: 200 })
    }
    if (url.endsWith('/api/organizations/switch')) {
      if (switchShouldFail) return new Response(JSON.stringify({ error: 'Membership no longer active' }), { status: 403 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
})

async function mount(activeOrganizationId: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <TenantQueryProvider activeOrganizationId={activeOrganizationId}>
        <OrganizationSwitcher />
      </TenantQueryProvider>
    ),
  })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
  // Let the organizations query resolve.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('OrganizationSwitcher', () => {
  it('shows the active organization name on the trigger', async () => {
    await mount('org-a')
    const trigger = container!.querySelector('button[aria-label="Switch organization"]')
    expect(trigger?.textContent).toContain('Acme')
  })

  it('lists every organization when opened, with the active one checked', async () => {
    await mount('org-a')
    const trigger = container!.querySelector('button[aria-label="Switch organization"]') as HTMLButtonElement
    act(() => trigger.click())

    const items = document.querySelectorAll('[role="menuitemradio"]')
    expect(items).toHaveLength(2)
    const activeItem = Array.from(items).find((el) => el.textContent?.includes('Acme'))
    expect(activeItem?.getAttribute('aria-checked')).toBe('true')
  })

  it('calls the switch endpoint with the selected organization id, never a client-invented one', async () => {
    await mount('org-a')
    const trigger = container!.querySelector('button[aria-label="Switch organization"]') as HTMLButtonElement
    act(() => trigger.click())

    const items = document.querySelectorAll('[role="menuitemradio"]')
    const otherItem = Array.from(items).find((el) => el.textContent?.includes('Personal workspace')) as HTMLButtonElement
    await act(async () => {
      otherItem.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const switchCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/organizations/switch'))
    expect(switchCall).toBeDefined()
    const body = JSON.parse((switchCall![1] as RequestInit).body as string)
    expect(body).toEqual({ organizationId: 'org-b' })
  })

  it('creates a team with the typed name, then switches to it', async () => {
    await mount('org-a')
    const trigger = container!.querySelector('button[aria-label="Switch organization"]') as HTMLButtonElement
    act(() => trigger.click())

    const createTrigger = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Create team')) as HTMLButtonElement
    expect(createTrigger).toBeDefined()
    act(() => createTrigger.click())

    const nameInput = document.querySelector('input[aria-label="New team name"]') as HTMLInputElement
    const submitButton = document.querySelector('button[aria-label="Create team"]') as HTMLButtonElement
    // React tracks controlled-input values on the instance to distinguish
    // real input events from programmatic `.value =` assignments — setting
    // through the prototype's native setter (bypassing that tracker) is
    // required for the subsequent 'input' event to actually reach onChange.
    const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeValueSetter.call(nameInput, 'New Team')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      submitButton.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith('/api/organizations') && (init as RequestInit)?.method === 'POST',
    )
    expect(createCall).toBeDefined()
    expect(JSON.parse((createCall![1] as RequestInit).body as string)).toEqual({ name: 'New Team' })

    const switchCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/organizations/switch'))
    expect(switchCall).toBeDefined()
    expect(JSON.parse((switchCall![1] as RequestInit).body as string)).toEqual({ organizationId: 'org-new' })
  })

  it('renders nothing when the caller belongs to zero organizations', async () => {
    organizationsResponse = []
    await mount('org-a')
    expect(container!.querySelector('button[aria-label="Switch organization"]')).toBeNull()
  })

  it('surfaces a real switch failure without changing the active organization', async () => {
    switchShouldFail = true
    await mount('org-a')
    const trigger = container!.querySelector('button[aria-label="Switch organization"]') as HTMLButtonElement
    act(() => trigger.click())

    const items = document.querySelectorAll('[role="menuitemradio"]')
    const otherItem = Array.from(items).find((el) => el.textContent?.includes('Personal workspace')) as HTMLButtonElement
    await act(async () => {
      otherItem.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Membership no longer active')
    // The panel is still open (never closed on failure) and the trigger still shows the ORIGINAL
    // active org — a failed switch must never look like it silently succeeded.
    expect(trigger.textContent).toContain('Acme')
  })

  it('falls back to a neutral label when the active organization is no longer in the caller\'s membership list (e.g. just removed)', async () => {
    // Simulates the active org having been removed from under the user between session-read and
    // this fetch — a real, if rare, race (membership revoked mid-session).
    await mount('org-removed')
    const trigger = container!.querySelector('button[aria-label="Switch organization"]') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.textContent).toContain('Select organization')
  })

  it('closes the open panel on Escape (keyboard operation)', async () => {
    await mount('org-a')
    const trigger = container!.querySelector('button[aria-label="Switch organization"]') as HTMLButtonElement
    act(() => trigger.click())
    expect(document.querySelector('[role="menu"]')).not.toBeNull()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('shows a "manage" link only for owner/admin organizations, never for a plain member', async () => {
    organizationsResponse = memberOrganizations
    await mount('org-a')
    const trigger = container!.querySelector('button[aria-label="Switch organization"]') as HTMLButtonElement
    act(() => trigger.click())

    expect(document.querySelector('button[aria-label="Manage Acme"]')).toBeNull()
  })

  it('switching to manage a non-active organization switches into it first, then navigates to team settings', async () => {
    await mount('org-a')
    const trigger = container!.querySelector('button[aria-label="Switch organization"]') as HTMLButtonElement
    act(() => trigger.click())

    const manageButton = document.querySelector('button[aria-label="Manage Personal workspace"]') as HTMLButtonElement
    expect(manageButton).not.toBeNull()
    await act(async () => {
      manageButton.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const switchCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/organizations/switch'))
    expect(switchCall).toBeDefined()
    expect(JSON.parse((switchCall![1] as RequestInit).body as string)).toEqual({ organizationId: 'org-b' })
  })
})
