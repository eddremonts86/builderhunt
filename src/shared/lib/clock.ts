/**
 * The instant a request should treat as "now".
 *
 * ## Why this exists
 *
 * Almost nothing needs it. `new Date()` is right in every place whose output is a row, a timestamp
 * or an expiry, because the fixtures that assert on those seed their own timestamps from
 * `E2E_FIXED_TIME` (`tests/e2e/harness/clock.ts`) and the assertions read them back.
 *
 * The exception is a value that is *computed* from the clock at request time and then rendered —
 * `/admin/operations` derives `Next run` from `calculateNextRun(definition, now)` because the e2e
 * database has no `operational_schedules` row for the projection to prefer. `page.clock.setFixedTime`
 * pins the browser and cannot reach arithmetic that happened on the server, so the visual baseline
 * for that page recorded whichever day it was taken on and then disagreed with the page a little
 * more every day after. It read `13 Aug 2026` for the fifteen days before this module existed.
 *
 * That decay is the dangerous kind: one changed line on a 1280x2542 page sits far under the 0.01
 * diff ratio, so the gate keeps passing while describing a page that no longer exists, and the whole
 * accumulated difference surfaces at once the day something changes the page height. `admin-integrations`
 * had just been caught in exactly that.
 *
 * ## Why a seam rather than a mask
 *
 * Masking the cell was tried first and does not hold. The stacked (mobile) presentation lays the meta
 * cells out in a `flex-wrap` row, so the date's *width* positions its siblings: a mask hides the
 * glyphs and the cells after it still shift when `13:55` becomes `03:00`. Hiding a value that moves
 * only shrinks the diff; it does not stop it moving.
 *
 * ## Why this is safe in production
 *
 * Two conditions, not one. `E2E_MODE=true` is how this repository already reaches its test seams —
 * the email short-circuit, the claim-proof stubs, the embedding and enrichment stubs all read it —
 * and the harness sets `NODE_ENV=test` on its server even though `vite preview` would otherwise say
 * `production`. Requiring both means a production process cannot be talked into a false clock by one
 * stray environment variable, which is a stronger guarantee than the seams beside it make.
 *
 * An unparseable `E2E_FIXED_TIME` returns the real clock rather than throwing: this is read on a
 * request path, and a malformed test variable must not be why a page 500s.
 *
 * ## The asymmetry to know about
 *
 * Postgres `now()` is **not** pinned by this, so under the harness a row written by
 * `update operational_schedules set next_run_at = now() + interval '1 day'` sits five weeks after
 * what a handler calls now. Every current use points the safe way (a next run further in the future
 * is still not overdue), but a fixture that wants a *past* instant must derive it from the fixed
 * clock in JS, not from SQL — `interval '-1 day'` off `now()` is still in this clock's future.
 */
export function requestNow(): Date {
  if (typeof process === 'undefined') return new Date()
  if (process.env.E2E_MODE !== 'true' || process.env.NODE_ENV === 'production') return new Date()
  const fixed = process.env.E2E_FIXED_TIME
  if (!fixed) return new Date()
  const epochMs = Date.parse(fixed)
  return Number.isNaN(epochMs) ? new Date() : new Date(epochMs)
}
