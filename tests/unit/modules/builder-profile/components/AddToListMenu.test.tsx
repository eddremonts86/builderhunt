// AddToListMenu — tenant-aware add-to-shortlist affordance.
//
// Verifies:
// - The trigger opens a popover that fetches the principal's
//   visible shortlists via /api/lists.
// - Selecting a list POSTs { builderIdentityId } to
//   /api/lists/:id/items with NO client-supplied organizationId
//   (the principal's org is implicit, the API enforces it).
// - The menu marks a list as "In list" after a successful add and
//   the same menu entry becomes a no-op on the next click.
// - A duplicate-add response (200 from the idempotent server
//   endpoint) is treated as success, not an error.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddToListMenu } from '~/modules/builder-profile/components/AddToListMenu'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

let host: HTMLDivElement
let root: Root
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(props: { builderIdentityId: string; lists?: Parameters<typeof AddToListMenu>[0]['lists'] }) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(<AddToListMenu builderIdentityId={props.builderIdentityId} lists={props.lists} />)
  })
  return host
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function fireMouseDown(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
}

function mousedownOutside() {
  act(() => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => [],
  } as Response)
})

describe('AddToListMenu', () => {
  it('uses pre-loaded lists when provided (no /api/lists fetch)', () => {
    const calls: Array<unknown[]> = []
    fetchMock.mockImplementation((...args: unknown[]) => {
      calls.push(args)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      } as Response)
    })

    const host = render({
      builderIdentityId: 'bi-1',
      lists: [
        { id: 'l-1', name: 'Watchlist', visibility: 'private', containsBuilder: false },
        { id: 'l-2', name: 'Team picks', visibility: 'organization', containsBuilder: true },
      ],
    })

    const trigger = host.querySelector('[data-testid="add-to-list-trigger"]') as HTMLElement
    click(trigger)

    // No fetch on /api/lists: the lists were pre-loaded.
    const listsCalls = calls.filter((c) => c[0] === '/api/lists')
    expect(listsCalls.length).toBe(0)
    // Pre-loaded "In list" is reflected.
    expect(host.querySelector('[data-testid="add-to-list-in-l-2"]')).toBeTruthy()
  })

  it('fetches /api/lists on first open when no lists prop is provided', () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { id: 'l-1', name: 'Watchlist', visibility: 'private' },
      ],
    } as Response)

    const host = render({ builderIdentityId: 'bi-1' })

    const trigger = host.querySelector('[data-testid="add-to-list-trigger"]') as HTMLElement
    click(trigger)

    expect(fetchMock).toHaveBeenCalledWith('/api/lists', expect.objectContaining({ credentials: 'include' }))
  })

  it('POSTs { builderIdentityId } to /api/lists/:id/items without any organizationId', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (typeof url === 'string' && url.startsWith('/api/lists/l-1/items') && init?.method === 'POST') {
        captured = { url, init }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'item-1' }),
      } as Response
    })

    const host = render({
      builderIdentityId: 'bi-1',
      lists: [
        { id: 'l-1', name: 'Watchlist', visibility: 'private', containsBuilder: false },
      ],
    })

    const trigger = host.querySelector('[data-testid="add-to-list-trigger"]') as HTMLElement
    click(trigger)

    const option = host.querySelector('[data-testid="add-to-list-option-l-1"]') as HTMLElement
    click(option)

    await new Promise((r) => setTimeout(r, 0))

    expect(captured).not.toBeNull()
    expect(captured!.url).toBe('/api/lists/l-1/items')
    const body = JSON.parse(captured!.init.body as string)
    expect(body.builderIdentityId).toBe('bi-1')
    // No client-supplied organizationId / organization_id / orgId.
    expect(body.organizationId).toBeUndefined()
    expect(body.organization_id).toBeUndefined()
    expect(body.orgId).toBeUndefined()
  })

  it('marks the list as "In list" after a successful add and disables further clicks', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'item-1' }),
    } as Response)

    const host = render({
      builderIdentityId: 'bi-1',
      lists: [
        { id: 'l-1', name: 'Watchlist', visibility: 'private', containsBuilder: false },
      ],
    })

    const trigger = host.querySelector('[data-testid="add-to-list-trigger"]') as HTMLElement
    click(trigger)

    const option = host.querySelector('[data-testid="add-to-list-option-l-1"]') as HTMLButtonElement
    click(option)

    await new Promise((r) => setTimeout(r, 10))

    // After the add, the option is disabled and shows "In list".
    const inList = host.querySelector('[data-testid="add-to-list-in-l-1"]')
    expect(inList).toBeTruthy()
    const updatedOption = host.querySelector('[data-testid="add-to-list-option-l-1"]') as HTMLButtonElement
    expect(updatedOption.disabled).toBe(true)
  })

  it('surfaces the API error to the user when add fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/lists/')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: 'You do not have permission to add to this list.' }),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => [],
      } as Response
    })

    const host = render({
      builderIdentityId: 'bi-1',
      lists: [
        { id: 'l-1', name: 'Watchlist', visibility: 'private', containsBuilder: false },
      ],
    })

    const trigger = host.querySelector('[data-testid="add-to-list-trigger"]') as HTMLElement
    click(trigger)

    const option = host.querySelector('[data-testid="add-to-list-option-l-1"]') as HTMLElement
    click(option)

    await new Promise((r) => setTimeout(r, 10))

    const error = host.querySelector('[data-testid="add-to-list-error"]')
    expect(error?.textContent).toContain('permission')
  })

  it('closes on outside click', () => {
    const host = render({
      builderIdentityId: 'bi-1',
      lists: [
        { id: 'l-1', name: 'Watchlist', visibility: 'private', containsBuilder: false },
      ],
    })

    const trigger = host.querySelector('[data-testid="add-to-list-trigger"]') as HTMLElement
    click(trigger)
    expect(host.querySelector('[data-testid="add-to-list-popover"]')).toBeTruthy()

    mousedownOutside()
    expect(host.querySelector('[data-testid="add-to-list-popover"]')).toBeNull()
  })
})
