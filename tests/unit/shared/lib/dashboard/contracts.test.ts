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
