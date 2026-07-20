import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { migrationBackfillConflicts, migrationBackfillRuns } from './schema'

describe('backfill operational schema', () => {
  it('persists a resumable cursor and reconciliation counters', () => {
    expect(migrationBackfillRuns.name.primary).toBe(true)
    expect(migrationBackfillRuns.cursor.notNull).toBe(false)
    expect(migrationBackfillRuns.processedCount.notNull).toBe(true)
  })

  it('quarantines only identifiers, reasons, and non-sensitive checksums', () => {
    const columns = getTableConfig(migrationBackfillConflicts).columns.map((column) => column.name)
    expect(columns).toEqual(expect.arrayContaining(['source_table', 'source_id', 'reason', 'checksum']))
    expect(columns).not.toEqual(expect.arrayContaining(['payload', 'email', 'token']))
  })
})
