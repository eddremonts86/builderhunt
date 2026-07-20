import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  alerts,
  alertTriggers,
  builderNotes,
  builders,
  onboardingProgress,
  savedQueries,
} from './schema'

const tenantTables = [builders, savedQueries, alerts, alertTriggers, builderNotes, onboardingProgress]

describe('tenant expand schema', () => {
  it('adds a nullable organization key without breaking legacy rows', () => {
    for (const table of tenantTables) {
      expect(table.organizationId.name).toBe('organization_id')
      expect(table.organizationId.notNull).toBe(false)
    }
  })

  it('provides an organization-preserving candidate key on every private table', () => {
    for (const table of tenantTables) {
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
