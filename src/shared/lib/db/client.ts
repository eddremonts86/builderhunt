import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '~/shared/lib/env'

const runtimeClient = postgres(env.DATABASE_URL, { prepare: false })
const platformClient = postgres(env.DATABASE_PLATFORM_URL ?? env.DATABASE_URL, { prepare: false })

export const runtimeDb = drizzle(runtimeClient)

// Public repositories are the only non-tenant product code allowed to use this
// surface. Private repositories must receive a TenantTransaction instead.
export const publicDb = runtimeDb
export const platformDb = drizzle(platformClient)
export const accountDb = runtimeDb

export type TenantTransaction = Parameters<Parameters<typeof runtimeDb.transaction>[0]>[0]
