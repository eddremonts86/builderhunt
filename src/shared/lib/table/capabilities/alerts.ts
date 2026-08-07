import { alerts } from '~/shared/lib/db/schema'

import { defineTableCapability, registerTableCapability } from '../capability'

/**
 * The radars themselves — the list you manage, not the matches they found.
 *
 * `created_at` on this table is nullable (`timestamp('created_at').defaultNow()` with no
 * `.notNull()`), so the keyset predicate emits its null-aware lexicographic form rather than a row
 * comparison. No `nullsLast` declaration: as on every other nullable sort here, the placement
 * follows the scan direction, which is the only way one index serves both.
 */
export const ALERTS_TABLE = 'alerts'

export const ALERT_FREQUENCIES = ['hourly', 'daily', 'weekly'] as const
export const ALERT_CHANNELS = ['email', 'dashboard'] as const

export const alertsCapability = registerTableCapability(defineTableCapability({
  table: ALERTS_TABLE,
  sortable: {
    // Backed by `alerts_org_created_id_idx`.
    createdAt: { column: alerts.createdAt },
    // Backed by `alerts_org_name_id_idx`.
    name: { column: alerts.name },
  },
  filterable: {
    frequency: { column: alerts.frequency, values: ALERT_FREQUENCIES, facet: true },
    deliveryChannel: { column: alerts.deliveryChannel, values: ALERT_CHANNELS, facet: true },
  },
  groupable: [],
  searchable: [alerts.name],
  tiebreaker: alerts.id,
  defaultSort: [{ id: 'createdAt', dir: 'desc' }],
  organizationColumn: alerts.organizationId,
}))

export const ALERT_FILTER_LABELS: Record<string, string> = {
  frequency: 'Frequency',
  deliveryChannel: 'Channel',
}
