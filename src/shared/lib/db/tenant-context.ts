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
