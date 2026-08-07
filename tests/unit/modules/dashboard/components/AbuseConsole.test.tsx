import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AbuseConsole } from '~/modules/dashboard/components/AbuseConsole'

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

/**
 * The feed is a `PageResult` now, and each row carries its own `stage`.
 *
 * It used to be `{ signals, stageByUserId }` — a flat array plus a side map the component joined.
 * Phase 3 moved the console onto the shared table shell, so the route answers rows/nextCursor/
 * total/facets like every other paged surface and annotates the stage onto the row it belongs to.
 */
function feedResponse(signals: unknown[], stageByUserId: Record<string, unknown>) {
  const rows = signals.map((signal) => ({
    ...(signal as Record<string, unknown>),
    stage: stageByUserId[(signal as { userId?: string }).userId ?? ''] ?? null,
  }))
  return new Response(
    JSON.stringify({ rows, nextCursor: null, total: rows.length, facets: {} }),
    { status: 200 },
  )
}

function clustersResponse(clusters: unknown[]) {
  return new Response(JSON.stringify({ windowDays: 30, clusters }), { status: 200 })
}

async function mount() {
  const rootRoute = createRootRoute({ component: () => <AbuseConsole /> })
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

const SIGNAL = { id: 'sig-1', type: 'seat_overuse', severity: 'medium', userId: 'user-1', organizationId: null, requestId: 'req-1', details: {}, createdAt: '2026-01-01T00:00:00.000Z' }

describe('AbuseConsole', () => {
  it('renders the recent-signals table with each signal\'s current stage', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/clusters')) return clustersResponse([])
      return feedResponse([SIGNAL], { 'user-1': { stage: 'warned', riskScore: 40, reason: 'concurrent_sessions', updatedAt: '2026-01-01T00:00:00.000Z' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mount()

    // The ARIA grid replaced the `<table>`; the row test id is unchanged, which is the point of
    // `rowTestId` being a required prop.
    const grid = document.querySelector('[role="grid"]')
    expect(grid).not.toBeNull()
    expect(document.querySelector('[data-testid="abuse-signal-row-sig-1"]')).not.toBeNull()
    expect(grid?.textContent).toContain('seat_overuse')
    expect(grid?.textContent).toContain('warned')
  })

  it('shows an empty state when there are no signals or clusters', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/clusters')) return clustersResponse([])
      return feedResponse([], {})
    })
    vi.stubGlobal('fetch', fetchMock)
    await mount()

    expect(document.body.textContent).toContain('No abuse signals recorded.')
    expect(document.body.textContent).toContain('No linked-account clusters detected.')
  })

  it('renders linked-account clusters', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/clusters')) return clustersResponse([{ userIds: ['user-1', 'user-2'], sharedDeviceHashes: ['hash-1'], sharedIpAddresses: [] }])
      return feedResponse([], {})
    })
    vi.stubGlobal('fetch', fetchMock)
    await mount()

    const list = document.querySelector('[data-testid="abuse-clusters-list"]')
    expect(list?.textContent).toContain('user-1, user-2')
    expect(list?.textContent).toContain('1 shared device(s)')
  })

  it('toggles the manual-action form and submits the selected action', async () => {
    let postBody: unknown = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/clusters')) return clustersResponse([])
      if (init?.method === 'POST') {
        postBody = JSON.parse(init.body as string)
        return new Response(JSON.stringify({ userId: 'user-1', stage: 'observe', riskScore: 0, reason: null, updatedAt: '2026-01-01T00:00:00.000Z' }), { status: 200 })
      }
      return feedResponse([SIGNAL], { 'user-1': { stage: 'warned', riskScore: 40, reason: null, updatedAt: '2026-01-01T00:00:00.000Z' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mount()

    // The row's own expand control, provided by the shell, replaced the hand-rolled toggle — the
    // per-row form itself is unchanged and still lives in the expansion slot.
    const toggle = document.querySelector<HTMLButtonElement>('[data-testid="abuse-signal-row-sig-1-expand"]')!
    await act(async () => { toggle.click() })

    const submit = document.querySelector<HTMLButtonElement>('[data-testid="abuse-account-action-submit-user-1"]')!
    expect(submit).not.toBeNull()

    await act(async () => {
      submit.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(postBody).toEqual({ userId: 'user-1', action: 'clear', reason: undefined })
  })
})
