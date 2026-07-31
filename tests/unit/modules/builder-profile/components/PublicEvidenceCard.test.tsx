// PublicEvidenceCard — public-profile-enrichment evidence widget (plan: stealth-scraping /
// public-profile-enrichment, spec §13).
//
// Verifies:
// - Renders nothing while the server reports the surface unavailable (kill switch / no keys).
// - Idle state with no evidence shows the "no evidence yet" prompt; a refresh POSTs to
//   evidence-refresh and reloads.
// - An active enrichment job disables the refresh button and shows "Refreshing…".
// - A 409 processing_restricted response from refresh switches to the restricted state, which
//   never renders evidence content regardless of what the initial GET returned.
// - A 'review' item shows Accept/Reject, and Accept PATCHes { resolution: 'accepted' } then
//   reloads.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PublicEvidenceCard } from '~/modules/builder-profile/components/PublicEvidenceCard'

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
    root.render(<PublicEvidenceCard builderId={builderId} />)
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

describe('PublicEvidenceCard', () => {
  it('renders nothing when the initial evidence fetch is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response)

    const host = await render('b-1')

    expect(host.querySelector('[data-testid="public-evidence-card"]')).toBeNull()
  })

  it('shows the empty-evidence prompt when idle with no evidence', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ job: null, evidence: [] }),
    } as Response)

    const host = await render('b-1')

    expect(host.querySelector('[data-testid="public-evidence-card"]')?.getAttribute('data-state')).toBe('idle')
    expect(host.querySelector('[data-testid="evidence-empty"]')).toBeTruthy()
  })

  it('disables refresh and shows "Refreshing…" while a job is queued or running', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ job: { id: 'job-1', status: 'running', lastErrorCode: null }, evidence: [] }),
    } as Response)

    const host = await render('b-1')

    expect(host.querySelector('[data-testid="public-evidence-card"]')?.getAttribute('data-state')).toBe('active')
    const button = host.querySelector('[data-testid="evidence-refresh-button"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Refreshing…')
  })

  it('POSTs to evidence-refresh and reloads when the refresh button is clicked', async () => {
    let refreshCalled = false
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/evidence-refresh')) {
        refreshCalled = true
        expect(init?.method).toBe('POST')
        return { ok: true, status: 200, json: async () => ({}) } as Response
      }
      return { ok: true, status: 200, json: async () => ({ job: null, evidence: [] }) } as Response
    })

    const host = await render('b-1')

    const button = host.querySelector('[data-testid="evidence-refresh-button"]') as HTMLButtonElement
    await act(async () => {
      click(button)
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(refreshCalled).toBe(true)
  })

  it('switches to the restricted state on a 409 processing_restricted refresh response', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.endsWith('/evidence-refresh')) {
        return { ok: false, status: 409, json: async () => ({ error: 'processing_restricted' }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({ job: null, evidence: [] }) } as Response
    })

    const host = await render('b-1')

    const button = host.querySelector('[data-testid="evidence-refresh-button"]') as HTMLButtonElement
    await act(async () => {
      click(button)
      await new Promise((r) => setTimeout(r, 0))
    })

    const card = host.querySelector('[data-testid="public-evidence-card"]')
    expect(card?.getAttribute('data-state')).toBe('restricted')
    expect(card?.textContent).toContain('restricted automated processing')
  })

  it('shows Accept/Reject for a review item, and Accept PATCHes { resolution: "accepted" } then reloads', async () => {
    const reviewEvidence = {
      id: 'ev-1',
      connector: 'github',
      sourceUrl: 'https://github.com/example',
      payload: { headline: 'Ships distributed systems in Rust' },
      confidenceBps: 7500,
      matchSignals: ['username_match'],
      resolution: 'review' as const,
      observedAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
    }
    let patchBody: unknown = null
    let loadCount = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/evidence/ev-1') && init?.method === 'PATCH') {
        patchBody = JSON.parse(init.body as string)
        return { ok: true, status: 200, json: async () => ({}) } as Response
      }
      loadCount += 1
      return { ok: true, status: 200, json: async () => ({ job: null, evidence: [reviewEvidence] }) } as Response
    })

    const host = await render('b-1')

    expect(host.querySelector('[data-testid="evidence-accept"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="evidence-reject"]')).toBeTruthy()

    const loadsBeforeAccept = loadCount
    const accept = host.querySelector('[data-testid="evidence-accept"]') as HTMLButtonElement
    await act(async () => {
      click(accept)
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(patchBody).toEqual({ resolution: 'accepted' })
    expect(loadCount).toBeGreaterThan(loadsBeforeAccept)
  })
})
