/**
 * The named ceilings the remaining non-table reads declare.
 *
 * ## Why these exist at all
 *
 * Plans 07–11 gave every read a person *looks at* a keyset page. What is left are reads with no table
 * UI: a per-entity detail list, a per-user settings list, a worker sweep. `plans/phase-3/12` names
 * three honest outcomes for those — model-bounded, batch, worker batch — and the mistake it warns
 * about is a bare `.limit(3)`, "a guess dressed as a bound".
 *
 * So none of these is a page size and none is a guess. Each is a **policy ceiling** with a stated
 * consequence: a set that reaches it is not a list that needs paginating, it is an entity being used
 * as something it is not, and that is a product question rather than a query one. Naming them here
 * rather than inlining numbers is what makes that claim reviewable in one place instead of sixty.
 *
 * ## What a ceiling is not allowed to be used for
 *
 * A read whose caller must cover **every** row does not belong here. Those are batch loops
 * (`drainActiveCreditGrants`, `drainWorkerOrganizations`, `hardDeleteAccountSubject`), because a
 * ceiling on a deletion, an export or a sweep is silent data loss. If you are reaching for a constant
 * from this file to bound something that must be complete, the answer is a loop.
 */

/**
 * Rows a **per-entity detail list** may return: the versions of one document, the segments of one
 * interview, the exceptions of one calendar event, the allocations of one reservation.
 *
 * These are all "the children of this row", and the entity that has more than two hundred of them is
 * not a detail view any more. Every one of these lists renders in full on a page — none of them has
 * a "load more" — so a set past this point is already unreadable before it is unbounded.
 */
export const ENTITY_DETAIL_LIMIT = 200

/**
 * Rows a **per-user or per-organization settings list** may return: devices, consents, export
 * requests, saved searches, terms acceptances.
 *
 * Bounded by what a person does by hand. Each of these grows one row per deliberate action — signing
 * in on a new device, accepting a version of the terms, saving a search — and an account with more
 * than two hundred is either a shared account or automation, both of which are the abuse system's
 * problem rather than the pager's.
 */
export const USER_SCOPED_LIMIT = 200

/**
 * Rows an **operator console read** may return in one request.
 *
 * Higher than the two above because an operator is deliberately looking at a lot at once — the
 * platform user list, a job-run history, a schedule registry. Still bounded: a console that renders
 * five hundred rows is at the point where the answer is a filter, and every one of these surfaces has
 * one.
 */
export const OPERATOR_LIST_LIMIT = 500

/**
 * Rows a **window-scoped analytics read** may return.
 *
 * These already carry a time predicate — a trend over fourteen days, events since a timestamp — so the
 * window is the real bound and this is the backstop for a window that turns out to be denser than the
 * surface expected. A chart with more than this many points is not a chart.
 */
export const ANALYTICS_WINDOW_LIMIT = 1000

/**
 * Rows one iteration of a **sweep** takes.
 *
 * For a read whose caller drains it in a loop. Not interchangeable with the ceilings above: the number
 * changes how many round trips a complete pass costs, never whether the pass is complete.
 */
export const SWEEP_BATCH = 1000

/**
 * Drains `read` in `SWEEP_BATCH`-sized passes, resuming from the last row's own cursor value.
 *
 * For the reads whose caller needs **every** row: a sitemap that omits a page, a suppression filter
 * that misses a suppressed profile, a status email that skips a subscriber. A ceiling on any of those
 * is silent — nobody is waiting on the row that was dropped.
 */
export async function drainSweep<TRow>(
  read: (after: string | null, limit: number) => Promise<TRow[]>,
  cursorOf: (row: TRow) => string,
  limit: number = SWEEP_BATCH,
): Promise<TRow[]> {
  const all: TRow[] = []
  let after: string | null = null
  for (;;) {
    const batch = await read(after, limit)
    if (batch.length === 0) return all
    all.push(...batch)
    if (batch.length < limit) return all
    after = cursorOf(batch[batch.length - 1])
  }
}
