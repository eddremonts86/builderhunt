import { describe, expect, it } from 'vitest'
import {
  assertReconciled,
  personalOrganizationId,
  personalOrganizationSlug,
} from '~/shared/lib/migration/backfill'

describe('tenant backfill invariants', () => {
  it('derives stable opaque personal organization identifiers', () => {
    expect(personalOrganizationId('user-a')).toBe(personalOrganizationId('user-a'))
    expect(personalOrganizationSlug('user-a')).toBe(personalOrganizationSlug('user-a'))
    expect(personalOrganizationId('user-a')).not.toBe(personalOrganizationId('user-b'))
    expect(personalOrganizationId('user-a')).not.toContain('user-a')
  })

  it('requires every source row to have one reconciliation outcome', () => {
    expect(() => assertReconciled({ source: 10, migrated: 7, skipped: 1, conflict: 1, orphan: 1 }))
      .not.toThrow()
    expect(() => assertReconciled({ source: 10, migrated: 7, skipped: 1, conflict: 1, orphan: 0 }))
      .toThrow('Backfill reconciliation mismatch')
  })
})
