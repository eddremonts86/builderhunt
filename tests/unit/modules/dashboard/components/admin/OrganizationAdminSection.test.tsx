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
          total: 5,
          byRole: { owner: 1, admin: 1, member: 3 },
          seatLimit: 10,
        },
      },
      billing: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { tier: 'team', status: 'active', seatLimit: 10, approachingSeatCap: false, renewalDays: 12 },
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
        data: { byKind: { deletion: { pending: 2 }, export: { processing: 1 } } },
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
    expect(document.body.textContent).toMatch(/5 members of 10 seats/i)
    expect(document.body.textContent).toMatch(/1 owner · 1 admin · 3 member/i)
  })

  it('renders billing plan with renewal', () => {
    render(<OrganizationAdminSection overview={baseOverview()} />)
    expect(document.body.textContent).toMatch(/Plan: team · active/i)
    expect(document.body.textContent).toMatch(/Renews in 12 days/i)
  })

  /**
   * The regression test for the defect that shipped: every noun in a ready card has its number.
   *
   * The previous component read `data.totalMembers` and `data.renewalDaysRemaining` — fields the projection had
   * renamed — so React rendered `undefined` as nothing and the cards read "total members · active seats" and
   * "· days to renewal". Both were *grammatical*, which is why five passing tests and a type-check did not notice:
   * the old assertions matched `/5 total members/` against a fixture that still used the old field names, so the
   * test data agreed with the test rather than with the projection.
   *
   * This asserts the property directly instead of a phrase: in a ready section, no unit word appears without a
   * digit in front of it. It fails on exactly the shape that shipped, whatever the field is called next time.
   */
  it('never renders a unit word without its number', () => {
    render(<OrganizationAdminSection overview={baseOverview()} />)
    // Card bodies only. The heading "Members and seats" contains a unit word by design, so handing the whole card
    // to this check reports the title as a violation.
    const bodies = Array.from(document.querySelectorAll('[data-testid="org-admin-card-body"]'))
    expect(bodies).toHaveLength(6)

    for (const body of bodies) {
      const text = body.textContent ?? ''
      expect(text).not.toContain('undefined')
      expect(text).not.toContain('NaN')
      for (const unit of ['members', 'seats', 'days', 'blocked workflow']) {
        const orphaned = new RegExp(`(?:^|[^0-9]\\s|·\\s)${unit}\\b`, 'i')
        expect(orphaned.test(text), `"${unit}" rendered without a preceding number in: ${text}`).toBe(false)
      }
    }
  })

  /**
   * `dependency-missing` must not read as an outage.
   *
   * Three of the six cards carry this reason permanently — two have no table in any migration and the third would
   * need a privilege the tenant connection is deliberately not granted. The copy was "A required service is not
   * available right now", so a brand-new workspace opened its dashboard to what looked like a partial failure of
   * the product, and the honest reading would have sent the admin to the status page for a feature that was never
   * built.
   */
  it('says an unbuilt section is unbuilt, not broken', () => {
    const o = baseOverview()
    o.sections.blockedWorkflows = { state: 'unavailable', reason: 'dependency-missing' }
    render(<OrganizationAdminSection overview={o} />)
    const text = document.querySelector('[data-testid="org-admin-section"]')!.textContent ?? ''
    expect(text).toMatch(/not available yet/i)
    expect(text).not.toMatch(/required service|right now|try again|outage|error/i)
  })

  it('does not leak any of the 8 forbidden member-data markers into the DOM', () => {
    const { container: c } = render(<OrganizationAdminSection overview={baseOverview()} />)
    const html = c.innerHTML
    for (const marker of forbiddenMemberDataMarkers) {
      expect(html).not.toContain(marker)
    }
  })
})
