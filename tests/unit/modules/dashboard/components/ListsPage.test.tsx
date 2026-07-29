// ListsPage — security/UX suite.
//
// Verifies:
// - A private list is rendered with a "Private" badge and the
//   delete button is only shown to the creator.
// - An organization-visible list is rendered with a "Team" badge
//   and the delete button is shown to the creator AND to an admin
//   /owner of the org.
// - A non-creator member of the org CANNOT delete a private list
//   they did not create (the API will also reject; this is the
//   client-side gate).
// - The create form requires a name and offers the two visibility
//   choices (private | organization).
// - Submitting the form POSTs to /api/lists WITHOUT a client-supplied
//   organizationId — the principal's organizationId is implicit.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ListsPage, type BuilderList } from '~/modules/dashboard/components/ListsPage'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function makeList(overrides: Partial<BuilderList> = {}): BuilderList {
  return {
    id: 'l-1',
    organizationId: 'org-1',
    createdByUserId: 'u-1',
    name: 'My list',
    description: null,
    visibility: 'private',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

let host: HTMLDivElement
let root: Root
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function renderLists(props: { initialLists: BuilderList[]; currentUser: { userId: string; role: 'owner' | 'admin' | 'member' } }) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(<ListsPage initialLists={props.initialLists} currentUser={props.currentUser} />)
  })
  return host
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => [],
  } as Response)
})

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function setValue(el: HTMLInputElement, value: string) {
  if (el.type === 'radio') {
    // happy-dom + React: the controlled radio's onChange is bound to
    // a value comparison, so we set the property and dispatch a
    // bubbling change event React's synthetic-event system will pick up.
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')
    proto?.set?.call(el, true)
    act(() => {
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    return
  }
  const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  proto?.set?.call(el, value)
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function submitForm(form: HTMLFormElement) {
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('ListsPage', () => {
  it('renders the empty state when there are no lists', () => {
    const host = renderLists({ initialLists: [], currentUser: { userId: 'u-1', role: 'owner' } })
    expect(host.querySelector('[data-testid="lists-empty"]')).toBeTruthy()
  })

  it('renders a private list with the Private badge and a delete button for the creator', () => {
    const list = makeList({ name: 'My private list', visibility: 'private', createdByUserId: 'u-1' })
    const host = renderLists({ initialLists: [list], currentUser: { userId: 'u-1', role: 'owner' } })

    const badge = host.querySelector(`[data-testid="list-visibility-badge-${list.id}"]`)
    expect(badge?.textContent).toContain('Private')
    expect(host.querySelector(`[data-testid="list-delete-${list.id}"]`)).toBeTruthy()
  })

  it('renders an organization-visible list with the Team badge and a delete button for an admin', () => {
    const list = makeList({
      name: 'Team shortlist',
      visibility: 'organization',
      createdByUserId: 'u-other',
    })
    const host = renderLists({ initialLists: [list], currentUser: { userId: 'u-1', role: 'admin' } })

    const badge = host.querySelector(`[data-testid="list-visibility-badge-${list.id}"]`)
    expect(badge?.textContent).toContain('Team')
    expect(host.querySelector(`[data-testid="list-delete-${list.id}"]`)).toBeTruthy()
  })

  it('hides the delete button for a peer member trying to delete a Team list they did not create', () => {
    const list = makeList({
      name: 'Team shortlist',
      visibility: 'organization',
      createdByUserId: 'u-other',
    })
    const host = renderLists({ initialLists: [list], currentUser: { userId: 'u-1', role: 'member' } })

    expect(host.querySelector(`[data-testid="list-delete-${list.id}"]`)).toBeNull()
  })

  it('hides the delete button for a peer trying to delete another peer\'s private list', () => {
    const list = makeList({
      name: 'Someone else\'s list',
      visibility: 'private',
      createdByUserId: 'u-other',
    })
    const host = renderLists({ initialLists: [list], currentUser: { userId: 'u-1', role: 'owner' } })

    expect(host.querySelector(`[data-testid="list-delete-${list.id}"]`)).toBeNull()
  })

  it('opens the create form when the New shortlist button is clicked', () => {
    const host = renderLists({ initialLists: [], currentUser: { userId: 'u-1', role: 'owner' } })

    const button = host.querySelector('[data-testid="new-list-button"]') as HTMLElement
    click(button)

    expect(host.querySelector('[data-testid="list-create-form"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="list-visibility-private"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="list-visibility-organization"]')).toBeTruthy()
  })

  it('submits a new list without any client-supplied organizationId (the principal\'s org is implicit)', async () => {
    const captured: Array<{ url: string; init: RequestInit }> = []
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      captured.push({ url, init })
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'l-new' }),
      } as Response
    })

    const host = renderLists({ initialLists: [], currentUser: { userId: 'u-1', role: 'owner' } })

    const button = host.querySelector('[data-testid="new-list-button"]') as HTMLElement
    click(button)

    const nameInput = host.querySelector('[data-testid="list-name-input"]') as HTMLInputElement
    setValue(nameInput, 'My new list')

    const descInput = host.querySelector('[data-testid="list-description-input"]') as HTMLInputElement
    setValue(descInput, 'desc')

    const orgRadio = host.querySelector('[data-testid="list-visibility-organization"]') as HTMLInputElement
    click(orgRadio)

    const form = host.querySelector('[data-testid="list-create-form"]') as HTMLFormElement
    submitForm(form)

    await new Promise((r) => setTimeout(r, 0))

    // The first call is the initial GET load; the second is the POST.
    const post = captured.find((c) => c.init.method === 'POST')
    expect(post).toBeTruthy()
    expect(post!.url).toBe('/api/lists')
    const body = JSON.parse(post!.init.body as string)
    expect(body.organizationId).toBeUndefined()
    expect(body.organization_id).toBeUndefined()
    expect(body.orgId).toBeUndefined()
    expect(body).toMatchObject({ name: 'My new list', description: 'desc', visibility: 'organization' })
  })

  it('surfaces the API error to the user when create fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: 'Upgrade to Pro' }),
    } as Response)

    const host = renderLists({ initialLists: [], currentUser: { userId: 'u-1', role: 'owner' } })

    const button = host.querySelector('[data-testid="new-list-button"]') as HTMLElement
    click(button)

    const nameInput = host.querySelector('[data-testid="list-name-input"]') as HTMLInputElement
    setValue(nameInput, 'X')

    const form = host.querySelector('[data-testid="list-create-form"]') as HTMLFormElement
    submitForm(form)

    await new Promise((r) => setTimeout(r, 10))

    const errorEl = host.querySelector('[data-testid="list-form-error"]')
    expect(errorEl?.textContent).toContain('Upgrade to Pro')
  })
})
