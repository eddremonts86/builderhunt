import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_ROW_LIMITS,
  DASHBOARD_SCHEMA_VERSION,
  dashboardActionSchema,
  dashboardOverviewSchema,
  dashboardRangeSchema,
  parseDashboardOverview,
} from '~/shared/lib/dashboard/contracts'

/**
 * plans/ui-dashboard Wave 1, "Define versioned dashboard overview contracts" — verify line: "invalid
 * range, unknown action, arbitrary URL, excessive rows, missing freshness, and incompatible schema
 * version fail closed."
 *
 * Every case below is a *fail closed* assertion, and that word is doing work. The failure mode this
 * contract exists to prevent is not a crash — it is a dashboard that renders something plausible from
 * a payload it did not fully understand. A tolerant parser turns a forgotten `LIMIT` into a page that
 * looks fine, a missing timestamp into an implied "now", and a server-supplied string into an anchor.
 */

const GENERATED_AT = '2027-03-01T10:00:00.000Z'

function overview(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    organizationId: 'org-1',
    range: '7d',
    generatedAt: GENERATED_AT,
    sections: {
      summary: {
        status: 'ready',
        generatedAt: GENERATED_AT,
        data: { trackedBuilders: 12, seenActiveInRange: 4, newlyTrackedInRange: 2, savedSearches: 3 },
      },
      recency: {
        status: 'ready',
        generatedAt: GENERATED_AT,
        data: { buckets: [{ date: '2027-03-01', count: 4 }], timezone: 'UTC' },
      },
      actionQueue: { status: 'empty', generatedAt: GENERATED_AT },
      sourceCoverage: { status: 'unavailable', code: 'section_failed' },
      upcoming: { status: 'empty', generatedAt: GENERATED_AT },
      review: { status: 'empty', generatedAt: GENERATED_AT },
      shortlists: { status: 'empty', generatedAt: GENERATED_AT },
      invitations: { status: 'empty', generatedAt: GENERATED_AT },
      activity: { status: 'empty', generatedAt: GENERATED_AT },
      discoveryTrend: { status: 'empty', generatedAt: GENERATED_AT },
      alertVolume: { status: 'empty', generatedAt: GENERATED_AT },
    },
    ...overrides,
  }
}

describe('the overview contract', () => {
  it('accepts a well-formed payload', () => {
    const result = parseDashboardOverview(overview())
    expect(result.ok, JSON.stringify(dashboardOverviewSchema.safeParse(overview()).error)).toBe(true)
  })

  it('refuses a payload from an incompatible schema version, and says so specifically', () => {
    // Reported as `version` rather than `schema` so an incompatible deploy is diagnosed as an
    // incompatible deploy, not as forty field errors that all descend from it.
    const result = parseDashboardOverview(overview({ schemaVersion: DASHBOARD_SCHEMA_VERSION + 1 }))
    expect(result).toEqual({ ok: false, reason: 'version' })
  })

  it('refuses a *newer* version too, not just an older one', () => {
    // The dangerous direction. A newer server may have removed a field this client reads, and an
    // absent field is exactly what a tolerant parser turns into `undefined` and then into "0".
    expect(parseDashboardOverview(overview({ schemaVersion: 0 })).ok).toBe(false)
    expect(parseDashboardOverview(overview({ schemaVersion: 99 })).ok).toBe(false)
  })

  it('refuses an unknown range instead of falling back to a default', () => {
    expect(dashboardRangeSchema.safeParse('7d').success).toBe(true)
    expect(dashboardRangeSchema.safeParse('90d').success).toBe(false)
    expect(dashboardRangeSchema.safeParse('').success).toBe(false)
    // A silent fallback would answer a question the caller did not ask, with a number they would
    // read as the answer to the one they did.
    expect(parseDashboardOverview(overview({ range: 'all-time' })).ok).toBe(false)
  })

  it('refuses a section that carries data without a generated time', () => {
    const payload = overview()
    delete (payload.sections.summary as { generatedAt?: string }).generatedAt
    expect(parseDashboardOverview(payload).ok).toBe(false)
  })

  it('refuses an empty section without a generated time as well', () => {
    // "There is nothing" and "we looked at 03:14 and there was nothing" are different claims, and
    // only the second one can be labelled stale later.
    const payload = overview({
      sections: { ...overview().sections, actionQueue: { status: 'empty' } },
    })
    expect(parseDashboardOverview(payload).ok).toBe(false)
  })

  it('gives an unavailable section no way to carry rows', () => {
    const payload = overview({
      sections: {
        ...overview().sections,
        actionQueue: { status: 'unavailable', code: 'section_failed', data: { items: [{ id: 'x' }] } },
      },
    })
    // Strict objects: a failure that smuggles data is the shape of the bug this replaces.
    const parsed = parseDashboardOverview(payload)
    if (parsed.ok) {
      expect(parsed.overview.sections.actionQueue).not.toHaveProperty('data')
    }
  })

  it('refuses an unavailable code that is not on the list', () => {
    const payload = overview({
      sections: { ...overview().sections, actionQueue: { status: 'unavailable', code: 'postgres said 42501' } },
    })
    expect(parseDashboardOverview(payload).ok).toBe(false)
  })

  it('refuses more rows than the section allows rather than truncating', () => {
    // A truncating parser turns "this query forgot its LIMIT" into a page that looks correct.
    const items = Array.from({ length: DASHBOARD_ROW_LIMITS.actionQueue + 1 }, (_, index) => ({
      id: `item-${index}`,
      severity: 'info',
      title: 'Something',
      detail: null,
      dueAt: null,
      action: { kind: 'open-search', resourceId: null },
    }))
    const payload = overview({
      sections: {
        ...overview().sections,
        actionQueue: { status: 'ready', generatedAt: GENERATED_AT, data: { items } },
      },
    })
    expect(parseDashboardOverview(payload).ok).toBe(false)
  })

  it('accepts exactly the row limit', () => {
    const items = Array.from({ length: DASHBOARD_ROW_LIMITS.actionQueue }, (_, index) => ({
      id: `item-${index}`,
      severity: 'warning' as const,
      title: 'Something',
      detail: null,
      dueAt: null,
      action: { kind: 'open-alert' as const, resourceId: 'alert-1' },
    }))
    const payload = overview({
      sections: {
        ...overview().sections,
        actionQueue: { status: 'ready', generatedAt: GENERATED_AT, data: { items } },
      },
    })
    expect(parseDashboardOverview(payload).ok).toBe(true)
  })

  it('omits the usage section entirely rather than marking it forbidden', () => {
    // Sending `{status: 'forbidden'}` would confirm to a member that the workspace has billing.
    const payload = overview()
    expect('usage' in payload.sections).toBe(false)
    expect(parseDashboardOverview(payload).ok).toBe(true)
  })
})

describe('actions', () => {
  it('accepts only allowlisted kinds', () => {
    expect(dashboardActionSchema.safeParse({ kind: 'open-billing', resourceId: null }).success).toBe(true)
    expect(dashboardActionSchema.safeParse({ kind: 'open-anything', resourceId: null }).success).toBe(false)
  })

  it.each([
    'https://evil.test/steal',
    '/settings/billing',
    '../../admin',
    'javascript:alert(1)',
    'org-1/../org-2',
    'id with spaces',
    '<script>',
  ])('refuses %s as a resource id', (resourceId) => {
    // The server never sends a URL, and this is what makes that structural rather than a convention:
    // even a repository that one day selects the wrong column cannot produce a value that reaches the
    // client's route builder as a path.
    expect(dashboardActionSchema.safeParse({ kind: 'open-builder', resourceId }).success).toBe(false)
  })

  it('accepts the id shapes this product actually mints', () => {
    for (const resourceId of ['abc123', 'a1b2c3d4e5f6', '11111111-1111-4111-8111-111111111111', 'my_saved-search']) {
      expect(dashboardActionSchema.safeParse({ kind: 'open-sprint', resourceId }).success, resourceId).toBe(true)
    }
  })

  it('refuses an id longer than any this product mints', () => {
    expect(dashboardActionSchema.safeParse({ kind: 'open-sprint', resourceId: 'a'.repeat(65) }).success).toBe(false)
  })
})

describe('recency buckets', () => {
  it('requires an explicit timezone so the boundary rule is stated, not inferred', () => {
    const payload = overview({
      sections: {
        ...overview().sections,
        recency: { status: 'ready', generatedAt: GENERATED_AT, data: { buckets: [] } },
      },
    })
    expect(parseDashboardOverview(payload).ok).toBe(false)
  })

  it('refuses a bucket key that is not a plain calendar date', () => {
    const payload = overview({
      sections: {
        ...overview().sections,
        recency: {
          status: 'ready',
          generatedAt: GENERATED_AT,
          // An ISO instant here would be a different unit wearing the same field name.
          data: { buckets: [{ date: '2027-03-01T00:00:00Z', count: 1 }], timezone: 'UTC' },
        },
      },
    })
    expect(parseDashboardOverview(payload).ok).toBe(false)
  })
})

describe('the upcoming agenda', () => {
  /**
   * plans/ui-dashboard Wave 3. The field worth guarding is `meetingUrl`: it is the one value in this
   * projection that a *user typed* and that the browser will follow. Validating it at the boundary
   * means no component has to remember to sanitise it, and no future component can forget.
   */
  const item = {
    eventId: 'evt-1',
    title: 'Interview: Senior Backend Engineer',
    startsAt: '2027-03-01T10:00:00.000Z',
    endsAt: '2027-03-01T10:30:00.000Z',
    timezone: 'Europe/Copenhagen',
    allDay: false,
    type: 'interview',
    location: null,
    meetingUrl: 'https://meet.test.invalid/abc',
    hasActiveBrief: false,
    invitationId: null,
  }

  function withUpcoming(items: unknown[]) {
    const base = overview()
    return parseDashboardOverview({
      ...base,
      sections: { ...base.sections, upcoming: { status: 'ready', generatedAt: GENERATED_AT, data: { items } } },
    })
  }

  it('accepts a well-formed appointment', () => {
    expect(withUpcoming([item]).ok).toBe(true)
  })

  it.each([
    'javascript:alert(1)',
    '//evil.test/meeting',
    'data:text/html,<script>',
    'meet.test.invalid/abc',
    'file:///etc/passwd',
  ])('refuses %s as a meeting link', (meetingUrl) => {
    // Not sanitised in the component — refused here, so every renderer downstream is safe by
    // construction rather than by discipline.
    expect(withUpcoming([{ ...item, meetingUrl }]).ok).toBe(false)
  })

  it('allows a null meeting link, which is an in-person or unlinked appointment', () => {
    expect(withUpcoming([{ ...item, meetingUrl: null, location: 'Room 4' }]).ok).toBe(true)
  })

  it('requires the event timezone, so a time cannot be rendered in a zone nobody agreed to', () => {
    const { timezone: _dropped, ...withoutZone } = item
    expect(withUpcoming([withoutZone]).ok).toBe(false)
  })

  it('refuses more rows than a week of agenda should carry', () => {
    const many = Array.from({ length: DASHBOARD_ROW_LIMITS.upcoming + 1 }, (_, index) => ({
      ...item,
      eventId: `evt-${index}`,
    }))
    expect(withUpcoming(many).ok).toBe(false)
  })
})

describe('candidates to review', () => {
  /**
   * plans/ui-dashboard Wave 4. Two fields carry the widget's whole claim to trustworthiness — the
   * provenance and the reason — so both are required and the provenance is a closed enum. A row that
   * cannot say why it is in a review queue is asking for trust it has not earned.
   */
  const item = {
    key: 'github:12345',
    source: 'github',
    username: 'octocat',
    displayName: 'The Octocat',
    provenance: 'sprint-result',
    reason: 'Found by your "Rust backend" sprint',
    score: 87,
    tracked: false,
    organizationBuilderId: null,
  }

  function withReview(items: unknown[]) {
    const base = overview()
    return parseDashboardOverview({
      ...base,
      sections: { ...base.sections, review: { status: 'ready', generatedAt: GENERATED_AT, data: { items } } },
    })
  }

  it('accepts a well-formed candidate', () => {
    expect(withReview([item]).ok).toBe(true)
  })

  it('refuses an unknown provenance', () => {
    // The client picks an icon and a continuation from this value; an unrecognised one would render
    // as neither, which is worse than refusing the payload.
    expect(withReview([{ ...item, provenance: 'vibes' }]).ok).toBe(false)
  })

  it('refuses a row with no reason', () => {
    expect(withReview([{ ...item, reason: '' }]).ok).toBe(false)
  })

  it('refuses an organizationBuilderId shaped like a path', () => {
    // It is interpolated into a route param. The pattern is what keeps that safe by construction.
    expect(withReview([{ ...item, tracked: true, organizationBuilderId: '../../admin' }]).ok).toBe(false)
  })

  it('refuses more rows than a sitting', () => {
    const many = Array.from({ length: DASHBOARD_ROW_LIMITS.review + 1 }, (_, index) => ({
      ...item,
      key: `github:${index}`,
    }))
    expect(withReview(many).ok).toBe(false)
  })
})

describe('invitation distribution', () => {
  /**
   * plans/ui-dashboard Wave 5. The shape enforces the design decision: it is a distribution, not a
   * funnel, so every state is always present and no percentage is transmitted. A client that wanted
   * a conversion rate would have to invent the denominator, and inventing it is the mistake — an
   * invitation reaches `booked` without necessarily passing through `opened`.
   */
  const counts = [
    { status: 'draft', count: 1 },
    { status: 'sent', count: 4 },
    { status: 'opened', count: 2 },
    { status: 'booked', count: 1 },
    { status: 'declined', count: 1 },
    { status: 'expired', count: 0 },
    { status: 'revoked', count: 0 },
  ]

  function withInvitations(data: unknown) {
    const base = overview()
    return parseDashboardOverview({
      ...base,
      sections: { ...base.sections, invitations: { status: 'ready', generatedAt: GENERATED_AT, data } },
    })
  }

  it('accepts a full distribution', () => {
    expect(withInvitations({ counts, needsAction: 1, total: 9 }).ok).toBe(true)
  })

  it('refuses a distribution missing a state', () => {
    // Omitting the empty ones would change the shape's meaning between two workspaces, and a reader
    // comparing them learns something false.
    expect(withInvitations({ counts: counts.slice(0, 6), needsAction: 1, total: 9 }).ok).toBe(false)
  })

  it('refuses a state that is not one the table can hold', () => {
    const invented = [...counts.slice(0, 6), { status: 'ghosted', count: 0 }]
    expect(withInvitations({ counts: invented, needsAction: 0, total: 9 }).ok).toBe(false)
  })

  it('carries no percentages', () => {
    // Structural, not stylistic: a rate computed from these states would use a denominator that does
    // not mean what it looks like, so the wire format gives a client nothing to compute one from
    // except the raw counts it would have to justify itself.
    const parsed = withInvitations({ counts, needsAction: 1, total: 9 })
    expect(parsed.ok).toBe(true)
    if (parsed.ok && parsed.overview.sections.invitations.status === 'ready') {
      // Asserted on the *keys*, not on the serialized string. The first version matched
      // `/rate|percent/` against the JSON and failed on "gene**rate**dAt" — a substring check
      // looking for a field name is a check that fails for the wrong reason.
      const data = parsed.overview.sections.invitations.data as Record<string, unknown>
      expect(Object.keys(data).sort()).toEqual(['counts', 'needsAction', 'total'])
      for (const entry of data.counts as Array<Record<string, unknown>>) {
        expect(Object.keys(entry).sort()).toEqual(['count', 'status'])
      }
    }
  })
})
