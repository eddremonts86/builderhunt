export interface TenantReadinessEvidence {
  backfillReconciled: boolean
  shadowMismatchCount: number
  shadowObservationHours: number
  migrationRehearsalPassed: boolean
  databaseRolesPassed: boolean
  rlsDirectSqlPassed: boolean
  tenantApiMatrixPassed: boolean
  workerIsolationPassed: boolean
  restoreRehearsalPassed: boolean
  legacyConsumerCount: number
}

export function assessTenantReadiness(evidence: TenantReadinessEvidence): {
  ready: boolean
  missing: Array<keyof TenantReadinessEvidence>
} {
  const missing: Array<keyof TenantReadinessEvidence> = []
  if (!evidence.backfillReconciled) missing.push('backfillReconciled')
  if (evidence.shadowMismatchCount !== 0) missing.push('shadowMismatchCount')
  if (evidence.shadowObservationHours < 24) missing.push('shadowObservationHours')
  if (!evidence.migrationRehearsalPassed) missing.push('migrationRehearsalPassed')
  if (!evidence.databaseRolesPassed) missing.push('databaseRolesPassed')
  if (!evidence.rlsDirectSqlPassed) missing.push('rlsDirectSqlPassed')
  if (!evidence.tenantApiMatrixPassed) missing.push('tenantApiMatrixPassed')
  if (!evidence.workerIsolationPassed) missing.push('workerIsolationPassed')
  if (!evidence.restoreRehearsalPassed) missing.push('restoreRehearsalPassed')
  if (evidence.legacyConsumerCount !== 0) missing.push('legacyConsumerCount')
  return { ready: missing.length === 0, missing }
}
