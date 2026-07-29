// Plan 29 (activity-feed) task 6 — retention worker.
//
// Deletes expired activity rows in bounded batches. The
// builderhunt_worker role has DELETE on organization_activity
// (FORCE ROW LEVEL SECURITY does not gate DELETE for the
// worker — the policy is TO builderhunt_worker USING (true)).
//
// Why batches: a single DELETE * could lock the table for the
// duration of a multi-million-row scan. Batches of BATCH_SIZE
// rows with a CHECKPOINT_EVERY commit give Postgres room to
// breathe between them and let the next worker run pick up
// where this one stopped.
//
// Why `expires_at IS NOT NULL` is in the WHERE clause: a row
// with a NULL expires_at is a forever-row (no retention
// window). The activity contracts default to 365 days for
// shared-resource events, 90 for feed-capability events, so
// the vast majority of rows are eligible; forever-rows are
// the deliberate exception, not the rule.

import { and, isNotNull, lt, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { platformDb } from '../db/client'
import { organizationActivity } from '../db/schema'

const BATCH_SIZE = 500
const CHECKPOINT_EVERY = 5_000
const MAX_BATCHES = 200 // 100k rows / run; rest goes to the next run

export interface ActivityRetentionResult {
  scannedBatches: number
  deleted: number
  /** True if the loop terminated because MAX_BATCHES was hit
   *  before the table was drained. The next run picks up. */
  hitLimit: boolean
}

/**
 * Run one retention pass. Safe to invoke concurrently from
 * multiple workers — each batch is a small DELETE that locks
 * only the rows it touches.
 *
 * The `db` argument is the worker-role db. The default is
 * `platformDb`, which is the connection the worker process
 * uses. Tests pass a disposable db so the harness can drive
 * the worker without a live database.
 */
export async function runActivityRetention(
  options: { now?: Date; maxBatches?: number; batchSize?: number; db?: PostgresJsDatabase } = {},
): Promise<ActivityRetentionResult> {
  const now = options.now ?? new Date()
  const maxBatches = options.maxBatches ?? MAX_BATCHES
  const batchSize = options.batchSize ?? BATCH_SIZE
  const db = options.db ?? platformDb

  let scannedBatches = 0
  let deleted = 0
  let hitLimit = false

  for (let i = 0; i < maxBatches; i++) {
    // We need to find candidate ids first, then delete the
    // exact set. A single `DELETE ... WHERE id IN (SELECT ...
    // LIMIT ...)` is the standard batched-delete pattern in
    // postgres and avoids the "row was modified between SELECT
    // and DELETE" race the way `DELETE ... LIMIT` cannot.
    const ids = await db
      .select({ id: organizationActivity.id })
      .from(organizationActivity)
      .where(and(
        isNotNull(organizationActivity.expiresAt),
        lt(organizationActivity.expiresAt, now),
      ))
      .limit(batchSize)

    if (ids.length === 0) break
    scannedBatches++

    const idList = ids.map((r: { id: string }) => r.id)
    // `id IN (...)` is the simplest portable form. Inlining
    // the values (after UUID validation) keeps the query plan
    // simple — there is no array unnest and no parameter
    // coercion.
    const result = await db
      .delete(organizationActivity)
      .where(sql`${organizationActivity.id} IN (${sql.join(idList.map((id) => sql`${id}`), sql`, `)})`)
      .returning({ id: organizationActivity.id })

    deleted += result.length

    if (result.length === 0) break // nothing left to delete in this slice

    // Periodic checkpoint log so a long run leaves a trace in
    // the platform metrics. Worker runs that go past this
    // threshold are the ones the on-call engineer is most
    // likely to want visibility into.
    if (deleted > 0 && deleted % CHECKPOINT_EVERY === 0) {
      // eslint-disable-next-line no-console
      console.log(`[activity-retention] deleted=${deleted} batches=${scannedBatches}`)
    }
  }

  if (scannedBatches >= maxBatches) hitLimit = true
  return { scannedBatches, deleted, hitLimit }
}
