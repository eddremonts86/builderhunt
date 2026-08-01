// Status page — subscribe form + component health row (plans/UI/tasks.md Wave 4 "Render a real
// status subscription form" and "Make Status render only real health checks").
//
// The full route component pulls in `useSession()` and `Route.useSearch()`, both of which need a
// router/auth provider this test harness doesn't mount (same reason PublicEvidenceCard's sibling
// tests exercise the component directly) — so this exercises the two exported pieces that carry
// the actual behavior: `SubscribeForm` and `ComponentRow`.
//
// Verifies:
// - ComponentRow renders OK/DOWN correctly, with an optional message, under the check's own testid.
// - SubscribeForm: idle → loading → success, and success is IDENTICAL whether the server reports
//   `alreadySubscribed: true` or `false` — an enumeration probe must not be able to tell the two
//   apart from the UI.
// - Rate-limited (429) and generic-error (400/500) responses render distinct, visible states.
// - A network error (fetch rejects) also renders a generic error rather than hanging in "loading".

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComponentRow, SubscribeForm } from '~/routes/_landing/status'

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

beforeEach(() => {
  fetchMock.mockReset()
})

async function renderInto(node: ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
  return host
}

function fill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submit(form: Element) {
  return act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('ComponentRow', () => {
  it('renders OK for a healthy check, with its message', async () => {
    const host = await renderInto(<ComponentRow name="Database" check={{ name: 'db', ok: true, message: '4ms' }} />)
    const row = host.querySelector('[data-testid="status-row-db"]')
    expect(row?.textContent).toContain('OK')
    expect(row?.textContent).toContain('4ms')
    expect(row?.textContent).toContain('Database')
  })

  it('renders DOWN for a failing check', async () => {
    const host = await renderInto(<ComponentRow name="Memory" check={{ name: 'memory', ok: false, message: '1200MB rss — high' }} />)
    const row = host.querySelector('[data-testid="status-row-memory"]')
    expect(row?.textContent).toContain('DOWN')
    expect(row?.textContent).toContain('1200MB rss — high')
  })
})

describe('SubscribeForm', () => {
  it('renders the idle email form', async () => {
    const host = await renderInto(<SubscribeForm />)
    expect(host.querySelector('[data-testid="subscribe-form"]')).toBeTruthy()
    expect(host.querySelector('#status-subscribe-email')).toBeTruthy()
  })

  it('shows the identical success UI for a NEW address (alreadySubscribed: false)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, alreadySubscribed: false }) } as Response)
    const host = await renderInto(<SubscribeForm />)
    fill(host.querySelector('#status-subscribe-email') as HTMLInputElement, 'new@test.invalid')
    await submit(host.querySelector('[data-testid="subscribe-form"]')!)
    expect(host.querySelector('[data-testid="subscribe-success"]')?.textContent).toContain('Check your email')
  })

  it('shows the SAME success UI for a REPEAT address (alreadySubscribed: true) — no enumeration signal', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, alreadySubscribed: true }) } as Response)
    const host = await renderInto(<SubscribeForm />)
    fill(host.querySelector('#status-subscribe-email') as HTMLInputElement, 'existing@test.invalid')
    await submit(host.querySelector('[data-testid="subscribe-form"]')!)
    expect(host.querySelector('[data-testid="subscribe-success"]')?.textContent).toContain('Check your email')
    // Nothing in the rendered output should differ based on alreadySubscribed.
    expect(host.querySelector('[data-testid="subscribe-form"]')).toBeNull()
  })

  it('shows a rate-limited state on 429, distinct from the generic error state', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: 'rate_limited' }) } as Response)
    const host = await renderInto(<SubscribeForm />)
    fill(host.querySelector('#status-subscribe-email') as HTMLInputElement, 'x@test.invalid')
    await submit(host.querySelector('[data-testid="subscribe-form"]')!)
    expect(host.querySelector('[data-testid="subscribe-rate-limited"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="subscribe-error"]')).toBeNull()
    expect(host.querySelector('[data-testid="subscribe-success"]')).toBeNull()
  })

  it('shows a generic error state on a non-429, non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'invalid_email' }) } as Response)
    const host = await renderInto(<SubscribeForm />)
    fill(host.querySelector('#status-subscribe-email') as HTMLInputElement, 'bad')
    await submit(host.querySelector('[data-testid="subscribe-form"]')!)
    expect(host.querySelector('[data-testid="subscribe-error"]')).toBeTruthy()
  })

  it('shows a generic error state when the request itself fails (network error)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const host = await renderInto(<SubscribeForm />)
    fill(host.querySelector('#status-subscribe-email') as HTMLInputElement, 'x@test.invalid')
    await submit(host.querySelector('[data-testid="subscribe-form"]')!)
    expect(host.querySelector('[data-testid="subscribe-error"]')?.textContent).toContain('Network error')
  })

  it('disables the submit button while the request is in flight', async () => {
    let resolveFetch: (value: Response) => void = () => {}
    fetchMock.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve }))
    const host = await renderInto(<SubscribeForm />)
    fill(host.querySelector('#status-subscribe-email') as HTMLInputElement, 'x@test.invalid')

    act(() => {
      host.querySelector('[data-testid="subscribe-form"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    const button = host.querySelector('button[type="submit"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Subscribing')

    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ ok: true, alreadySubscribed: false }) } as Response)
      await new Promise((r) => setTimeout(r, 0))
    })
  })
})
