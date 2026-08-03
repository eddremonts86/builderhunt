/**
 * Explicit 405s for methods a file route does not implement.
 *
 * ## The defect this exists to close
 *
 * On a TanStack Start file route, a method with no handler falls through to the route *component*. Every API
 * route in this app declares `component: () => null`, so an unimplemented method answers **200 with an empty
 * HTML document** — not 404, not 405. A client scripting the endpoint reads 200 and concludes it worked.
 *
 * It was hit twice independently before anyone looked for it: `PATCH /api/solutions/runs/:id`, where a
 * "saved runs are immutable" guarantee silently reported success, and `GET /api/me/builder/:id`, which
 * implements `PATCH` only. A measurement then found **83 of 202 route files declare no GET at all**, so a
 * `GET` to any of them answers with a page today.
 *
 * ## Why a helper rather than a global fallback
 *
 * There is no framework hook for "reject every method I did not declare" — the fallthrough target is the
 * component, and a component cannot set a status. So the rejection has to be declared per route, and the point
 * of this helper is that declaring it costs one line and cannot be got subtly wrong:
 *
 *     import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
 *
 *     handlers: {
 *       PATCH: async ({ request }) => { ... },
 *       GET: methodNotAllowed(['PATCH']),
 *     }
 *
 * `Allow` is required by RFC 9110 on a 405 and is the part hand-written rejections forget. It is also the only
 * machine-readable way for a caller to discover what the route *does* accept, which is what turns a refusal
 * into something actionable rather than a dead end.
 */

/** The methods this codebase's API routes can declare. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Builds a handler that refuses with 405 and an accurate `Allow` header.
 *
 * `allowed` is the list of methods the route *does* implement — passed in rather than derived, because a route
 * cannot introspect its own sibling handlers, and a hard-coded list that drifts from reality is caught by the
 * static check in `scripts/check-api-route-methods.mjs`.
 *
 * `reason` is optional and worth supplying when the absence is a design decision rather than an omission: "a
 * saved run is immutable" tells a caller not to look for another way in, where a bare "method not allowed"
 * invites them to keep trying.
 */
export function methodNotAllowed(allowed: readonly HttpMethod[], reason?: string) {
  const allow = [...allowed].join(', ')
  return () =>
    Response.json(
      { error: reason ?? `Method not allowed. This route accepts: ${allow}.`, code: 'method_not_allowed' },
      { status: 405, headers: { allow } },
    )
}
