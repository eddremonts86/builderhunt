import { createServerFn } from '@tanstack/react-start'
import { env } from '~/shared/lib/env'

/**
 * Whether the three segment pages exist (plan: phase-2/06-landing-segmentada).
 *
 * ## Why a server function and not `env` in the route
 *
 * `beforeLoad` runs on the server for a full page load **and in the browser for a link navigation**,
 * and `env.ts` hands the browser a stub — every flag it does not explicitly place there reads as its
 * zod default. A route that read `env.SEGMENTED_LANDING_ENABLED` directly would therefore serve the
 * page on a refresh and 404 it on a click, from one deploy, with the flag on the whole time. That is
 * the failure `getIsAppAdmin` documents in `auth-session.ts`, and this is the same shape of problem.
 *
 * Called only by the four routes that need it — the home page, for the selector, and the three
 * segment pages, for their own existence. Deliberately not resolved in `_landing/route.tsx`, which
 * every public page passes through: a boolean two pages care about is not worth a round trip on
 * every navigation through the landing.
 */
export const getSegmentedLandingEnabled = createServerFn({ method: 'GET' }).handler(
  () => env.SEGMENTED_LANDING_ENABLED === 'true',
)
