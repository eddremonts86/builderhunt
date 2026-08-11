/**
 * A bookmarkable status filter for an admin list route (plan 57, Admin track).
 *
 * ## What this is for
 *
 * Several admin pages hold their status filter in `useState`: claims, access requests, the roadmap. Each one
 * has the same three problems, and they are the reason the Admin Metrics page put its section in the URL:
 *
 * - **A filtered view cannot be shared.** An operator narrows claims to `pending`, pastes the URL into an
 *   incident channel, and everyone else opens the unfiltered list. During an incident that is worse than
 *   useless — the reader believes they are looking at what was described.
 * - **A reload loses it.** The filter resets to the default, and on a page whose default is `all` that means
 *   silently widening what somebody was reading.
 * - **Back does nothing.** Two clicks to narrow, and the browser's own undo is not connected to either.
 *
 * ## Why normalizing rather than refusing
 *
 * Same split as the metrics page and for the same reason. An **API** refuses an unknown status, because a
 * defaulted one returns rows that do not match the request. A **URL** is something a human edits, shortens or
 * pastes from a stale bookmark, and an admin page that answers 400 during an incident is worse than the
 * unfiltered list. So an unrecognised value falls back — and the route rewrites the URL to what is actually on
 * screen, because rendering `all` while the address bar says `pending` is the shareable-lie version of the same
 * bug.
 */

/** What a validated admin list route hands its page. Always present, never `undefined`. */
export interface StatusFilterState<Status extends string> {
  status: Status | 'all'
}

/**
 * Builds a `validateSearch` for one route's status vocabulary.
 *
 * The allowlist is passed in rather than shared, because these are different vocabularies that happen to look
 * alike: a claim can be `revoked` and an access request cannot be `expired`. One merged list would accept a
 * status on a route that has no rows for it, and the page would render an empty list that reads as "none" rather
 * than as "not a thing here".
 */
export function statusFilterValidator<Status extends string>(
  allowed: readonly Status[],
  fallback: Status | 'all',
) {
  return (input: Record<string, unknown>): StatusFilterState<Status> => {
    if (input.status === 'all') return { status: 'all' }
    const found = allowed.find((candidate) => candidate === input.status)
    return { status: found ?? fallback }
  }
}

/**
 * Whether the URL literally said something other than what is being shown.
 *
 * Compares the *raw* value, so an absent parameter is not treated as a mismatch with the default — otherwise
 * every first visit would rewrite its own URL and put an entry in the history the operator has to press Back
 * through twice.
 */
export function statusNeedsRewrite<Status extends string>(
  raw: Record<string, unknown>,
  normalized: StatusFilterState<Status>,
): boolean {
  return raw.status !== undefined && raw.status !== normalized.status
}
