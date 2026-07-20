import { createHash } from 'node:crypto'

export interface ReconciliationCounts {
  source: number
  migrated: number
  skipped: number
  conflict: number
  orphan: number
}

export function personalOrganizationId(userId: string): string {
  return `org_personal_${opaqueUserHash(userId)}`
}

export function personalOrganizationSlug(userId: string): string {
  return `personal-${opaqueUserHash(userId)}`
}

export function assertReconciled(counts: ReconciliationCounts): void {
  const outcomes = counts.migrated + counts.skipped + counts.conflict + counts.orphan
  if (counts.source !== outcomes) {
    throw new Error(`Backfill reconciliation mismatch: source=${counts.source}, outcomes=${outcomes}`)
  }
}

function opaqueUserHash(userId: string): string {
  return createHash('sha256').update(`builderhunt:personal-organization:v1:${userId}`).digest('hex').slice(0, 24)
}
