import { AsyncLocalStorage } from 'node:async_hooks'
import { sql, type SQL } from 'drizzle-orm'
import type { TenantPrincipal } from '../authorization/permissions'
import { runtimeDb, type TenantTransaction } from './client'

interface TenantTransactionLike {
  execute(query: SQL): Promise<unknown>
}

interface TransactionDatabase<TTransaction extends TenantTransactionLike> {
  transaction(operation: (transaction: TTransaction) => Promise<unknown>): Promise<unknown>
}

interface TenantContextState<TTransaction> {
  principal: TenantPrincipal
  transaction: TTransaction
}

export function createTenantContextRunner<TTransaction extends TenantTransactionLike>(
  database: TransactionDatabase<TTransaction>,
) {
  const storage = new AsyncLocalStorage<TenantContextState<TTransaction>>()

  return {
    async withTenantContext<TResult>(
      principal: TenantPrincipal,
      operation: (transaction: TTransaction) => Promise<TResult>,
    ): Promise<TResult> {
      const active = storage.getStore()
      if (active) {
        if (active.principal.organizationId !== principal.organizationId) {
          throw new Error('Cannot change organization inside an active tenant context')
        }
        if (active.principal.userId !== principal.userId) {
          throw new Error('Cannot change user inside an active tenant context')
        }
        return operation(active.transaction)
      }

      return database.transaction(async (transaction) => {
        await transaction.execute(sql`
          select
            set_config('app.user_id', ${principal.userId}, true),
            set_config('app.organization_id', ${principal.organizationId}, true),
            set_config('app.organization_role', ${principal.role}, true),
            set_config('app.request_id', ${principal.requestId}, true)
        `)
        return storage.run({ principal, transaction }, () => operation(transaction))
      }) as Promise<TResult>
    },
  }
}

const tenantContextRunner = createTenantContextRunner(runtimeDb)

export function withTenantContext<TResult>(
  principal: TenantPrincipal,
  operation: (transaction: TenantTransaction) => Promise<TResult>,
): Promise<TResult> {
  return tenantContextRunner.withTenantContext(principal, operation)
}

/**
 * A transaction that identifies a *person*, with no organization.
 *
 * ## What it is for
 *
 * Some tables are keyed to a subject rather than a tenant — `builder_claims` is a claim by a human
 * about their own identity, `builder_profile_views` records who looked at that identity — and their
 * RLS policies key on `app.user_id` alone. Account-subject reads (the data export, right-of-access)
 * legitimately have no organization, and running them through `withTenantContext` would mean
 * inventing one.
 *
 * ## Why it deliberately sets less than the tenant context
 *
 * It sets `app.user_id` and nothing else. That is not an omission to be tidied up later: every
 * tenant-scoped policy in this database keys on `app.organization_id`, so a context that also set an
 * organization would turn "read my own claims" into a way to read a workspace's rows without ever
 * passing a membership check. The narrowness is the safety property.
 *
 * ## The bug it exists to fix
 *
 * `loadAccountExportSource` read `builder_claims` through the bare app-role connection, with no
 * `app.user_id` set. `nullif(current_setting('app.user_id', true), '')` is then NULL, so
 * `subject_user_id = NULL` is NULL and the row is filtered — silently. A second, additive policy
 * (`builder_claims_public_portfolio_select`, `USING (status = 'verified')`) meant verified claims came
 * through anyway, which is exactly why nobody noticed: the export looked populated. What it dropped
 * were the pending, rejected, revoked and expired ones — so a person whose claim was refused received
 * an export saying they had never filed one, from the endpoint whose whole purpose is telling them
 * what is held about them.
 */
export function withAccountSubjectContext<TResult>(
  userId: string,
  operation: (transaction: TenantTransaction) => Promise<TResult>,
): Promise<TResult> {
  return runtimeDb.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.user_id', ${userId}, true)`)
    return operation(transaction)
  }) as Promise<TResult>
}
