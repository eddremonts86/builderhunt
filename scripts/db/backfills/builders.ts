import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { assertReconciled, type ReconciliationCounts } from '../../../src/shared/lib/migration/backfill'
import {
  builderIdentityId,
  builderSnapshotHash,
  classifyLegacyBuilder,
} from '../../../src/shared/lib/migration/builder-backfill'

const runName = 'builder-normalization-v1'
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
let dryRunCursor = ''
const dryRunCounts: ReconciliationCounts = { source: 0, migrated: 0, skipped: 0, conflict: 0, orphan: 0 }

try {
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

      const rows = await transaction<LegacyBuilder[]>`
        select b.*,
               exists (
                 select 1 from migration_backfill_conflicts c
                 where c.run_name = 'tenant-resources-v1:builders'
                   and c.source_table = 'builders'
                   and c.source_id = b.id
                   and c.resolved_at is null
               ) as has_resource_conflict
        from builders b
        where b.id > ${state.cursor ?? ''}
        order by b.id
        limit ${batchSize}
      `
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
        const disposition = classifyLegacyBuilder({
          organizationId: row.organization_id,
          hasResourceConflict: row.has_resource_conflict,
          isClaimed: row.is_claimed,
          isVerified: row.is_verified,
        })
        if (disposition !== 'migrated') {
          batchCounts[disposition] += 1
          if (!dryRun) await quarantine(transaction, row, disposition)
          continue
        }

        if (dryRun) {
          batchCounts.migrated += 1
          continue
        }

        const identityId = builderIdentityId(row.source, row.source_id)
        const snapshot = publicSnapshot(row)
        await transaction`
          insert into builder_identities (
            id, source, source_id, username, display_name, avatar_url, bio, profile_url,
            followers_count, language, country, first_seen_at, last_seen_at, created_at, updated_at
          ) values (
            ${identityId}, ${row.source}, ${row.source_id}, ${row.username}, ${row.display_name},
            ${row.avatar_url}, ${row.bio}, ${row.profile_url}, ${row.followers_count ?? 0},
            ${row.language}, ${row.country}, ${row.first_seen ?? new Date()},
            ${row.last_seen ?? new Date()}, now(), now()
          ) on conflict (source, source_id) do nothing
        `
        await transaction`
          insert into builder_source_snapshots (builder_identity_id, content_hash, payload, observed_at)
          values (${identityId}, ${builderSnapshotHash(snapshot)}, ${database.json(snapshot)}, ${row.last_seen ?? new Date()})
          on conflict (builder_identity_id, content_hash) do nothing
        `
        const inserted = await transaction<{ id: string }[]>`
          insert into organization_builders (
            id, organization_id, builder_identity_id, creator_user_id,
            visibility, status, private_metadata, created_at, updated_at
          ) values (
            ${row.id}, ${row.organization_id}, ${identityId}, ${row.user_id}, 'private', 'tracked',
            ${database.json({ topics: row.topics ?? [], metadata: row.metadata ?? {}, legacyBuilderId: row.id })},
            ${row.created_at ?? new Date()}, ${row.updated_at ?? new Date()}
          ) on conflict (organization_id, builder_identity_id) do nothing
          returning id
        `
        if (inserted.length === 1) batchCounts.migrated += 1
        else batchCounts.skipped += 1
      }

      const cursor = rows.at(-1)!.id
      if (dryRun) {
        dryRunCursor = cursor
        dryRunCounts.source += rows.length
        dryRunCounts.migrated += batchCounts.migrated
        dryRunCounts.skipped += batchCounts.skipped
        dryRunCounts.conflict += batchCounts.conflict
        dryRunCounts.orphan += batchCounts.orphan
      } else {
        await transaction`
          update migration_backfill_runs
          set cursor = ${cursor}, processed_count = processed_count + ${rows.length},
              migrated_count = migrated_count + ${batchCounts.migrated},
              skipped_count = skipped_count + ${batchCounts.skipped},
              conflict_count = conflict_count + ${batchCounts.conflict},
              orphan_count = orphan_count + ${batchCounts.orphan}, updated_at = now()
          where name = ${runName}
        `
      }
      return { complete: false, processed: rows.length }
    })
    if (result.complete) break
    console.log(JSON.stringify({ run: runName, dryRun, processedBatch: result.processed }))
  }

  const counts = dryRun ? dryRunCounts : await persistedCounts()
  assertReconciled(counts)
  console.log(JSON.stringify({ run: runName, dryRun, status: 'completed', counts }))
} catch (error) {
  if (!dryRun) {
    await database`update migration_backfill_runs set status = 'failed', updated_at = now() where name = ${runName} and status <> 'completed'`
      .catch(() => undefined)
  }
  throw error
} finally {
  await database.end({ timeout: 5 })
}

interface LegacyBuilder {
  id: string
  organization_id: string | null
  user_id: string
  source: string
  source_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  profile_url: string
  followers_count: number | null
  language: string | null
  country: string | null
  topics: string[] | null
  metadata: Record<string, unknown> | null
  first_seen: Date | null
  last_seen: Date | null
  created_at: Date | null
  updated_at: Date | null
  is_claimed: boolean
  is_verified: boolean
  has_resource_conflict: boolean
}

function publicSnapshot(row: LegacyBuilder): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provenance: { source: row.source, sourceId: row.source_id },
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    profileUrl: row.profile_url,
    followersCount: row.followers_count ?? 0,
    language: row.language,
    country: row.country,
  }
}

async function quarantine(
  transaction: postgres.TransactionSql,
  row: LegacyBuilder,
  disposition: 'conflict' | 'orphan',
) {
  const reason = disposition === 'orphan'
    ? 'tenant-organization-missing'
    : row.has_resource_conflict
      ? 'tenant-organization-conflict'
      : 'legacy-claim-requires-review'
  const checksum = createHash('sha256').update(`builders:${row.id}:${reason}`).digest('hex')
  await transaction`
    insert into migration_backfill_conflicts (run_name, source_table, source_id, reason, checksum)
    values (${runName}, 'builders', ${row.id}, ${reason}, ${checksum})
    on conflict (run_name, source_table, source_id, reason) do nothing
  `
}

async function persistedCounts(): Promise<ReconciliationCounts> {
  const [state] = await database<{
    migrated_count: number
    skipped_count: number
    conflict_count: number
    orphan_count: number
  }[]>`
    select migrated_count, skipped_count, conflict_count, orphan_count
    from migration_backfill_runs where name = ${runName}
  `
  const [{ source }] = await database<{ source: number }[]>`select count(*)::int as source from builders`
  return {
    source,
    migrated: state?.migrated_count ?? 0,
    skipped: state?.skipped_count ?? 0,
    conflict: state?.conflict_count ?? 0,
    orphan: state?.orphan_count ?? 0,
  }
}
