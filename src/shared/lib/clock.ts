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
 * `E2E_MODE=true` is how this repository already reaches every test seam it has — the email
 * short-circuit, the claim-proof stubs, the embedding and enrichment stubs all read exactly this and
 * nothing else. A process with `E2E_MODE=true` in production is already not serving anyone: its mail
 * goes to a buffer and its embeddings are stubs. One more thing that misbehaves under a variable that
 * already breaks the application is not a new exposure.
 *
 * **`NODE_ENV` must not be part of the condition, and this is not a preference.** The first version
 * of this function also required `process.env.NODE_ENV !== 'production'`, on the reasoning that the
 * harness pins `NODE_ENV=test` on its server and a production process therefore could not be talked
 * into a false clock by one stray variable. Vite *constant-folds* `process.env.NODE_ENV` into the
 * bundle, so that term does not read the process at all — it reads whichever value the build had.
 * A local `pnpm build` folded it to `false` and the seam worked; CI's build folded it to `true` and
 * the whole condition short-circuited, so the Linux baseline came back holding the real clock again
 * while the darwin one held the pinned one. A guard that is decided by how the artefact was built,
 * and reads as stricter than it is, is worse than no guard.
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
  if (process.env.E2E_MODE !== 'true') return new Date()
  const fixed = process.env.E2E_FIXED_TIME
  if (!fixed) return new Date()
  const epochMs = Date.parse(fixed)
  return Number.isNaN(epochMs) ? new Date() : new Date(epochMs)
}
