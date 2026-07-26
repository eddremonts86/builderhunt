/**
 * The canonical public origin of the site — the single source of truth for
 * canonical tags, OG URLs, JSON-LD ids, and sitemap/robots/atom entries: every
 * absolute URL that must be identical no matter which hostname served the
 * request.
 *
 * Resolved from the environment, never hardcoded: `APP_URL` on the server,
 * `VITE_APP_URL` (statically replaced at build time) in the browser. Both are
 * required by `env.ts` and set to the same value in every environment, so SSR
 * and hydration always agree on the canonical URL.
 *
 * Deliberately **not** `window.location.origin`: an interim hostname, a preview
 * host, or a bare-IP visit must never be able to rewrite the canonical URL —
 * that is how a page ends up canonicalized to a host nobody controls.
 *
 * Domain-cutover contract: moving to a new domain is `APP_URL` +
 * `VITE_APP_URL` + `BETTER_AUTH_URL` and one redeploy. No source edit, because
 * this constant used to be copy-pasted into eight route files and they drifted
 * from reality the moment the production hostname changed. See
 * `docs/operations/external-services-register.md` §1.
 */
import { ensureProtocol } from '~/shared/lib/env'

function readViteEnv(key: string): string | undefined {
  // import.meta.env is statically replaced at build time; guarded for the
  // (non-Vite) vitest/node execution contexts that import this module.
  try {
    return (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[key]
  } catch {
    return undefined
  }
}

function readProcessEnv(key: string): string | undefined {
  // `process` is not shimmed in the client bundle (no vite `define`), so this
  // is undefined in the browser and the VITE_ mirror below takes over.
  try {
    return typeof process !== 'undefined' ? process.env?.[key] : undefined
  } catch {
    return undefined
  }
}

export function resolveSiteUrl(): string {
  const raw = readProcessEnv('APP_URL') ?? readViteEnv('VITE_APP_URL') ?? 'http://localhost:3000'
  return ensureProtocol(raw).replace(/\/+$/, '')
}

/** Canonical public origin, protocol included, no trailing slash. */
export const SITE_URL = resolveSiteUrl()
