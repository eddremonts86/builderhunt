export interface ResourceBackfillSurface {
  table: string
  cursorColumn: string
}

export const resourceBackfillSurfaces: readonly ResourceBackfillSurface[] = [
  { table: 'saved_queries', cursorColumn: 'id' },
  { table: 'builders', cursorColumn: 'id' },
  { table: 'alerts', cursorColumn: 'id' },
  { table: 'builder_notes', cursorColumn: 'id' },
  { table: 'alert_triggers', cursorColumn: 'id' },
  { table: 'onboarding_progress', cursorColumn: 'user_id' },
]

export type ResourceBackfillDisposition = 'migrated' | 'skipped' | 'conflict' | 'orphan'

export function classifyResourceRow(input: {
  organizationId: string | null
  personalOrganizationId: string | null
}): ResourceBackfillDisposition {
  if (!input.personalOrganizationId) return 'orphan'
  if (!input.organizationId) return 'migrated'
  return input.organizationId === input.personalOrganizationId ? 'skipped' : 'conflict'
}
