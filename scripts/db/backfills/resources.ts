import { createHash } from 'node:crypto'
import postgres from 'postgres'
import {
  assertReconciled,
  personalOrganizationId,
  type ReconciliationCounts,
} from '../../../src/shared/lib/migration/backfill'
import {
  classifyResourceRow,
  resourceBackfillSurfaces,
  type ResourceBackfillDisposition,
} from '../../../src/shared/lib/migration/resource-backfill'

const dryRun = process.argv.includes('--dry-run')
const batchArgument = process.argv.find((argument) => argument.startsWith('--batch-size='))
const batchSize = Number(batchArgument?.split('=')[1] ?? 250)

if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 2_000) {
  throw new Error('Batch size must be an integer between 1 and 2000')
}
if (process.env.NODE_ENV === 'production' && !process.argv.includes('--confirm-production')) {
  throw new Error('Production backfill requires --confirm-production after an approved restore point')
}

const connectionUrl = process.env.DATABASE_MIGRATION_URL
  ?? (process.env.NODE_ENV === 'production' ? undefined : process.env.DATABASE_URL)
if (!connectionUrl) throw new Error('DATABASE_MIGRATION_URL is required')

const database = postgres(connectionUrl, { max: 1, prepare: false })

try {
  for (const surface of resourceBackfillSurfaces) {
    await backfillSurface(surface.table, surface.cursorColumn)
  }
} finally {
  await database.end({ timeout: 5 })
}

async function backfillSurface(table: string, cursorColumn: string) {
  const runName = `tenant-resources-v1:${table}`
  let dryRunCursor = ''
  const dryRunCounts: ReconciliationCounts = { source: 0, migrated: 0, skipped: 0, conflict: 0, orphan: 0 }

  if (!dryRun) {
    await database`
      insert into migration_backfill_runs (name, status, started_at, updated_at)
      values (${runName}, 'running', now(), now())
      on conflict (name) do update
      set status = case when migration_backfill_runs.status = 'completed' then 'completed' else 'running' end,
          updated_at = now()
    `
  }

  while (true) {
    const result = await database.begin(async (transaction) => {
      await transaction.unsafe("set local lock_timeout = '2s'")
      await transaction.unsafe("set local statement_timeout = '30s'")

      const state = dryRun
        ? { cursor: dryRunCursor, status: 'running' }
        : (await transaction<{ cursor: string | null; status: string }[]>`
            select cursor, status from migration_backfill_runs where name = ${runName} for update
          `)[0]
      if (!state) throw new Error(`Missing backfill state for ${runName}`)
      if (state.status === 'completed') return { complete: true, processed: 0 }

      const rows = await transaction.unsafe<Array<{
        cursor: string
        user_id: string
        organization_id: string | null
      }>>(resourceSelectSql(table, cursorColumn), [state.cursor ?? '', batchSize])

      if (rows.length === 0) {
        if (!dryRun) {
          await transaction`
            update migration_backfill_runs
            set status = 'completed', completed_at = now(), updated_at = now()
            where name = ${runName}
          `
        }
        return { complete: true, processed: 0 }
      }

      const batchCounts = { migrated: 0, skipped: 0, conflict: 0, orphan: 0 }
      for (const row of rows) {
        const expectedOrganizationId = personalOrganizationId(row.user_id)
        const [organization] = await transaction<{ id: string }[]>`
          select id from organizations where id = ${expectedOrganizationId} limit 1
        `
        const disposition = classifyResourceRow({
          organizationId: row.organization_id,
          personalOrganizationId: organization?.id ?? null,
        })
        batchCounts[disposition] += 1

        if (!dryRun && disposition === 'migrated') {
          await transaction.unsafe(
            `update ${table} set organization_id = $1 where ${cursorColumn} = $2 and organization_id is null`,
            [expectedOrganizationId, row.cursor],
          )
        } else if (!dryRun && (disposition === 'conflict' || disposition === 'orphan')) {
          const reason = conflictReason(disposition)
          await transaction`
            insert into migration_backfill_conflicts (run_name, source_table, source_id, reason, checksum)
            values (${runName}, ${table}, ${row.cursor}, ${reason}, ${conflictChecksum(table, row.cursor, reason)})
            on conflict (run_name, source_table, source_id, reason) do nothing
          `
        }
      }

      const cursor = rows.at(-1)!.cursor
      if (dryRun) {
        dryRunCursor = cursor
        dryRunCounts.source += rows.length
        addCounts(dryRunCounts, batchCounts)
      } else {
        await transaction`
          update migration_backfill_runs
          set cursor = ${cursor},
              processed_count = processed_count + ${rows.length},
              migrated_count = migrated_count + ${batchCounts.migrated},
              skipped_count = skipped_count + ${batchCounts.skipped},
              conflict_count = conflict_count + ${batchCounts.conflict},
              orphan_count = orphan_count + ${batchCounts.orphan},
              updated_at = now()
          where name = ${runName}
        `
      }
      return { complete: false, processed: rows.length }
    })

    if (result.complete) break
    console.log(JSON.stringify({ run: runName, dryRun, processedBatch: result.processed }))
  }

  const counts = dryRun ? dryRunCounts : await persistedCounts(runName, table)
  assertReconciled(counts)
  console.log(JSON.stringify({ run: runName, dryRun, status: 'completed', counts }))
}

function resourceSelectSql(table: string, cursorColumn: string) {
  return `
    select r.${cursorColumn}::text as cursor,
           r.user_id,
           r.organization_id
    from ${table} r
    where r.${cursorColumn}::text > $1
    order by r.${cursorColumn}
    limit $2
  `
}

async function persistedCounts(runName: string, table: string): Promise<ReconciliationCounts> {
  const [state] = await database<{
    processed_count: number
    migrated_count: number
    skipped_count: number
    conflict_count: number
    orphan_count: number
  }[]>`
    select processed_count, migrated_count, skipped_count, conflict_count, orphan_count
    from migration_backfill_runs where name = ${runName}
  `
  const [{ source }] = await database.unsafe<Array<{ source: number }>>(
    `select count(*)::int as source from ${table}`,
  )
  return {
    source,
    migrated: state?.migrated_count ?? 0,
    skipped: state?.skipped_count ?? 0,
    conflict: state?.conflict_count ?? 0,
    orphan: state?.orphan_count ?? 0,
  }
}

function addCounts(target: ReconciliationCounts, source: Omit<ReconciliationCounts, 'source'>) {
  target.migrated += source.migrated
  target.skipped += source.skipped
  target.conflict += source.conflict
  target.orphan += source.orphan
}

function conflictReason(disposition: ResourceBackfillDisposition) {
  return disposition === 'orphan' ? 'personal-organization-missing' : 'organization-mismatch'
}

function conflictChecksum(table: string, sourceId: string, reason: string) {
  return createHash('sha256').update(`${table}:${sourceId}:${reason}`).digest('hex')
}
