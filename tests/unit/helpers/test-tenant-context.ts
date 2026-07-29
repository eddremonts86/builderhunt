// Test helper: run a block with the RLS GUC set for the given
// organization. The disposable test database does NOT use
// withTenantContext (which is the production path) because
// the tests need fine-grained control over which org a query
// hits. This helper sets the GUC on the db handle directly so
// RLS-evaluated inserts in repositories (activity emits, etc.)
// can land.
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'

export async function asOrganization<T>(
  db: PostgresJsDatabase,
  organizationId: string,
  fn: (tx: PostgresJsDatabase) => Promise<T>,
): Promise<T> {
  // set_config with true is "local to the transaction". For
  // a top-level db.execute, the setting lives for the rest of
  // the connection. We open an explicit tx so the GUC is
  // scoped to the operation.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`)
    return fn(tx as PostgresJsDatabase)
  }) as Promise<T>
}
