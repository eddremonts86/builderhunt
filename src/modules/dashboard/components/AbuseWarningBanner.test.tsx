import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AbuseWarningBanner } from './AbuseWarningBanner'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null
let fetchMock: ReturnType<typeof vi.fn>

function statusResponse(stage: string, requiresStepUp: boolean) {
  return new Response(JSON.stringify({ stage, requiresStepUp }), { status: 200 })
}

// React tracks the native input value setter to detect real user input — setting `.value`
// directly leaves its internal tracker out of sync, so the change handler never fires. This
// bypasses the tracker the same way @testing-library/react's `fireEvent` does under the hood.
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  sessionStorage.clear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
})

async function mount() {
  const rootRoute = createRootRoute({ component: () => <AbuseWarningBanner /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('AbuseWarningBanner', () => {
  it('renders nothing at the observe stage', async () => {
    fetchMock = vi.fn(async () => statusResponse('observe', false))
    vi.stubGlobal('fetch', fetchMock)
    await mount()
    expect(document.querySelector('[data-testid="abuse-warning-banner"]')).toBeNull()
    expect(document.querySelector('[data-testid="stepup-dialog"]')).toBeNull()
  })

  it('shows the fairness-framed banner at the warned stage', async () => {
    fetchMock = vi.fn(async () => statusResponse('warned', false))
    vi.stubGlobal('fetch', fetchMock)
    await mount()
    const banner = document.querySelector('[data-testid="abuse-warning-banner"]')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('Just so you know')
  })

  it('dismisses the warned banner for the current stage only, remembered per session', async () => {
    fetchMock = vi.fn(async () => statusResponse('warned', false))
    vi.stubGlobal('fetch', fetchMock)
    await mount()
    const dismiss = document.querySelector<HTMLButtonElement>('[data-testid="abuse-warning-banner-dismiss"]')!
    await act(async () => { dismiss.click() })
    expect(document.querySelector('[data-testid="abuse-warning-banner"]')).toBeNull()
    expect(sessionStorage.getItem('bh_abuse_warning_dismissed_stage')).toBe('warned')
  })

  it('shows the step-up password dialog at the stepup stage when required', async () => {
    fetchMock = vi.fn(async () => statusResponse('stepup', true))
    vi.stubGlobal('fetch', fetchMock)
    await mount()
    expect(document.querySelector('[data-testid="stepup-dialog"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="stepup-password-input"]')).not.toBeNull()
  })

  it('does not show the step-up dialog once already stepped up', async () => {
    fetchMock = vi.fn(async () => statusResponse('stepup', false))
    vi.stubGlobal('fetch', fetchMock)
    await mount()
    expect(document.querySelector('[data-testid="stepup-dialog"]')).toBeNull()
  })

  it('submits the password and re-fetches status on success', async () => {
    let postBody: unknown = null
    fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postBody = JSON.parse(init.body as string)
        return new Response(JSON.stringify({ verified: true }), { status: 200 })
      }
      // First GET reports stepup required; after verifying, the re-fetch reports it's satisfied.
      return statusResponse('stepup', postBody === null)
    })
    vi.stubGlobal('fetch', fetchMock)
    await mount()

    const input = document.querySelector<HTMLInputElement>('[data-testid="stepup-password-input"]')!
    const submit = document.querySelector<HTMLButtonElement>('[data-testid="stepup-submit"]')!
    await act(async () => {
      typeInto(input, 'correct-horse-battery-staple')
    })
    await act(async () => {
      submit.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(postBody).toEqual({ password: 'correct-horse-battery-staple' })
    expect(document.querySelector('[data-testid="stepup-dialog"]')).toBeNull()
  })

  it('shows an error and keeps the dialog open on a failed verification', async () => {
    fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ error: 'Incorrect password' }), { status: 401 })
      return statusResponse('stepup', true)
    })
    vi.stubGlobal('fetch', fetchMock)
    await mount()

    const input = document.querySelector<HTMLInputElement>('[data-testid="stepup-password-input"]')!
    const submit = document.querySelector<HTMLButtonElement>('[data-testid="stepup-submit"]')!
    await act(async () => {
      typeInto(input, 'wrong-password')
    })
    await act(async () => {
      submit.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.querySelector('[data-testid="stepup-dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Incorrect password')
  })

  it('renders nothing at throttled/blocked stages — no UI surface here', async () => {
    for (const stage of ['throttled', 'blocked']) {
      fetchMock = vi.fn(async () => statusResponse(stage, false))
      vi.stubGlobal('fetch', fetchMock)
      await mount()
      expect(document.querySelector('[data-testid="abuse-warning-banner"]')).toBeNull()
      expect(document.querySelector('[data-testid="stepup-dialog"]')).toBeNull()
      if (root) act(() => root!.unmount())
      container?.remove()
      container = null
      root = null
    }
  })
})
