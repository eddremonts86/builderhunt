/**
 * The contextual service-degradation notice (plan 57, Wave 5 — "Add contextual service degradation only").
 *
 * The Verify line is two sentences and both are about *not* rendering something: a healthy state renders no
 * permanent widget, and degraded copy never fabricates a healthy or failed component. Every case here is one of
 * those.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { ServiceDegradationNotice } from '~/modules/dashboard/ui/shell/ServiceDegradationNotice'

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
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as Response
}

async function render() {
  const rootRoute = createRootRoute({ component: () => <ServiceDegradationNotice /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
  for (let flush = 0; flush < 4; flush += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

const notice = () => container!.querySelector('[data-testid="service-degradation-notice"]')

describe('ServiceDegradationNotice', () => {
  it('renders nothing at all when everything is healthy', async () => {
    /**
     * "Contextual only" is the task title. There is no permanent widget, so the dashboard says nothing about
     * service health until something is wrong — which is what makes the notice worth reading when it appears.
     */
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ state: 'ok', degraded: [] })))
    await render()
    expect(notice()).toBeNull()
  })

  it('renders nothing when the state is unknown, because that is not an incident', async () => {
    // "We could not tell" and "something is broken" are different sentences. A banner on a failed check would
    // train people to ignore the banner.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ state: 'unknown', degraded: [] })))
    await render()
    expect(notice()).toBeNull()
  })

  it('renders nothing when the request itself fails', async () => {
    // And silently: a failed read of the health summary must not itself look like an incident.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await render()
    expect(notice()).toBeNull()
  })

  it('names only the components the check reported, and claims nothing about the rest', async () => {
    /**
     * The Verify line's second half. The way to never fabricate a healthy component is to list what was reported
     * and say nothing else — no "all other systems operational", which is a claim three checks cannot support.
     */
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ state: 'degraded', degraded: ['cache'] })))
    await render()

    const text = notice()?.textContent ?? ''
    expect(text).toContain('caching')
    expect(text).not.toContain('database')
    expect(text.toLowerCase()).not.toContain('operational')
    expect(text.toLowerCase()).not.toContain('all systems')
  })

  it('tells the reader what it means for their work, not which dependency it is', async () => {
    // "Redis is down" is a sentence for an operator. A tenant needs to know their save might fail.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ state: 'degraded', degraded: ['database'] })))
    await render()
    expect(notice()?.textContent).toContain('fail to save')
    expect(notice()?.textContent).not.toContain('redis')
  })

  it('links to the status page rather than describing the outage in place', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ state: 'degraded', degraded: ['memory'] })))
    await render()
    const link = container!.querySelector('[data-testid="service-degradation-status-link"]')
    expect(link?.getAttribute('href')).toBe('/status')
  })

  it('reads the 200-answering summary, never the 503-answering status endpoint', async () => {
    /**
     * The reason this task was reverted on 2026-08-06: a browser writes every non-2xx subresource to the console,
     * so polling `/api/status` — which correctly answers 503 when degraded — put two console errors on every page
     * load during an incident, and the sign-in e2e's strict collector caught it.
     */
    const fetchMock = vi.fn(async () => jsonResponse({ state: 'ok', degraded: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await render()

    const urls = fetchMock.mock.calls.map((call) => String((call as unknown as unknown[])[0]))
    expect(urls).toEqual(['/api/status/summary'])
  })

  it('reads once per mount rather than on a timer', async () => {
    // The endpoint is cached for 30s and an incident outlasts a page view, so a timer would add a dependency
    // probe per session per minute to buy a notice arriving slightly sooner on a page nobody is watching.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const fetchMock = vi.fn(async () => jsonResponse({ state: 'ok', degraded: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await render()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
  })
})
