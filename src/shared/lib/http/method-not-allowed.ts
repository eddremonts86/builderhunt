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
 * ## Seal a route with `ANY`
 *
 * An earlier version of this file claimed there was no framework hook for "reject every method I did not
 * declare", so every rejection had to be spelled out per method. That was wrong. `createStartHandler` resolves a
 * request as `handlers[requestMethod] ?? handlers['ANY']`, and `ANY` is a typed member of the public `RouteMethod`
 * union. One `ANY` therefore closes every method a route does not implement — including `OPTIONS`, `HEAD`, and
 * any method added to HTTP later:
 *
 *     handlers: {
 *       ANY: methodNotAllowed(['PATCH']),
 *       PATCH: async ({ request, params }) => { ... },
 *     }
 *
 * `ANY` is consulted only when no specific handler matches, and `HEAD` resolves through `GET` first, so sealing
 * never shadows a real handler.
 *
 * Sealing defers no product decision: 200-with-an-HTML-page is not a defensible answer for any method on any
 * route, so 405 is right by default everywhere, and implementing a method callers genuinely want stays just as
 * available afterwards. The seal only removes the option of answering one by accident.
 *
 * ## Why `allowed` is passed and not derived
 *
 * A wrapper — `handlers: sealMethods({ ... })` — would derive `Allow` from the object's own keys and could never
 * drift. It was built, and it does not work: the `{ request, params, context }` argument of each handler is
 * *contextually* typed from `createFileRoute`, and routing the literal through a generic function severs that.
 * The result was 375 `implicitly has an 'any' type` errors and, worse, the loss of per-route `params` typing —
 * `params.eventId` becomes `any`. Type safety on every handler body is worth more than deriving one header.
 *
 * So `allowed` is restated, and `scripts/check-api-route-methods.mjs` compares every list against the handlers
 * the file actually declares. Drift is caught in CI rather than prevented by construction — a weaker guarantee,
 * bought at no cost to the handlers themselves.
 */

/** The methods this codebase's API routes implement. `ANY` is the framework's catch-all, not an implementation. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Builds a handler that refuses with 405 and an accurate `Allow` header.
 *
 * Use it as the route's `ANY` to seal every unimplemented method at once. Use it on a *named* method when that
 * one absence has something specific to say — "read your claimed profiles at /api/me/builders" is more use than
 * a generic refusal, and a named handler takes precedence over `ANY`.
 *
 * `reason` is worth supplying when the absence is a design decision rather than an omission: "a saved run is
 * immutable" tells a caller not to look for another way in, where a bare "method not allowed" invites them to
 * keep trying.
 */
export function methodNotAllowed(allowed: readonly HttpMethod[], reason?: string) {
  const allow = [...allowed].join(', ')
  return () =>
    Response.json(
      { error: reason ?? `Method not allowed. This route accepts: ${allow}.`, code: 'method_not_allowed' },
      { status: 405, headers: { allow } },
    )
}

/** A refusal, plus the guard it should run first, for routes that want a consistent answer to strangers. */
export type MethodGuard = {
  guard: (request: Request) => unknown | Promise<unknown>
  onRefusal: (error: unknown) => Response | null | undefined
}

/**
 * A 405 that only a caller who got past the guard can see.
 *
 * It takes its guard as an argument rather than choosing one because this codebase has at least three
 * (`requireTenantPrincipal`, `requirePlatformAdminPrincipal`, a cron token) and several routes accept more than
 * one, so a helper that picked would be wrong somewhere. `guard` resolves for an authorized caller and throws
 * otherwise — the same expression the route's real handler already uses; `onRefusal` is the route's existing
 * error mapper.
 *
 * ## What this does and does not buy
 *
 * It was added on the belief that a bare 405 leaks route existence to an anonymous caller where a 401 would not.
 * On this codebase that is **not** true, and the claim should not be repeated: `platformAdminErrorResponse` maps
 * every refusal to 401 or 403, never 404, so `POST /api/admin/anything` already answers 401 for a route that
 * exists and 404 for one that does not. Existence is discoverable with or without this.
 *
 * What it does buy is a **consistent** refusal: on an admin-only route a stranger gets the same 401 for `GET` as
 * for `POST`, rather than a 405 that reads as "your credentials were fine, your verb was not". The cost is a
 * session lookup on a request that is going to be refused regardless. Worth it on `/api/admin/*`, where every method is
 * admin-only anyway; not worth reaching for on a route that serves anonymous callers by design.
 */
export function methodNotAllowedAfter(options: MethodGuard & { allowed: readonly HttpMethod[]; reason?: string }) {
  const reject = methodNotAllowed(options.allowed, options.reason)
  return async ({ request }: { request: Request }): Promise<Response> => {
    try {
      await options.guard(request)
    } catch (error) {
      // The guard's own answer, unchanged. A generic 403 here would lose the distinction between "not signed
      // in" and "signed in but not allowed", which is the difference between "log in" and "ask someone".
      return options.onRefusal(error) ?? Response.json({ error: 'forbidden' }, { status: 403 })
    }
    return reject()
  }
}
