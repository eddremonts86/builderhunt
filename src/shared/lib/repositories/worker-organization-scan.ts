/**
 * The bound on "every organization", shared by the six worker repositories that scan them.
 *
 * ## Why the loop is here and the query is not
 *
 * Each worker module keeps its **own** `listWorkerOrganizationIds`/`withWorkerOrganization` pair on
 * purpose — the alternative is one module importing another's worker DB handle, and the tenant
 * boundary is the reason those handles are separate. So the *query* stays duplicated and only the
 * batch size and the drain loop live here. This module imports nothing.
 *
 * ## Why a batch and not a page
 *
 * A worker that processes the first fifty organizations and stops has silently skipped the rest:
 * alerts not evaluated, subscriptions not reconciled, deletions not finalised. Nobody notices,
 * because there is no user waiting on the fifty-first. That is exactly the failure
 * `plans/phase-3/12-bounded-reads-sweep/spec.md` calls out — "classifying a batch read as a page
 * read" — so the read is bounded and the caller drains it, rather than the read being bounded and
 * the caller trusting it.
 *
 * The cursor is the organization id ascending, which is data rather than a counter: a run that dies
 * halfway can resume from the last id it finished instead of starting over.
 */

/**
 * Organizations per scan batch.
 *
 * Sized for the shape of the work rather than for the table: every id in a batch is followed by a
 * separate per-organization transaction, so the batch is a read-ahead buffer and not a unit of work.
 * Five hundred ids is a few tens of kilobytes and one round trip.
 */
export const WORKER_ORGANIZATION_BATCH = 500

/**
 * Drive `read` until it stops returning organizations, handing each batch to `process`.
 *
 * `read` takes the cursor and the limit and returns that batch's rows; a batch shorter than the
 * limit ends the walk. `process` returning `false` ends it early — a worker with a per-run budget
 * uses that, and one that must cover everything simply never returns `false`.
 */
export async function drainWorkerOrganizations(
  read: (after: string | null, limit: number) => Promise<Array<{ id: string }>>,
  process: (ids: string[]) => Promise<boolean | void> | boolean | void,
  limit: number = WORKER_ORGANIZATION_BATCH,
): Promise<void> {
  let after: string | null = null
  for (;;) {
    const batch = await read(after, limit)
    if (batch.length === 0) return
    const keepGoing = await process(batch.map((row) => row.id))
    if (keepGoing === false) return
    if (batch.length < limit) return
    after = batch[batch.length - 1].id
  }
}

/**
 * Every organization id, collected.
 *
 * For the callers that genuinely want the whole list in hand — an export that must cover every
 * tenant, a metrics roll-up that reports across all of them. It is the same loop; naming it
 * separately is what lets a call site say "all of them" in one line instead of open-coding a
 * loop and getting the termination condition subtly wrong.
 */
export async function collectWorkerOrganizationIds(
  read: (after: string | null, limit: number) => Promise<Array<{ id: string }>>,
  limit: number = WORKER_ORGANIZATION_BATCH,
): Promise<string[]> {
  const ids: string[] = []
  await drainWorkerOrganizations(read, (batch) => { ids.push(...batch) }, limit)
  return ids
}
