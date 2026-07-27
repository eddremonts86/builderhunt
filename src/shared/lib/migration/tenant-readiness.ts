/**
 * The gate that keeps `TENANT_CANONICAL_READY` — and with it canonical tenant
 * mode — off until the cutover is actually safe.
 *
 * This used to require a 24-hour shadow-read window with zero mismatches. That
 * criterion was unsatisfiable and proved nothing here. Shadow reading assumes
 * the old and new queries *should* agree, but the whole point of this cutover
 * is that they disagree: the legacy read answers "the saved searches I created"
 * and the canonical read answers "my organization's saved searches". Any
 * organization with two contributing members diverges permanently and by
 * design, so the counter could only reach zero in a deployment where nobody
 * used shared workspaces — exactly the case the cutover does not need to be
 * safe for. It was also only ever wired into a single route, with no write-side
 * caller at all, so it observed a sliver of the system.
 *
 * The criteria below replace it with what the `NOT NULL` cutover can actually
 * fail on: a row with no tenant, an unreconciled backfill, an unresolved
 * conflict, a query that ignores the organization, or a migration nobody
 * rehearsed under the real least-privilege roles.
 */
export interface TenantReadinessEvidence {
  backfillReconciled: boolean
  nullTenantRowCount: number
  unresolvedBackfillConflictCount: number
  legacyConsumerCount: number
  migrationRehearsalPassed: boolean
  databaseRolesPassed: boolean
  rlsDirectSqlPassed: boolean
  tenantApiMatrixPassed: boolean
  workerIsolationPassed: boolean
  restoreRehearsalPassed: boolean
}

export function assessTenantReadiness(evidence: TenantReadinessEvidence): {
  ready: boolean
  missing: Array<keyof TenantReadinessEvidence>
} {
  const missing: Array<keyof TenantReadinessEvidence> = []
  if (!evidence.backfillReconciled) missing.push('backfillReconciled')
  if (evidence.nullTenantRowCount !== 0) missing.push('nullTenantRowCount')
  if (evidence.unresolvedBackfillConflictCount !== 0) missing.push('unresolvedBackfillConflictCount')
  if (evidence.legacyConsumerCount !== 0) missing.push('legacyConsumerCount')
  if (!evidence.migrationRehearsalPassed) missing.push('migrationRehearsalPassed')
  if (!evidence.databaseRolesPassed) missing.push('databaseRolesPassed')
  if (!evidence.rlsDirectSqlPassed) missing.push('rlsDirectSqlPassed')
  if (!evidence.tenantApiMatrixPassed) missing.push('tenantApiMatrixPassed')
  if (!evidence.workerIsolationPassed) missing.push('workerIsolationPassed')
  if (!evidence.restoreRehearsalPassed) missing.push('restoreRehearsalPassed')
  return { ready: missing.length === 0, missing }
}
