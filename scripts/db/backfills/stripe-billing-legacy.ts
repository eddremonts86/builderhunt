/**
 * Imports current manual (non-Stripe) organization entitlements as audited `legacy_manual` credit
 * grant records (plans/stripe-billing-platform/tasks.md §10 "Migrate manual entitlements without
 * charging"). Creates no Stripe Customer, subscription, or charge — ever. Changes NO feature access:
 * `feature-authorization.ts`'s `checkEntitlement` gates the new credit-consuming features on a real
 * `billing_subscriptions` row, never on `organization_entitlements.tier` or credit balance, so a
 * legacy organization's access is completely unaffected by this backfill (see
 * `src/shared/lib/billing/legacy-migration.ts`'s module comment for the full reasoning). This is
 * pure audit bookkeeping: a structured record of "this organization has this much manually-granted
 * allowance, expiring on this date" in the same schema real Stripe grants live in.
 *
 * Mirrors `scripts/db/backfills/organizations.ts`'s exact conventions: `--dry-run`/`--batch-size=N`,
 * resumable via a single `migration_backfill_runs` row (`for update` cursor read each batch),
 * `--confirm-production` guard, conflict quarantine via `migration_backfill_conflicts`.
 *
 * Pool size is 2 (not 1, unlike every sibling script): each batch's `migration_backfill_runs`
 * cursor bookkeeping runs in the OUTER raw-postgres transaction on one connection, while
 * `importLegacyEntitlementAsCredits` (the tested, idempotent business logic — grant + matching
 * ledger entry, exactly what `credits.ts`'s `grantCredits` always writes, never hand-duplicated in
 * raw SQL here) runs in its OWN nested drizzle transaction on a second connection. These two are not
 * atomic with each other, which is deliberately acceptable: `importLegacyEntitlementAsCredits` is
 * idempotent by `monthlyWindowKey`/`idempotencyKey`, so if the outer cursor update fails and this row
 * is reprocessed later, the inner call simply reports `skipped_already_migrated` — never a second grant.
 */
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createHash } from 'node:crypto'
import { assertReconciled, type ReconciliationCounts } from '../../../src/shared/lib/migration/backfill'
import { computeLegacyMigrationChecksum, importLegacyEntitlementAsCredits } from '../../../src/shared/lib/billing/legacy-migration'

const runName = 'stripe-billing-legacy-v1'
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

const database = postgres(connectionUrl, { max: 2, prepare: false })
const db = drizzle(database)

let dryRunCursor = ''
const dryRunCounts: ReconciliationCounts = { source: 0, migrated: 0, skipped: 0, conflict: 0, orphan: 0 }
const migratedRecords: Array<{ organizationId: string; tier: string; units: number; expiresAt: Date }> = []

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

      const [state] = dryRun
        ? [{ cursor: dryRunCursor, status: 'running' }]
        : await transaction<{ cursor: string | null; status: string }[]>`
            select cursor, status from migration_backfill_runs where name = ${runName} for update
          `
      if (!state) return { complete: true, processed: 0 }
      if (state.status === 'completed') return { complete: true, processed: 0 }

      const rows = await transaction<{
        organization_id: string
        tier: string
        current_period_end: Date | null
        trial_ends_at: Date | null
      }[]>`
        select e.organization_id, e.tier, e.current_period_end, e.trial_ends_at
        from organization_entitlements e
        left join billing_subscriptions s on s.organization_id = e.organization_id and s.canceled_at is null
        where e.tier != 'free' and s.id is null and e.organization_id > ${state.cursor ?? ''}
        order by e.organization_id
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
        // Raw postgres.js query results aren't guaranteed to already be `Date` instances the way
        // drizzle-mapped reads are (dry-run testing against a real database caught this) — coerce
        // explicitly before handing off to drizzle-typed logic that assumes a real `Date`. `dryRun`
        // is threaded through explicitly: `importLegacyEntitlementAsCredits`'s dry-run path never
        // calls `grantCredits`, so this is a genuine no-write check, not a write-then-rollback one.
        const outcome = await db.transaction((tx) => importLegacyEntitlementAsCredits(tx, {
          organizationId: row.organization_id,
          tier: row.tier,
          currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end) : null,
          trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at) : null,
        }, new Date(), dryRun))

        if (outcome.outcome === 'migrated') {
          batchCounts.migrated += 1
          migratedRecords.push({ organizationId: row.organization_id, tier: row.tier, units: outcome.units, expiresAt: outcome.expiresAt })
        } else if (outcome.outcome === 'would_migrate') {
          batchCounts.migrated += 1
          migratedRecords.push({ organizationId: row.organization_id, tier: row.tier, units: outcome.units, expiresAt: outcome.expiresAt })
        } else if (outcome.outcome === 'conflict_unresolvable_tier') {
          batchCounts.conflict += 1
          if (!dryRun) {
            const reason = 'unresolvable-legacy-tier'
            await transaction`
              insert into migration_backfill_conflicts (run_name, source_table, source_id, reason, checksum)
              values (${runName}, 'organization_entitlements', ${row.organization_id}, ${reason}, ${conflictChecksum(row.organization_id, reason)})
              on conflict (run_name, source_table, source_id, reason) do nothing
            `
          }
        } else {
          // skipped_free_tier / skipped_already_has_subscription / skipped_already_migrated — all
          // expected, non-conflicting outcomes (the WHERE clause already excludes free-tier and
          // subscribed orgs, so in practice only a rerun's skipped_already_migrated lands here).
          batchCounts.skipped += 1
        }
      }

      const cursor = rows.at(-1)!.organization_id
      if (dryRun) {
        dryRunCursor = cursor
        dryRunCounts.source += rows.length
        dryRunCounts.migrated += batchCounts.migrated
        dryRunCounts.skipped += batchCounts.skipped
        dryRunCounts.conflict += batchCounts.conflict
      } else {
        await transaction`
          update migration_backfill_runs
          set cursor = ${cursor},
              processed_count = processed_count + ${rows.length},
              migrated_count = migrated_count + ${batchCounts.migrated},
              skipped_count = skipped_count + ${batchCounts.skipped},
              conflict_count = conflict_count + ${batchCounts.conflict},
              updated_at = now()
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

  // The checksum must reflect the STABLE, persisted set of migrated records, not just what THIS
  // invocation newly granted — a rerun that finds everything already migrated would otherwise
  // produce an empty (and therefore different) checksum from `migratedRecords`, violating "rerun
  // checksum is stable". A dry run has nothing persisted to query, so it checksums the simulated set.
  const checksumRecords = dryRun ? migratedRecords : await currentlyMigratedRecords()
  const checksum = computeLegacyMigrationChecksum(checksumRecords)
  if (!dryRun) {
    await database`update migration_backfill_runs set checksum = ${checksum}, updated_at = now() where name = ${runName}`
  }

  console.log(JSON.stringify({ run: runName, dryRun, status: 'completed', counts, checksum }))
} catch (error) {
  if (!dryRun) {
    await database`
      update migration_backfill_runs
      set status = 'failed', updated_at = now()
      where name = ${runName} and status <> 'completed'
    `.catch(() => undefined)
  }
  throw error
} finally {
  await database.end({ timeout: 5 })
}

async function persistedCounts(): Promise<ReconciliationCounts> {
  const [state] = await database<{
    processed_count: number
    migrated_count: number
    skipped_count: number
    conflict_count: number
  }[]>`
    select processed_count, migrated_count, skipped_count, conflict_count
    from migration_backfill_runs where name = ${runName}
  `
  const [{ source }] = await database<{ source: number }[]>`
    select count(*)::int as source
    from organization_entitlements e
    left join billing_subscriptions s on s.organization_id = e.organization_id and s.canceled_at is null
    where e.tier != 'free' and s.id is null
  `
  return {
    source,
    migrated: state?.migrated_count ?? 0,
    skipped: state?.skipped_count ?? 0,
    conflict: state?.conflict_count ?? 0,
    orphan: 0,
  }
}

function conflictChecksum(sourceId: string, reason: string): string {
  return createHash('sha256').update(`organization_entitlements:${sourceId}:${reason}`).digest('hex')
}

async function currentlyMigratedRecords(): Promise<Array<{ organizationId: string; tier: string; units: number; expiresAt: Date }>> {
  const rows = await database<{ organization_id: string; tier: string; units: number; expires_at: Date }[]>`
    select g.organization_id, e.tier, g.original_units as units, g.expires_at
    from billing_credit_grants g
    join organization_entitlements e on e.organization_id = g.organization_id
    where g.source = 'legacy_manual'
    order by g.organization_id
  `
  return rows.map((row) => ({ organizationId: row.organization_id, tier: row.tier, units: row.units, expiresAt: new Date(row.expires_at) }))
}
