import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { organizationEntitlements, organizationPlanChanges } from '~/shared/lib/db/schema'

describe('organization entitlement schema', () => {
  it('owns one entitlement row directly by organization', () => {
    expect(organizationEntitlements.organizationId.primary).toBe(true)
    expect(organizationEntitlements.organizationId.name).toBe('organization_id')
  })

  it('constrains tier and lifecycle status in the database', () => {
    const checks = getTableConfig(organizationEntitlements).checks.map((value) => value.name)
    expect(checks).toEqual(expect.arrayContaining([
      'organization_entitlements_tier_check',
      'organization_entitlements_status_check',
      'organization_entitlements_period_check',
    ]))
  })

  it('records tenant (required) and actor (optional) for plan changes', () => {
    expect(organizationPlanChanges.organizationId.notNull).toBe(true)
    // actorUserId is nullable so system-driven plan changes
    // (e.g. scheduled downgrades, billing-cycle resets) can
    // record a tenant-attributed event without a human actor.
    // Mirrors the convention plan 29 introduced on
    // `organization_activity.actorUserId`.
    expect(organizationPlanChanges.actorUserId.notNull).toBe(false)
  })
})
