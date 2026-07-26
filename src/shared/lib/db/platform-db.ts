import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env'

/**
 * The platform-operator connection.
 *
 * Distinct from `workerDb` because the grants are deliberately different: a worker may UPDATE a
 * schedule's `next_run_at` after a run, but only the platform role may CREATE or retire a schedule
 * identity (see drizzle/0067_operational_schedule_grants.sql). Reaching for the worker connection to
 * do registry maintenance fails with `42501 permission denied`, which is the grant doing its job —
 * widening the worker's grant to make that work would erase the distinction.
 *
 * Falls back to DATABASE_URL when unset, matching `worker-db.ts`: the role-separation cutover is a
 * sign-off-gated step, and the fallback is what keeps local development working before it lands.
 */
const platformClient = postgres(env.DATABASE_PLATFORM_URL ?? env.DATABASE_URL, { prepare: false })

export const platformDb = drizzle(platformClient)
export type PlatformTransaction = Parameters<Parameters<typeof platformDb.transaction>[0]>[0]
