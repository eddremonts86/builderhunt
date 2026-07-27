import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  alerts,
  alertTriggers,
  builderNotes,
  builders,
  onboardingProgress,
  onboardingSelectedBuilders,
  savedQueries,
} from './schema'

/** Every table the canonical cutover (drizzle/0081) made non-nullable. */
const tenantTables = [
  builders,
  savedQueries,
  alerts,
  alertTriggers,
  builderNotes,
  onboardingProgress,
  onboardingSelectedBuilders,
]

/**
 * `onboarding_selected_builders` is keyed by (organization_id, user_id) through
 * its parent rather than by (organization_id, id), so it has no
 * `_organization_id_id_unique` index of its own.
 */
const candidateKeyTables = [builders, savedQueries, alerts, alertTriggers, builderNotes, onboardingProgress]

describe('tenant schema', () => {
  it('requires an organization on every tenant-private table', () => {
    // The expand phase left this column nullable so pre-multi-tenancy rows
    // could survive until the backfill reached them. The cutover closed that
    // window, and the RLS policies have always assumed a non-null tenant.
    for (const table of tenantTables) {
      expect(table.organizationId.name).toBe('organization_id')
      expect(table.organizationId.notNull).toBe(true)
    }
  })

  it('provides an organization-preserving candidate key on every private table', () => {
    for (const table of candidateKeyTables) {
      const config = getTableConfig(table)
      const expected = `${config.name}_organization_id_id_unique`
      expect(config.indexes.map((value) => value.config.name)).toContain(expected)
    }
  })

  it('adds composite tenant foreign keys alongside compatibility foreign keys', () => {
    const names = [alerts, alertTriggers, builderNotes]
      .flatMap((table) => getTableConfig(table).foreignKeys.map((key) => key.getName()))

    expect(names).toEqual(expect.arrayContaining([
      'alerts_organization_query_fk',
      'alert_triggers_organization_alert_fk',
      'builder_notes_organization_builder_fk',
    ]))
  })
})
