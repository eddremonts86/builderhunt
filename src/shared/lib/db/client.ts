import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '~/shared/lib/env'

const runtimeClient = postgres(env.DATABASE_URL, { prepare: false })

export const runtimeDb = drizzle(runtimeClient)

// Public repositories are the only non-tenant product code allowed to use this
// surface. Private repositories must receive a TenantTransaction instead.
export const publicDb = runtimeDb

export type TenantTransaction = Parameters<Parameters<typeof runtimeDb.transaction>[0]>[0]
