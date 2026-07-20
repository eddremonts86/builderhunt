import { describe, expect, it } from 'vitest'
import { classifyResourceRow, resourceBackfillSurfaces } from './resource-backfill'

describe('tenant resource backfill', () => {
  it('orders parents before tenant-preserving child references', () => {
    expect(resourceBackfillSurfaces.map((surface) => surface.table)).toEqual([
      'saved_queries',
      'builders',
      'alerts',
      'builder_notes',
      'alert_triggers',
      'onboarding_progress',
    ])
  })

  it('classifies completed rows, missing users, and migratable rows deterministically', () => {
    expect(classifyResourceRow({ organizationId: 'org-a', personalOrganizationId: 'org-a' })).toBe('skipped')
    expect(classifyResourceRow({ organizationId: null, personalOrganizationId: null })).toBe('orphan')
    expect(classifyResourceRow({ organizationId: null, personalOrganizationId: 'org-a' })).toBe('migrated')
    expect(classifyResourceRow({ organizationId: 'org-b', personalOrganizationId: 'org-a' })).toBe('conflict')
  })
})
