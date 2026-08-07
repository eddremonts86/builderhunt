import { alertTriggers } from '~/shared/lib/db/schema'

import { defineTableCapability, registerTableCapability } from '../capability'

/**
 * The alerts inbox — one row per match, grouped by the radar that found it.
 *
 * ## Why `alertId` is sortable
 *
 * Grouping is only readable when the group column leads the `ORDER BY`, and `resolveSort` only
 * leads with it when it is sortable (see the comment there: grouping sprint results by an
 * unsortable column produced 36 headers for 50 rows). So `alertId` is a sort even though nobody
 * would choose it as one — it exists to make the grouping contiguous.
 *
 * That means the real grouped query orders by `(alert_id, matched_at, id)`, which
 * `alert_triggers_org_alert_matched_id_idx` serves. Plan 04's guard checks each sortable column in
 * isolation and cannot see a composite ordering, so it separately demands
 * `(organization_id, alert_id, id)` and `(organization_id, matched_at, id)` — both of which are
 * real single-column sorts a URL can ask for. All three exist. The guard's blind spot is recorded
 * against plan 04.
 *
 * ## Nothing is searchable
 *
 * The only text a person would search is the matched builder's name, and it lives inside the
 * `payload` jsonb. A `->>'username'` expression is filterable and groupable but deliberately not
 * *searchable* — `searchable` is typed `PgColumn[]`, because an `ILIKE` over an unindexed jsonb path
 * on every keystroke is a table scan per keystroke. The inbox passes `searchable={false}` so the box
 * is absent rather than dead.
 */
export const ALERT_TRIGGERS_TABLE = 'alert_triggers'

export const ALERT_EVENT_TYPES = ['new_repo', 'new_product', 'keyword_match', 'any_activity'] as const

export const alertTriggersCapability = registerTableCapability(defineTableCapability({
  table: ALERT_TRIGGERS_TABLE,
  sortable: {
    // Backed by `alert_triggers_org_matched_id_idx`.
    matchedAt: { column: alertTriggers.matchedAt },
    // Backed by `alert_triggers_org_alert_id_idx`; the grouped walk uses the composite one.
    alertId: { column: alertTriggers.alertId },
  },
  filterable: {
    /*
     * Faceted, and the facet is what makes a group header honest.
     *
     * The counts come back keyed by `alert_id` over the whole filtered set, and `GroupRow` shows
     * that number rather than the loaded one — which is the defect this surface had: `groupByAlert`
     * counted the 50 triggers the browser held and printed "3 matches" for a radar with 300.
     */
    alertId: { column: alertTriggers.alertId, facet: true },
    eventType: { column: alertTriggers.eventType, values: ALERT_EVENT_TYPES, facet: true },
  },
  groupable: ['alertId'],
  searchable: [],
  tiebreaker: alertTriggers.id,
  defaultSort: [{ id: 'matchedAt', dir: 'desc' }],
  organizationColumn: alertTriggers.organizationId,
}))

export const ALERT_TRIGGER_FILTER_LABELS: Record<string, string> = {
  alertId: 'Radar',
  eventType: 'Match type',
}
