/**
 * Wave 5 — OrganizationAdminSection tests.
 *
 * Locks the privacy contract: the component must never render the eight
 * forbidden markers, must hide for non-admins, and must respect every
 * envelope state (loading, empty, unavailable, forbidden, ready).
 *
 * Uses the project's react-dom/client + act pattern (see
 * AbuseWarningBanner.test.tsx for the reference).
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import { OrganizationAdminSection } from '~/modules/dashboard/components/admin/OrganizationAdminSection'
import { forbiddenMemberDataMarkers } from '~/shared/lib/dashboard/admin-contracts'
import type { z } from 'zod'
import type { orgAdminOverviewSchema } from '~/shared/lib/dashboard/admin-contracts'

type OrgAdminOverview = z.infer<typeof orgAdminOverviewSchema>

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

function baseOverview(): OrgAdminOverview {
  return {
    schemaVersion: 1,
    organizationId: '11111111-1111-1111-1111-111111111111',
    range: '7d',
    generatedAt: '2026-08-07T12:00:00.000Z',
    sections: {
      members: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: {
          totalMembers: 5,
          activeSeats: 4,
          pendingInvitations: 1,
          byRole: { owner: 1, admin: 1, member: 3 },
        },
      },
      billing: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { tier: 'team', approachingCap: false, renewalDaysRemaining: 12 },
      },
      blockedWorkflows: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { blockedCounts: { missing_owner: 2 }, total: 2 },
      },
      featureAdoption: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { rates: { alerts: 0.6, exports: 0.3 } },
      },
      securityPosture: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { unverifiedAdmins: 0, staleAdminDays: {} },
      },
      privacyRequests: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { pending: 2, allowedStatuses: ['pending', 'processing'] },
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

describe('<OrganizationAdminSection />', () => {
  it('renders nothing for non-admins (overview is null)', () => {
    const { container: c } = render(<OrganizationAdminSection overview={null} />)
    expect(c.firstChild).toBeNull()
  })

  it('renders all six section cards for admins', () => {
    render(<OrganizationAdminSection overview={baseOverview()} />)
    const section = document.querySelector('[data-testid="org-admin-section"]')
    expect(section).not.toBeNull()
    const headings = section!.querySelectorAll('h3')
    expect(headings.length).toBe(6)
  })

  it('renders the envelope states correctly', () => {
    const o = baseOverview()
    o.sections.billing = { state: 'forbidden' }
    o.sections.blockedWorkflows = { state: 'loading' }
    o.sections.featureAdoption = { state: 'empty' }
    o.sections.securityPosture = { state: 'unavailable', reason: 'rate-limited' }
    render(<OrganizationAdminSection overview={o} />)
    expect(document.body.textContent).toMatch(/don't have access/i)
    expect(document.body.textContent).toMatch(/loading/i)
    expect(document.body.textContent).toMatch(/nothing to show yet/i)
    expect(document.body.textContent).toMatch(/too many requests/i)
  })

  it('renders ready-state content with members block', () => {
    render(<OrganizationAdminSection overview={baseOverview()} />)
    expect(document.body.textContent).toMatch(/5 total members/i)
    expect(document.body.textContent).toMatch(/1 pending invitation/i)
  })

  it('renders billing plan with renewal', () => {
    render(<OrganizationAdminSection overview={baseOverview()} />)
    expect(document.body.textContent).toMatch(/12 days to renewal/i)
  })

  it('does not leak any of the 8 forbidden member-data markers into the DOM', () => {
    const { container: c } = render(<OrganizationAdminSection overview={baseOverview()} />)
    const html = c.innerHTML
    for (const marker of forbiddenMemberDataMarkers) {
      expect(html).not.toContain(marker)
    }
  })
})
