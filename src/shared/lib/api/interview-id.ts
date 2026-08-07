/**
 * `interviewId` path-parameter validation for `/api/interviews/$interviewId/*`.
 *
 * The id is a `calendar_events.id` (UUID). The handler passes it straight to
 * Postgres via `withTenantContext`; with a malformed id, Postgres raises
 * `22P02 invalid_text_representation`, the handler's catch-all returns 500,
 * and the route is un-debuggable for the operator. Validating up front and
 * returning the same 404 as a missing row makes the failure mode coherent
 * with the existing "no row → 404" branch and matches how the rest of the
 * app treats bad slugs (saas-review F2 + F7-b).
 *
 * The walker sends the literal `:interviewId` placeholder to every dynamic
 * route in the inventory; without this guard, every interview endpoint logs
 * a 500 on every walk.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * Returns a 404 `Response` if the id is not a UUID, otherwise `null`. Use as
 * the first line of a handler so a malformed id is indistinguishable from a
 * missing row.
 */
export function interviewIdGuard(interviewId: string): Response | null {
  if (!isUuid(interviewId)) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  return null
}
