import postgres from 'postgres'
import { personalOrganizationId, personalOrganizationSlug } from '../../../src/shared/lib/migration/backfill'

const runName = 'personal-organizations-v1'
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

const sql = postgres(connectionUrl, { max: 1, prepare: false })
let dryRunCursor = ''
let dryRunCount = 0

try {
  if (!dryRun) {
    await sql`
      insert into migration_backfill_runs (name, status, started_at, updated_at)
      values (${runName}, 'running', now(), now())
      on conflict (name) do update
      set status = case when migration_backfill_runs.status = 'completed' then 'completed' else 'running' end,
          updated_at = now()
    `
  }

  while (true) {
    const result = await sql.begin(async (transaction) => {
      await transaction.unsafe("set local lock_timeout = '2s'")
      await transaction.unsafe("set local statement_timeout = '30s'")

      const [state] = dryRun
        ? [{ cursor: dryRunCursor, status: 'running', processed_count: dryRunCount, migrated_count: 0, skipped_count: 0 }]
        : await transaction<{
            cursor: string | null
            status: string
            processed_count: number
            migrated_count: number
            skipped_count: number
          }[]>`
            select cursor, status, processed_count, migrated_count, skipped_count
            from migration_backfill_runs
            where name = ${runName}
            for update
          `

      if (!state || state.status === 'completed') return { complete: true, processed: 0 }

      const users = await transaction<{
        id: string
        plan: string | null
        status: string | null
        plan_ends_at: Date | null
        trial_ends_at: Date | null
        notes: string | null
      }[]>`
        select u.id, p.plan, p.status, p.plan_ends_at, p.trial_ends_at, p.notes
        from auth_users u
        left join plans p on p.user_id = u.id
        where u.id > ${state.cursor ?? ''}
        order by u.id
        limit ${batchSize}
      `

      if (users.length === 0) {
        if (!dryRun) {
          await transaction`
            update migration_backfill_runs
            set status = 'completed', completed_at = now(), updated_at = now()
            where name = ${runName}
          `
        }
        return { complete: true, processed: 0 }
      }

      let migrated = 0
      let skipped = 0
      for (const user of users) {
        const organizationId = personalOrganizationId(user.id)
        if (dryRun) {
          migrated += 1
          continue
        }

        const inserted = await transaction<{ id: string }[]>`
          insert into organizations (id, name, slug, metadata, created_at)
          values (${organizationId}, 'Personal workspace', ${personalOrganizationSlug(user.id)}, ${JSON.stringify({ kind: 'personal', version: 1 })}, now())
          on conflict (id) do nothing
          returning id
        `
        if (inserted.length === 1) migrated += 1
        else skipped += 1

        await transaction`
          insert into organization_members (id, organization_id, user_id, role, created_at)
          values (${`${organizationId}:owner`}, ${organizationId}, ${user.id}, 'owner', now())
          on conflict (organization_id, user_id) do nothing
        `

        const tier = asTier(user.plan)
        const status = asStatus(user.status)
        await transaction`
          insert into organization_entitlements (
            organization_id, tier, status, billing_period, current_period_end,
            trial_ends_at, seat_limit, notes, created_at, updated_at
          ) values (
            ${organizationId}, ${tier}, ${status}, 'none', ${user.plan_ends_at},
            ${user.trial_ends_at}, ${tier === 'team' ? 10 : 1}, ${user.notes}, now(), now()
          )
          on conflict (organization_id) do nothing
        `
      }

      const cursor = users.at(-1)!.id
      if (dryRun) {
        dryRunCursor = cursor
        dryRunCount += users.length
      } else {
        await transaction`
          update migration_backfill_runs
          set cursor = ${cursor},
              processed_count = processed_count + ${users.length},
              migrated_count = migrated_count + ${migrated},
              skipped_count = skipped_count + ${skipped},
              updated_at = now()
          where name = ${runName}
        `
      }

      return { complete: false, processed: users.length }
    })

    if (result.complete) break
    console.log(JSON.stringify({ run: runName, dryRun, processedBatch: result.processed }))
  }

  console.log(JSON.stringify({ run: runName, dryRun, status: 'completed', processed: dryRun ? dryRunCount : undefined }))
} catch (error) {
  if (!dryRun) {
    await sql`
      update migration_backfill_runs
      set status = 'failed', updated_at = now()
      where name = ${runName} and status <> 'completed'
    `.catch(() => undefined)
  }
  throw error
} finally {
  await sql.end({ timeout: 5 })
}

function asTier(value: string | null): 'free' | 'pro' | 'team' {
  return value === 'pro' || value === 'team' ? value : 'free'
}

function asStatus(value: string | null): 'active' | 'past_due' | 'canceled' | 'trialing' {
  return value === 'past_due' || value === 'canceled' || value === 'trialing' ? value : 'active'
}
