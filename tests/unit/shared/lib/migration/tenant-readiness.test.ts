import { describe, expect, it } from 'vitest'
import { assessTenantReadiness, type TenantReadinessEvidence } from '~/shared/lib/migration/tenant-readiness'

const complete: TenantReadinessEvidence = {
  backfillReconciled: true,
  nullTenantRowCount: 0,
  unresolvedBackfillConflictCount: 0,
  legacyConsumerCount: 0,
  migrationRehearsalPassed: true,
  databaseRolesPassed: true,
  rlsDirectSqlPassed: true,
  tenantApiMatrixPassed: true,
  workerIsolationPassed: true,
  restoreRehearsalPassed: true,
}

describe('tenant cutover readiness', () => {
  it('accepts only complete evidence', () => {
    expect(assessTenantReadiness(complete)).toEqual({ ready: true, missing: [] })
  })

  it.each(Object.keys(complete) as Array<keyof TenantReadinessEvidence>)(
    'rejects missing or invalid %s evidence',
    (key) => {
      const invalid = { ...complete }
      // Every count is a violation counter: zero is the only passing value, so
      // any non-zero must be rejected.
      if (typeof invalid[key] === 'boolean') Object.assign(invalid, { [key]: false })
      else Object.assign(invalid, { [key]: 1 })
      expect(assessTenantReadiness(invalid)).toMatchObject({ ready: false })
      expect(assessTenantReadiness(invalid).missing).toContain(key)
    },
  )

  it('does not gate on a shadow-read observation window', () => {
    // Regression guard for the criterion this gate replaced: legacy and
    // canonical reads diverge by design once an organization has two
    // contributing members, so a zero-mismatch window can never be produced.
    expect(Object.keys(complete)).not.toContain('shadowMismatchCount')
    expect(Object.keys(complete)).not.toContain('shadowObservationHours')
  })
})
