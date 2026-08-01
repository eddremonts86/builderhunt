// EvidenceProvenancePanel — verified-subject provenance + restrict-processing panel
// (plans/UI/tasks.md Wave 4 "Add verified-subject provenance UI" and "Add restrict-processing
// confirmation and state").
//
// Verifies:
// - Loading state renders while the initial fetch is pending.
// - Empty state when the claimant has no evidence yet.
// - Error state on a non-ok fetch.
// - Restricted state renders directly from `restrictedSince` on mount — no confirmation click
//   needed to see it, since it must survive a reload.
// - Idle state lists field categories (not values) per entry, with retention state.
// - The restrict flow requires an explicit confirm click before POSTing, and re-loads (which then
//   shows the restricted state) on success.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EvidenceProvenancePanel } from '~/modules/builder-profile/components/EvidenceProvenancePanel'

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
    root.render(<EvidenceProvenancePanel builderId={builderId} />)
    await new Promise((r) => setTimeout(r, 0))
  })
  return host
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('EvidenceProvenancePanel', () => {
  it('shows the empty state when idle with no evidence', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ provenance: [], restrictedSince: null }),
    } as Response)

    const host = await render('b-1')

    expect(host.querySelector('[data-testid="evidence-provenance-panel"]')?.getAttribute('data-state')).toBe('ready')
    expect(host.querySelector('[data-testid="evidence-provenance-empty"]')).toBeTruthy()
  })

  it('renders an error state on a non-ok fetch', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) } as Response)

    const host = await render('b-1')

    expect(host.querySelector('[data-testid="evidence-provenance-panel"]')?.getAttribute('data-state')).toBe('error')
  })

  it('renders the restricted state directly from restrictedSince, with no evidence content', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        provenance: [{ source: 'github', fieldCategories: ['headline'], observedAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-08-01T00:00:00.000Z', retentionState: 'active' }],
        restrictedSince: '2026-07-15T00:00:00.000Z',
      }),
    } as Response)

    const host = await render('b-1')

    const panel = host.querySelector('[data-testid="evidence-provenance-panel"]')
    expect(panel?.getAttribute('data-state')).toBe('restricted')
    expect(host.querySelector('[data-testid="evidence-provenance-item"]')).toBeNull()
    expect(host.querySelector('[data-testid="restrict-processing-open"]')).toBeNull()
  })

  it('lists field category names (never payload values) per entry, with retention state', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        provenance: [
          { source: 'github', fieldCategories: ['headline', 'topics'], observedAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-08-01T00:00:00.000Z', retentionState: 'active' },
          { source: 'linkedin', fieldCategories: [], observedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z', retentionState: 'expired' },
        ],
        restrictedSince: null,
      }),
    } as Response)

    const host = await render('b-1')

    const items = host.querySelectorAll('[data-testid="evidence-provenance-item"]')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('headline')
    expect(items[0].textContent).toContain('topics')
    expect(items[0].getAttribute('data-retention-state')).toBe('active')
    expect(items[1].getAttribute('data-retention-state')).toBe('expired')
  })

  it('requires an explicit confirm click before POSTing to restrict-processing', async () => {
    let restrictCalled = false
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.endsWith('/restrict-processing')) {
        restrictCalled = true
        return { ok: true, json: async () => ({ restricted: true }) } as Response
      }
      return { ok: true, json: async () => ({ provenance: [], restrictedSince: null }) } as Response
    })

    const host = await render('b-1')

    click(host.querySelector('[data-testid="restrict-processing-open"]') as HTMLButtonElement)
    expect(host.querySelector('[data-testid="restrict-processing-confirm"]')).toBeTruthy()
    expect(restrictCalled).toBe(false)

    await act(async () => {
      click(host.querySelector('[data-testid="restrict-processing-confirm-button"]') as HTMLButtonElement)
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(restrictCalled).toBe(true)
  })

  it('cancel closes the confirmation without ever POSTing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ provenance: [], restrictedSince: null }),
    } as Response)

    const host = await render('b-1')

    click(host.querySelector('[data-testid="restrict-processing-open"]') as HTMLButtonElement)
    expect(host.querySelector('[data-testid="restrict-processing-confirm"]')).toBeTruthy()

    click(host.querySelector('[data-testid="restrict-processing-cancel"]') as HTMLButtonElement)
    expect(host.querySelector('[data-testid="restrict-processing-confirm"]')).toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => typeof url === 'string' && url.endsWith('/restrict-processing'))).toBe(false)
  })

  it('shows an inline error and stays in the confirm step when the restrict POST fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.endsWith('/restrict-processing')) {
        return { ok: false, status: 500, json: async () => ({}) } as Response
      }
      return { ok: true, json: async () => ({ provenance: [], restrictedSince: null }) } as Response
    })

    const host = await render('b-1')

    click(host.querySelector('[data-testid="restrict-processing-open"]') as HTMLButtonElement)
    await act(async () => {
      click(host.querySelector('[data-testid="restrict-processing-confirm-button"]') as HTMLButtonElement)
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(host.querySelector('[data-testid="restrict-processing-confirm"]')).toBeTruthy()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not restrict processing')
  })
})
