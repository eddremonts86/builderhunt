import { describe, expect, it } from 'vitest'
import { assessTenantReadiness, type TenantReadinessEvidence } from './tenant-readiness'

const complete: TenantReadinessEvidence = {
  backfillReconciled: true,
  shadowMismatchCount: 0,
  shadowObservationHours: 24,
  migrationRehearsalPassed: true,
  databaseRolesPassed: true,
  rlsDirectSqlPassed: true,
  tenantApiMatrixPassed: true,
  workerIsolationPassed: true,
  restoreRehearsalPassed: true,
  legacyConsumerCount: 0,
}

describe('tenant cutover readiness', () => {
  it('accepts only complete evidence', () => {
    expect(assessTenantReadiness(complete)).toEqual({ ready: true, missing: [] })
  })

  it.each(Object.keys(complete) as Array<keyof TenantReadinessEvidence>)(
    'rejects missing or invalid %s evidence',
    (key) => {
      const invalid = { ...complete }
      if (typeof invalid[key] === 'boolean') Object.assign(invalid, { [key]: false })
      else Object.assign(invalid, { [key]: key === 'shadowMismatchCount' || key === 'legacyConsumerCount' ? 1 : 0 })
      expect(assessTenantReadiness(invalid)).toMatchObject({ ready: false })
      expect(assessTenantReadiness(invalid).missing).toContain(key)
    },
  )
})
