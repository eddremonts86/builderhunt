import { eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { platformDb } from '../db/client'
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

/**
 * Mirrors `withWorkerUser` but runs under `builderhunt_platform` — the abuse console (Phase 5 task
 * 3) reads/overrides one account's risk row on behalf of an admin who has no ambient session for
 * that user. Same `account_risk_platform_select`/`account_risk_platform_update` RLS shape as
 * worker (0044): still scoped to a single `app.user_id` per transaction, not a bulk cross-user
 * read — a "list every flagged account" view is explicitly deferred per 0044's own comment.
 */
export function withPlatformUser<TResult>(
  userId: string,
  operation: (transaction: WorkerTransaction) => Promise<TResult>,
  db: PostgresJsDatabase | typeof platformDb = platformDb,
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

export interface SetAccountRiskStageByAdminDeps {
  withWorkerUser?: typeof withWorkerUser
  withPlatformUser?: typeof withPlatformUser
}

/**
 * Admin manual override for the abuse console. `builderhunt_platform` only has SELECT/UPDATE on
 * `account_risk` (no INSERT — see 0044 §5's grant split), so a row must already exist before the
 * platform role can touch it. Ensures a baseline row first via the worker role's INSERT grant using
 * `ON CONFLICT DO NOTHING`, which never resets an already-scored row, then applies the admin's
 * stage under the platform role. If the automated risk-scoring sweep (`recomputeAccountRisk`)
 * later re-runs for this user, it can overwrite this manual override — there is no persisted
 * "admin locked this stage" flag in the schema today; documented as a known limitation rather than
 * a blocker, matching the deferral precedent already set in 0044's own comments.
 */
export async function setAccountRiskStageByAdmin(
  userId: string,
  stage: string,
  reason: string,
  deps: SetAccountRiskStageByAdminDeps = {},
): Promise<AccountRiskRecord> {
  const runWithWorkerUser = deps.withWorkerUser ?? withWorkerUser
  const runWithPlatformUser = deps.withPlatformUser ?? withPlatformUser

  await runWithWorkerUser(userId, (transaction) =>
    transaction.insert(accountRisk).values({
      userId,
      riskScore: 0,
      stage: 'observe',
      reason: 'admin-baseline (row created for manual action)',
      updatedAt: new Date(),
    }).onConflictDoNothing(),
  )

  const [row] = await runWithPlatformUser(userId, (transaction) =>
    transaction.update(accountRisk)
      .set({ stage, reason, updatedAt: new Date() })
      .where(eq(accountRisk.userId, userId))
      .returning(),
  )
  return row
}
