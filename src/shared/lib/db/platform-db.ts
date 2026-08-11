/**
 * The platform-operator connection — one pool, re-exported.
 *
 * ## Why this file no longer constructs a client
 *
 * It used to call `postgres(env.DATABASE_PLATFORM_URL ?? env.DATABASE_URL, poolOptions())` while
 * `db/client.ts` *also* exported a lazy `platformDb` built from the same URL. Two import paths, two
 * pools, one role. Nothing failed: both worked, both were correct, and the process quietly held twice
 * the platform connections anybody counting from the code would expect — which is the kind of
 * discrepancy that only shows up as an unexplained number in `pg_stat_activity` during an incident.
 *
 * The eager construction was the second problem. `postgres()` at module scope means importing this
 * file is enough to open a connection, and the same import chain reaches the client bundle through
 * TanStack's route tree — the failure mode `db/client.ts` documents at length. The lazy proxy there
 * exists precisely to make that safe, so the fix is to use it rather than to keep a second, eager
 * copy alongside it.
 *
 * ## Why the file stays
 *
 * The grants are the reason `platformDb` is distinct from `workerDb` in the first place, and that
 * reasoning has to live somewhere a reader looking for the platform connection will find it. Deleting
 * the file would move ~30 imports and lose the explanation; re-exporting keeps both, and
 * `tests/unit/shared/lib/db/pool-singletons.test.ts` asserts the two import paths are the same object
 * so the duplication cannot come back unnoticed.
 *
 * The distinction itself: a worker may UPDATE a schedule's `next_run_at` after a run, but only the
 * platform role may CREATE or retire a schedule identity (see
 * `drizzle/0067_operational_schedule_grants.sql`). Reaching for the worker connection to do registry
 * maintenance fails with `42501 permission denied`, which is the grant doing its job — widening the
 * worker's grant to make that work would erase the distinction.
 *
 * The URL still falls back to `DATABASE_URL` when unset, matching `worker-db.ts`: the role-separation
 * cutover is a sign-off-gated step, and the fallback is what keeps local development working before
 * it lands.
 */

export { platformDb } from './client'

import type { platformDb as PlatformDb } from './client'

export type PlatformTransaction = Parameters<Parameters<typeof PlatformDb.transaction>[0]>[0]
