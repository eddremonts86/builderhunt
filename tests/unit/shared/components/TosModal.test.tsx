import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TosModal } from '~/shared/components/TosModal'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null
let fetchMock: ReturnType<typeof vi.fn>

function consentResponse(needsAcceptance: string[]) {
  return new Response(
    JSON.stringify({ userId: 'user-1', consents: {}, required: { tos: 'v2.0' }, needsAcceptance }),
    { status: 200 },
  )
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/consent') && (!init || init.method === undefined)) {
      return consentResponse(['tos'])
    }
    if (url.endsWith('/api/consent') && init?.method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  // Ensure a real, focusable element to assert restoration onto.
  const opener = document.createElement('button')
  opener.textContent = 'opener'
  opener.setAttribute('data-testid', 'opener')
  document.body.appendChild(opener)
  opener.focus()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  document.body.querySelectorAll('[data-testid="opener"]').forEach((el) => el.remove())
  document.body.querySelectorAll('#main-content').forEach((el) => el.remove())
  vi.unstubAllGlobals()
})

async function mount() {
  const rootRoute = createRootRoute({ component: () => <TosModal /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
  // Flush the consent fetch + subsequent state update.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('TosModal (mandatory-consent focus contract)', () => {
  it('renders nothing when the signed-in user has already accepted', async () => {
    fetchMock.mockImplementation(async () => consentResponse([]))
    await mount()
    expect(document.querySelector('[data-testid="tos-modal"]')).toBeNull()
  })

  it('moves initial focus to the Accept control, not the disabled close button', async () => {
    await mount()
    expect(document.activeElement?.getAttribute('data-testid')).toBe('tos-modal-accept')
  })

  it('traps Tab within the panel (wraps last -> first)', async () => {
    await mount()
    const accept = document.querySelector<HTMLElement>('[data-testid="tos-modal-accept"]')!
    accept.focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => {
      document.dispatchEvent(event)
    })
    expect(document.activeElement?.getAttribute('data-testid')).toBe('tos-modal-read')
  })

  it('marks #main-content inert while open and restores it on close', async () => {
    const main = document.createElement('div')
    main.id = 'main-content'
    document.body.appendChild(main)

    await mount()
    expect(main.hasAttribute('inert')).toBe(true)

    fetchMock.mockImplementation(async () => consentResponse([]))
    const acceptButton = document.querySelector<HTMLButtonElement>('[data-testid="tos-modal-accept"]')!
    await act(async () => {
      acceptButton.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(main.hasAttribute('inert')).toBe(false)
  })

  it('restores focus to the previously focused element once accepted', async () => {
    const opener = document.querySelector<HTMLElement>('[data-testid="opener"]')!
    await mount()
    // Initial focus moved to the modal's Accept control, not `opener`.
    expect(document.activeElement).not.toBe(opener)

    fetchMock.mockImplementation(async () => consentResponse([]))
    const acceptButton = document.querySelector<HTMLButtonElement>('[data-testid="tos-modal-accept"]')!
    await act(async () => {
      acceptButton.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(opener)
  })
})
