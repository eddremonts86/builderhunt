import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env'

/**
 * The connection used by the public capability flow (drizzle/0078).
 *
 * Distinct from `workerDb` because the grants are deliberately different: this identity can create an
 * interview event and write a candidate's own submission and consent, which no background job may do;
 * and it cannot DELETE anything, read `organizations` or `auth_users`, or touch billing, which the
 * worker can.
 *
 * Falls back to the worker URL when `DATABASE_CAPABILITY_URL` is unset. That is not a silent
 * downgrade to worker privileges — it is a deliberate fail-closed: the worker role has no INSERT on
 * `candidate_submissions` or `calendar_events`, so the public flow returns a permission error instead
 * of quietly working with wider access than it should have. An operator who sees that error has one
 * fix, which is to provision the credential.
 */
const capabilityClient = postgres(
  env.DATABASE_CAPABILITY_URL ?? env.DATABASE_WORKER_URL ?? env.DATABASE_URL,
  { prepare: false },
)

export const capabilityDb = drizzle(capabilityClient)
export type CapabilityTransaction = Parameters<Parameters<typeof capabilityDb.transaction>[0]>[0]
