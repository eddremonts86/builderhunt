import { createMiddleware } from '@tanstack/react-start'
import { env } from '~/shared/lib/env'

/**
 * Sends requests for a retired hostname to the canonical one, path and query intact.
 *
 * `builderhunt.dev` became the canonical host on 2026-08-09. `builderhunt.eduardoinerarte.dk` still
 * resolves, still holds a certificate, and still serves the identical application — which is two
 * addresses for one product, and duplicate content to every crawler that finds both.
 *
 * ## Why here and not in the proxy
 *
 * Coolify regenerates the Traefik labels from the application's domain list on **every deploy**, so a
 * `redirectregex` middleware added by hand survives exactly until the next one. It would also be a
 * change to the production proxy with no test covering it. This is code: the suite exercises it, the
 * gate runs before it ships, and no redeploy can quietly undo it.
 *
 * ## Why an explicit list rather than "anything that is not APP_URL"
 *
 * Inferring the set of wrong hosts is the more elegant rule and the more dangerous one. The E2E
 * harness gives every spec file a server on its own ephemeral port and sets APP_URL to match, and a
 * single misconfigured APP_URL in production would put every request into a redirect loop. With an
 * explicit list a loop is impossible by construction, and `canonicalRedirect` drops a host equal to
 * the destination rather than honouring it.
 *
 * Unset, this does nothing at all — which is how it behaves on every developer machine and
 * throughout CI. Nothing outside production has a second hostname to leave.
 */

export interface CanonicalHostConfig {
  /** Hostnames to leave, comma separated. `env.CANONICAL_HOST_REDIRECT_FROM` in production. */
  from: string | undefined
  /** Where to send them — the app's own canonical origin. */
  to: string
}

/**
 * The whole decision, as a pure function, because this is the part that can be wrong.
 *
 * Unit tests run in happy-dom, where `env.ts` returns its browser stub — so a test that reached
 * through `env` would only ever exercise the unconfigured path and prove nothing. The env plumbing
 * below is one line; the rules about loops, case and query strings are what need covering.
 *
 * Returns the absolute destination, or null to let the request through.
 */
export function canonicalRedirect(requestUrl: string, config: CanonicalHostConfig): string | null {
  const configured = config.from?.trim()
  if (!configured) return null

  const to = new URL(config.to)
  const leaving = new Set(
    configured
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0 && host !== to.host.toLowerCase()),
  )
  if (leaving.size === 0) return null

  // `request.url` rather than the Host header: the framework has already normalised it, and a header
  // can arrive with a port or in mixed case.
  const incoming = new URL(requestUrl)
  if (!leaving.has(incoming.host.toLowerCase())) return null

  return new URL(incoming.pathname + incoming.search + incoming.hash, to).toString()
}

/**
 * 301, not 302: the move is permanent, and a permanent redirect is what transfers the old address's
 * search standing to the new one.
 */
export const canonicalHostMiddleware = createMiddleware({ type: 'request' }).server(({ request, next }) => {
  const destination = canonicalRedirect(request.url, {
    from: env.CANONICAL_HOST_REDIRECT_FROM,
    to: env.APP_URL,
  })
  if (!destination) return next()

  return new Response(null, {
    status: 301,
    headers: {
      location: destination,
      // Nothing here varies per user, but the response does vary by the host asked for, and a shared
      // cache that ignored that would serve this redirect for the canonical host too.
      vary: 'Host',
    },
  })
})
