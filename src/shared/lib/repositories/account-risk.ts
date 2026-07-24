import { eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { accountRisk } from '../db/schema'

/**
 * Account-subject (`user_id`), RLS-protected for both `builderhunt_worker` and
 * `builderhunt_platform` — `builderhunt_app` has NO grant at all on this table
 * (see `drizzle/0044_abuse_usage_integrity_rls_grants.sql`): an account's risk
 * score/stage is written exclusively by trusted worker/platform paths, never
 * the browser-facing role. Same per-subject transaction-scoping pattern as
 * `repositories/billing-worker.ts`'s `withWorkerOrganization`, but scoped by
 * `app.user_id` instead of `app.organization_id` since a background risk-scoring
 * sweep processes one user's row per transaction, not one organization's.
 */
export function withWorkerUser<TResult>(
  userId: string,
  operation: (transaction: WorkerTransaction) => Promise<TResult>,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<TResult> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`
      select
        set_config('app.user_id', ${userId}, true),
        set_config('app.request_id', ${crypto.randomUUID()}, true)
    `)
    return operation(transaction as WorkerTransaction)
  })
}

export interface AccountRiskRecord {
  userId: string
  riskScore: number
  stage: string
  reason: string | null
  updatedAt: Date
}

export async function getAccountRisk(
  transaction: WorkerTransaction,
  userId: string,
): Promise<AccountRiskRecord | null> {
  const [row] = await transaction.select().from(accountRisk).where(eq(accountRisk.userId, userId)).limit(1)
  return row ?? null
}

export interface UpsertAccountRiskInput {
  userId: string
  riskScore: number
  stage: string
  reason?: string | null
}

export async function upsertAccountRisk(
  transaction: WorkerTransaction,
  input: UpsertAccountRiskInput,
): Promise<AccountRiskRecord> {
  const [row] = await transaction.insert(accountRisk).values({
    userId: input.userId,
    riskScore: input.riskScore,
    stage: input.stage,
    reason: input.reason ?? null,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: accountRisk.userId,
    set: {
      riskScore: input.riskScore,
      stage: input.stage,
      reason: input.reason ?? null,
      updatedAt: new Date(),
    },
  }).returning()
  return row
}
