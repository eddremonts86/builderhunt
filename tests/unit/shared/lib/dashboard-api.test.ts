import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DASHBOARD_CONTEXT,
  SHIPPED_DASHBOARD_CAPABILITIES,
  dashboardContextSchema,
  resolveDashboardPresetId,
} from '~/shared/lib/dashboard-api'
import { ONBOARDING_PRESETS } from '~/shared/lib/onboarding-v2'

/**
 * The dashboard context contract (plan: phase-2/04-dashboard-personalizado).
 *
 * The kill switch lives here rather than in an e2e for a mechanical reason: `env` is frozen at
 * module load and the harness caches one server per worker, so a spec cannot flip the flag between
 * tests. Both positions are exhaustive here, and the e2e proves the wiring with it on.
 */

describe('the presets kill switch', () => {
  it('answers general for every segment while it is off', () => {
    for (const segment of [null, undefined, 'hiring', 'investing', 'building', 'other']) {
      expect(resolveDashboardPresetId(segment, false), String(segment)).toBe('general')
    }
  })

  it('follows the stored segment while it is on', () => {
    for (const preset of ONBOARDING_PRESETS) {
      expect(resolveDashboardPresetId(preset, true), preset).toBe(preset)
    }
  })

  /** A value from a newer build, or a typo in the column, must not index a record it is not a key of. */
  it('falls back to general for a segment it does not know', () => {
    expect(resolveDashboardPresetId('recruiter', true)).toBe('general')
    expect(resolveDashboardPresetId('', true)).toBe('general')
  })

  it('answers general for somebody who never chose, flag or no flag', () => {
    expect(resolveDashboardPresetId(null, true)).toBe('general')
    expect(resolveDashboardPresetId(null, false)).toBe('general')
  })
})

describe('the wire shape', () => {
  it('validates the default the page falls back to', () => {
    expect(dashboardContextSchema.safeParse(DEFAULT_DASHBOARD_CONTEXT).success).toBe(true)
    expect(DEFAULT_DASHBOARD_CONTEXT.presetId).toBe('general')
  })

  it('rejects an unknown key, so a field cannot arrive unvalidated', () => {
    expect(dashboardContextSchema.safeParse({
      ...DEFAULT_DASHBOARD_CONTEXT, organizationId: 'org-1',
    }).success).toBe(false)
  })

  it('rejects a capability this build does not have', () => {
    expect(dashboardContextSchema.safeParse({
      ...DEFAULT_DASHBOARD_CONTEXT, capabilities: ['telepathy'],
    }).success).toBe(false)
  })

  /**
   * `pipeline` and `saved-search-health` are named in the dashboard spec and do not exist. Listing
   * them as shipped would put two permanently blank tiles on every dashboard.
   */
  it('does not claim a capability that has not shipped', () => {
    expect(SHIPPED_DASHBOARD_CAPABILITIES).not.toContain('pipeline')
    expect(SHIPPED_DASHBOARD_CAPABILITIES).not.toContain('saved-search-health')
  })
})
