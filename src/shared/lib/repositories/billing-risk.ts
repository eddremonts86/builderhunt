import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { and, desc, eq, isNull, gt, sql } from 'drizzle-orm'
import { platformDb, type TenantTransaction } from '../db/client'
import { billingRiskEvents, billingRiskExceptions } from '../db/schema'

/**
 * Data access for fraud/high-volume exception controls (plans/phase-1/30-stripe-billing-platform/tasks.md §8
 * "Add fraud and high-volume exception controls"). `billing_risk_events`/`billing_risk_exceptions`
 * are tenant-private (RLS-scoped by `organization_id`), so the tenant/worker-context functions below
 * take an already-scoped `TenantTransaction` like every other repository in this codebase.
 *
 * A platform operator issuing/reviewing an exception is different: the request targets an
 * ARBITRARY organization the operator does not have an ambient tenant context for (unlike an
 * owner acting on their own org, or the worker's per-org sweep loop). `withPlatformOrganization`
 * mirrors `repositories/billing-worker.ts`'s `withWorkerOrganization` exactly, just against
 * `platformDb` (the `builderhunt_platform` role) instead of `workerDb`.
 */

export interface BillingRiskEventRecord {
  id: string
  organizationId: string
  eventType: string
  detail: string | null
  createdAt: Date
}

export interface RecordRiskEventInput {
  organizationId: string
  eventType: 'payment_failure' | 'card_rotation' | 'dispute_opened'
  detail?: string
}

export async function recordRiskEvent(
  transaction: TenantTransaction,
  input: RecordRiskEventInput,
): Promise<BillingRiskEventRecord> {
  const [row] = await transaction
    .insert(billingRiskEvents)
    .values({ id: randomUUID(), organizationId: input.organizationId, eventType: input.eventType, detail: input.detail })
    .returning()
  return row
}

export async function listRecentRiskEvents(
  transaction: TenantTransaction,
  organizationId: string,
  eventType: string,
  since: Date,
): Promise<BillingRiskEventRecord[]> {
  const rows = await transaction
    .select()
    .from(billingRiskEvents)
    .where(and(eq(billingRiskEvents.organizationId, organizationId), eq(billingRiskEvents.eventType, eventType)))
  return rows.filter((row) => row.createdAt.getTime() >= since.getTime())
}

export interface BillingRiskExceptionRecord {
  id: string
  organizationId: string
  reason: string
  issuedByUserId: string
  issuedAt: Date
  expiresAt: Date
  revokedAt: Date | null
}

/** The single currently-active (not revoked, not yet expired) exception for an organization, if any — spec.md: "a reviewed time-bounded high-volume exception." */
export async function findActiveRiskException(
  transaction: TenantTransaction,
  organizationId: string,
  now: Date,
): Promise<BillingRiskExceptionRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingRiskExceptions)
    .where(and(
      eq(billingRiskExceptions.organizationId, organizationId),
      isNull(billingRiskExceptions.revokedAt),
      gt(billingRiskExceptions.expiresAt, now),
    ))
    .orderBy(desc(billingRiskExceptions.issuedAt))
    .limit(1)
  return row ?? null
}

export async function listRiskExceptions(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingRiskExceptionRecord[]> {
  return transaction
    .select()
    .from(billingRiskExceptions)
    .where(eq(billingRiskExceptions.organizationId, organizationId))
    .orderBy(desc(billingRiskExceptions.issuedAt))
}

/**
 * Mirrors `repositories/billing-worker.ts`'s `withWorkerOrganization` — scopes a transaction to one
 * organization's RLS context so a platform operator can act on an org they have no ambient tenant
 * session for. `db` defaults to the real `platformDb` singleton; tests inject a disposable database,
 * the same DI pattern `seller-profile.ts`'s `sellerProfileDb` and `worker.ts`'s `db` option use.
 */
export function withPlatformOrganization<TResult>(
  organizationId: string,
  operation: (transaction: TenantTransaction) => Promise<TResult>,
  db: PostgresJsDatabase | typeof platformDb = platformDb,
): Promise<TResult> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`
      select
        set_config('app.organization_id', ${organizationId}, true),
        set_config('app.organization_role', 'platform_admin', true),
        set_config('app.request_id', ${randomUUID()}, true)
    `)
    return operation(transaction)
  })
}

export interface IssueRiskExceptionInput {
  organizationId: string
  reason: string
  issuedByUserId: string
  expiresAt: Date
}

export function issueRiskExceptionForOrganization(
  input: IssueRiskExceptionInput,
  db?: PostgresJsDatabase | typeof platformDb,
): Promise<BillingRiskExceptionRecord> {
  return withPlatformOrganization(input.organizationId, (tx) =>
    tx.insert(billingRiskExceptions).values({
      id: randomUUID(),
      organizationId: input.organizationId,
      reason: input.reason,
      issuedByUserId: input.issuedByUserId,
      expiresAt: input.expiresAt,
    }).returning().then(([row]) => row), db)
}

export function listRiskExceptionsForOrganization(
  organizationId: string,
  db?: PostgresJsDatabase | typeof platformDb,
): Promise<BillingRiskExceptionRecord[]> {
  return withPlatformOrganization(organizationId, (tx) => listRiskExceptions(tx, organizationId), db)
}

export function revokeRiskExceptionForOrganization(
  organizationId: string,
  exceptionId: string,
  now: Date,
  db?: PostgresJsDatabase | typeof platformDb,
): Promise<BillingRiskExceptionRecord | null> {
  return withPlatformOrganization(organizationId, async (tx) => {
    const [row] = await tx
      .update(billingRiskExceptions)
      .set({ revokedAt: now })
      .where(and(eq(billingRiskExceptions.organizationId, organizationId), eq(billingRiskExceptions.id, exceptionId), isNull(billingRiskExceptions.revokedAt)))
      .returning()
    return row ?? null
  }, db)
}
