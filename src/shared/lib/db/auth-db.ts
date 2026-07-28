import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env'
import { poolOptions } from './pool-options'

const authClient = postgres(env.DATABASE_AUTH_URL ?? env.DATABASE_URL, poolOptions())

// This adapter is restricted to Better Auth and organization lifecycle tables.
// Product repositories must never import it.
export const authDb = drizzle(authClient)
