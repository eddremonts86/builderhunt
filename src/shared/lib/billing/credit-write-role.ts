import { sql } from 'drizzle-orm'

/**
 * The only place allowed to elevate a request transaction to the credit-writing role.
 *
 * Reserving credits is user-initiated — an organizer presses "go live" — so it runs inside the acting
 * user's `builderhunt_app` transaction. `drizzle/0028` grants that role SELECT only on the four credit
 * tables, on purpose: a role that answers requests from the internet must not be able to mint
 * balance. So the write needs `builderhunt_worker`, and it needs it *in the same transaction*, because
 * the reservation and whatever the caller does next (a session state transition, for interviews) must
 * commit or roll back together. Split across two connections, a failed transition leaves an orphaned
 * reservation consuming the customer's balance.
 *
 * `drizzle/0098` therefore makes the app role a *member* of the worker role rather than granting it
 * table privileges. Membership is inert until claimed: the app role still cannot write by default, and
 * claiming it is this one greppable call instead of an invisible privilege that every future query
 * inherits.
 *
 * Two properties make the elevation safe to hold for the length of a callback:
 *
 *   - **Scope is unchanged.** 0028's worker policies on these tables all filter on
 *     `current_setting('app.organization_id')`, which the tenant context has already set. The
 *     elevation supplies the verb; RLS keeps the boundary. An elevated write still cannot reach
 *     another organization's rows.
 *   - **It cannot leak.** `SET LOCAL` is transaction-scoped: PostgreSQL reverts it on COMMIT or
 *     ROLLBACK whether or not the `RESET` below runs. The explicit reset narrows it further, to the
 *     callback rather than the rest of the transaction — which matters because the elevated role is
 *     not a superset: `builderhunt_worker` lacks privileges the app role has, so leaving it active
 *     would break the caller's next unrelated write.
 *
 * Do not widen this. If a new feature needs a credit write, it calls this; if something needs a
 * *different* role, that is a new deliberate grant with its own migration and reasoning.
 */
export async function withCreditWriteRole<T>(
  transaction: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  work: () => Promise<T>,
): Promise<T> {
  await transaction.execute(sql`set local role builderhunt_worker`)
  try {
    return await work()
  } finally {
    /*
     * Restores the app role for the rest of the transaction — best-effort, and deliberately so.
     *
     * If `work()` threw, PostgreSQL has already aborted the transaction, and every subsequent
     * statement in it fails. An unguarded `reset role` here therefore threw a second error that
     * *replaced* the first, turning "insufficient credits" and "provider outage" into
     * `Failed query: reset role`. The original failure is the one the caller needs.
     *
     * Swallowing it is safe because the reset is hygiene, not the security boundary: `SET LOCAL` is
     * transaction-scoped, so COMMIT or ROLLBACK reverts the elevation regardless. The reset only
     * narrows it further, to this callback rather than the remainder of a still-healthy transaction.
     */
    try {
      await transaction.execute(sql`reset role`)
    } catch {
      // Aborted transaction: the elevation dies with the rollback that is already coming.
    }
  }
}
