/**
 * Wave 5 — PlatformAdminSection tests.
 *
 * Locks the privacy contract for the platform-admin dashboard section.
 * Mirrors the org-admin test pattern: hides for non-admins, renders all
 * 7 cards, handles every envelope state, and refuses to render any of
 * the 8 forbidden member-data markers.
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import { PlatformAdminSection } from '~/modules/dashboard/components/admin/PlatformAdminSection'
import { forbiddenMemberDataMarkers } from '~/shared/lib/dashboard/admin-contracts'
import type { z } from 'zod'
import type { platformAdminOverviewSchema } from '~/shared/lib/dashboard/admin-contracts'

type PlatformAdminOverview = z.infer<typeof platformAdminOverviewSchema>

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

function baseOverview(): PlatformAdminOverview {
  return {
    schemaVersion: 2,
    range: '7d',
    generatedAt: '2026-08-07T12:00:00.000Z',
    sections: {
      incidents: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { open: 3, byService: { ingest: 2, api: 1 } },
      },
      operations: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { metrics: [{ key: 'ingest_lag_ms', value: 250, unit: 'ms' }] },
      },
      billing: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { totalActiveTenants: 42, mrrCents: 1_200_000 },
      },
      abuseTrust: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { openReports: 1, autoActioned24h: 5 },
      },
      userAnomalies: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { suspiciousSignins: 4, impossibleTravel: 0 },
      },
      growth: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { signups: 50, activations: 30 },
      },
      publicContent: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { reviewQueue: 7, claimedPublicProfiles: 11 },
      },
    },
  }
}

function render(element: React.ReactElement): { container: HTMLDivElement } {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(element)
  })
  return { container }
}

function unmount() {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
}

afterEach(unmount)

describe('<PlatformAdminSection />', () => {
  it('renders nothing for non-platform-admins (overview is null)', () => {
    const { container: c } = render(<PlatformAdminSection overview={null} />)
    expect(c.firstChild).toBeNull()
  })

  it('renders all seven section cards for platform-admins', () => {
    render(<PlatformAdminSection overview={baseOverview()} />)
    const section = document.querySelector('[data-testid="platform-admin-section"]')
    expect(section).not.toBeNull()
    const headings = section!.querySelectorAll('h3')
    expect(headings.length).toBe(7)
  })

  it('renders the envelope states correctly', () => {
    const o = baseOverview()
    o.sections.incidents = { state: 'forbidden' }
    o.sections.operations = { state: 'loading' }
    o.sections.billing = { state: 'empty' }
    o.sections.abuseTrust = { state: 'unavailable', reason: 'rate-limited' }
    render(<PlatformAdminSection overview={o} />)
    expect(document.body.textContent).toMatch(/don't have access/i)
    expect(document.body.textContent).toMatch(/loading/i)
    expect(document.body.textContent).toMatch(/nothing to show yet/i)
    expect(document.body.textContent).toMatch(/too many requests/i)
  })

  it('renders ready-state content with incidents and growth blocks', () => {
    render(<PlatformAdminSection overview={baseOverview()} />)
    expect(document.body.textContent).toMatch(/3 open incidents/i)
    expect(document.body.textContent).toMatch(/50 signups/i)
    expect(document.body.textContent).toMatch(/11 claimed public profiles/i)
  })

  it('formats billing MRR as dollars', () => {
    render(<PlatformAdminSection overview={baseOverview()} />)
    expect(document.body.textContent).toMatch(/\$12,000 MRR/i)
  })

  it('formats operations metrics with their units', () => {
    render(<PlatformAdminSection overview={baseOverview()} />)
    expect(document.body.textContent).toMatch(/250 ms/i)
  })

  it('does not leak any of the 8 forbidden member-data markers into the DOM', () => {
    const { container: c } = render(<PlatformAdminSection overview={baseOverview()} />)
    const html = c.innerHTML
    for (const marker of forbiddenMemberDataMarkers) {
      expect(html).not.toContain(marker)
    }
  })
})
