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
  { table: 'onboarding_selected_builders', cursorColumn: 'id' },
]

/**
 * `abuse_signals` also allows a null `organization_id` and is deliberately left
 * out: it is system-operational telemetry with no owning subject (no RLS, wor-
 * ker-role only), and a signal raised before authentication has neither a user
 * nor an organization to attribute. Its nullability is the design, not leftover
 * migration debt, so it is excluded from the backfill and from the cutover's
 * NOT NULL set.
 */

export type ResourceBackfillDisposition = 'migrated' | 'skipped' | 'conflict' | 'orphan'

/**
 * A row that already carries an `organization_id` is done, whichever
 * organization that is. Belonging to a team organization rather than the
 * creator's personal one is the normal shape of shared work, not a conflict —
 * and it stays correct after the creator leaves the team, so membership is not
 * a usable signal either. The only unrecoverable state is a reference that does
 * not resolve to a real organization, which needs a human disposition before
 * `organization_id` can become `NOT NULL`.
 */
export function classifyResourceRow(input: {
  organizationId: string | null
  personalOrganizationId: string | null
  assignedOrganizationExists?: boolean
}): ResourceBackfillDisposition {
  if (input.organizationId) {
    return input.assignedOrganizationExists === false ? 'conflict' : 'skipped'
  }
  if (!input.personalOrganizationId) return 'orphan'
  return 'migrated'
}
