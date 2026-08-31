import { createServerFn } from '@tanstack/react-start'

import { env } from '~/shared/lib/env'

/**
 * Whether self-managed profiles exist (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## One flag, read in one shape
 *
 * `isSelfManagedEnabled()` is for server code that already has an environment — API routes, workers,
 * repositories. `getSelfManagedEnabled` is the server function the *page* routes call, and it exists
 * for the reason `segmented-landing-flag.ts` documents: `beforeLoad` and a route loader run on the
 * server for a full page load **and in the browser for a link navigation**, where `env.ts` hands
 * back a stub. A route reading `env.SELF_MANAGED_PROFILES_ENABLED` directly would serve the page on
 * a refresh and 404 it on a click, from one deploy, with the flag on the whole time.
 *
 * ## Off is fail-closed, and additive-safe
 *
 * Every entry point answers 404 and every write is refused, while the rows stay untouched — so
 * switching it off is a rollback rather than a deletion, and switching it back on restores what was
 * there. What deliberately keeps working is data export and erasure: a person's right to see and
 * delete what is held about them is not a feature, and a rollback that took it with it would turn
 * an operational decision into a compliance one.
 */
export function isSelfManagedEnabled(): boolean {
  return env.SELF_MANAGED_PROFILES_ENABLED === 'true'
}

/** The 404 every self-managed API route answers when the feature is off. */
export function selfManagedDisabledResponse(): Response | null {
  if (isSelfManagedEnabled()) return null
  // 404 and not 503: with the feature off these routes do not exist, and a 503 would say "this is
  // ours and it is broken" about a surface the operator deliberately switched off.
  return Response.json({ error: 'not_found' }, { status: 404 })
}

export const getSelfManagedEnabled = createServerFn({ method: 'GET' }).handler(
  () => isSelfManagedEnabled(),
)
