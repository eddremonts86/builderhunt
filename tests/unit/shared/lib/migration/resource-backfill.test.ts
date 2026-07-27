import { describe, expect, it } from 'vitest'
import { classifyResourceRow, resourceBackfillSurfaces } from '~/shared/lib/migration/resource-backfill'

describe('tenant resource backfill', () => {
  it('orders parents before tenant-preserving child references', () => {
    expect(resourceBackfillSurfaces.map((surface) => surface.table)).toEqual([
      'saved_queries',
      'builders',
      'alerts',
      'builder_notes',
      'alert_triggers',
      'onboarding_progress',
      'onboarding_selected_builders',
    ])
  })

  it('covers every tenant table the cutover makes NOT NULL', () => {
    // Kept in step with the columns the cutover migration makes NOT NULL. A
    // surface missing here is a table the backfill silently walks past, which
    // then fails the migration on a row nobody knew about. `abuse_signals`
    // stays nullable by design and is deliberately absent.
    expect(new Set(resourceBackfillSurfaces.map((surface) => surface.table))).toEqual(new Set([
      'saved_queries',
      'builders',
      'alerts',
      'builder_notes',
      'alert_triggers',
      'onboarding_progress',
      'onboarding_selected_builders',
    ]))
  })

  it('classifies completed rows, missing users, and migratable rows deterministically', () => {
    expect(classifyResourceRow({ organizationId: null, personalOrganizationId: null })).toBe('orphan')
    expect(classifyResourceRow({ organizationId: null, personalOrganizationId: 'org-a' })).toBe('migrated')
    expect(classifyResourceRow({
      organizationId: 'org-a',
      personalOrganizationId: null,
      assignedOrganizationExists: true,
    })).toBe('skipped')
  })

  it('treats a team organization as assigned rather than as a conflict', () => {
    // The creator's personal organization is irrelevant once a row carries an
    // organization of its own: shared work legitimately lives in a team, and
    // stays there after its creator leaves.
    expect(classifyResourceRow({
      organizationId: 'org-team',
      personalOrganizationId: 'org_personal_abc',
      assignedOrganizationExists: true,
    })).toBe('skipped')
  })

  it('flags an organization reference that does not resolve', () => {
    expect(classifyResourceRow({
      organizationId: 'org-deleted',
      personalOrganizationId: 'org_personal_abc',
      assignedOrganizationExists: false,
    })).toBe('conflict')
  })
})
