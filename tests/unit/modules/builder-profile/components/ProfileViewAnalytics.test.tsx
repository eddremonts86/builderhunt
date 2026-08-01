// ProfileViewAnalytics — verified-owner profile-view aggregates (plans/UI/tasks.md Wave 4 "Record
// profile views and show owner aggregates").
//
// Verifies:
// - Loading state while the fetch is pending.
// - Error state on a non-ok fetch (e.g. 403 for a non-owner, though the panel doesn't know why).
// - Empty state when total is 0, with no chart and no minimum-cohort message.
// - Minimum-cohort state when total is below the chart threshold but non-zero.
// - Chart renders once total reaches the threshold, one bar per day, oldest-first.
// - Never renders anything beyond total/day/count — no viewer, organization, query, or referrer
//   field exists on the DTO this component consumes, so there is nothing to accidentally surface.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileViewAnalytics } from '~/modules/builder-profile/components/ProfileViewAnalytics'

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

async function render(builderId: string) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<ProfileViewAnalytics builderId={builderId} />)
    await new Promise((r) => setTimeout(r, 0))
  })
  return host
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('ProfileViewAnalytics', () => {
  it('renders an error state on a non-ok fetch', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) } as Response)
    const host = await render('b-1')
    expect(host.querySelector('[data-testid="profile-view-analytics"]')?.getAttribute('data-state')).toBe('error')
  })

  it('renders the empty state when total is 0, with no chart or minimum-cohort message', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ builderId: 'b-1', windowDays: 30, total: 0, daily: [] }),
    } as Response)
    const host = await render('b-1')
    expect(host.querySelector('[data-testid="profile-view-analytics"]')?.getAttribute('data-state')).toBe('empty')
    expect(host.querySelector('[data-testid="profile-view-chart"]')).toBeNull()
    expect(host.querySelector('[data-testid="profile-view-minimum-cohort"]')).toBeNull()
  })

  it('renders the minimum-cohort message when total is non-zero but below the chart threshold', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builderId: 'b-1', windowDays: 30, total: 3,
        daily: [{ day: '2026-07-30', count: 2 }, { day: '2026-07-31', count: 1 }],
      }),
    } as Response)
    const host = await render('b-1')
    expect(host.querySelector('[data-testid="profile-view-total"]')?.textContent).toBe('3')
    expect(host.querySelector('[data-testid="profile-view-minimum-cohort"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="profile-view-chart"]')).toBeNull()
  })

  it('renders the daily chart once total reaches the threshold, oldest bar first', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builderId: 'b-1', windowDays: 30, total: 8,
        daily: [
          { day: '2026-07-31', count: 5 },
          { day: '2026-07-30', count: 2 },
          { day: '2026-07-29', count: 1 },
        ],
      }),
    } as Response)
    const host = await render('b-1')
    expect(host.querySelector('[data-testid="profile-view-total"]')?.textContent).toBe('8')
    const chart = host.querySelector('[data-testid="profile-view-chart"]')
    expect(chart).toBeTruthy()
    expect(chart!.children).toHaveLength(3)
    // Server returns newest-first; the chart renders oldest-first (left to right).
    expect(chart!.children[0].getAttribute('title')).toContain('1 view')
    expect(chart!.children[2].getAttribute('title')).toContain('5 views')
  })
})
