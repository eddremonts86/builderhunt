import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env'

const authClient = postgres(env.DATABASE_AUTH_URL ?? env.DATABASE_URL, { prepare: false })

// This adapter is restricted to Better Auth and organization lifecycle tables.
// Product repositories must never import it.
export const authDb = drizzle(authClient)
