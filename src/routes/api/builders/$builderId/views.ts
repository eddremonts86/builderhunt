// Profile-view analytics: write a presence record, read counts.
//
// The write path (POST) gates on two non-negotiables: the caller is
// authenticated (so the rows viewer_id is set) and the caller has
// accepted the privacy consent. Anonymous requests are a 401, not a
// silent drop — a partial write would be worse than a clear error.
//
// The read path (GET) gates on a third thing: the caller is the verified
// owner of the claimed profile. Counts only; viewer identities never
// leave the server, by design — a viewer who wants their own data uses
// the account export, not this endpoint.

import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { getConsentStatus } from '~/shared/lib/legal'
import { isVerifiedBuilderClaimant } from '~/shared/lib/repositories/builder-claims'
import {
  findBuilderProfileViewForDay,
  listBuilderProfileViewCounts,
  recordBuilderProfileView,
} from '~/shared/lib/repositories/builder-profile-views'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_WINDOW_DAYS = 30

export const Route = createFileRoute('/api/builders/$builderId/views')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      POST: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'authentication_required' }, { status: 401 })
          }
          const viewerId = session.user.id

          // Consent gate: a viewer who has not accepted the privacy
          // document gets a 451 with `error: 'consent_required'`. The
          // plan explicitly distinguishes this from a 401 because
          // unauthenticated and unconsented are different problems:
          // the former can be fixed by signing in, the latter by
          // accepting the consent.
          const consent = await getConsentStatus(viewerId)
          if (consent.needsAcceptance.includes('privacy')) {
            return Response.json(
              { error: 'consent_required', document: 'privacy' },
              { status: 451 },
            )
          }

          const now = new Date()
          const dayStart = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS)
          const dayEnd = new Date(dayStart.getTime() + DAY_MS)

          const principal = await requireTenantPrincipal(request)
          await withTenantContext(principal, async (tx) => {
            const already = await findBuilderProfileViewForDay(
              tx,
              params.builderId,
              viewerId,
              dayStart,
              dayEnd,
            )
            if (already) return
            await recordBuilderProfileView(tx, params.builderId, viewerId, now)
          })
          return Response.json({ ok: true })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('profile view write error:', error)
          return Response.json({ error: 'Failed to record view' }, { status: 500 })
        }
      },

      GET: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'authentication_required' }, { status: 401 })
          }
          const subjectUserId = session.user.id

          // Owner gate: only the verified claimant of this profile
          // sees the numbers. An admin does not get a back door here
          // (they have a separate metrics surface under /api/admin).
          const principal = await requireTenantPrincipal(request)
          const owner = await withTenantContext(principal, (tx) =>
            isVerifiedBuilderClaimant(tx, subjectUserId, params.builderId),
          )
          if (!owner) {
            return Response.json({ error: 'forbidden' }, { status: 403 })
          }

          const to = new Date()
          const from = new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS)
          const counts = await withTenantContext(principal, (tx) =>
            listBuilderProfileViewCounts(tx, params.builderId, from, to),
          )
          // `total` is the only summary stat; per-day is for a future chart.
          const total = counts.reduce((sum, row) => sum + row.count, 0)
          return Response.json({
            builderId: params.builderId,
            windowDays: DEFAULT_WINDOW_DAYS,
            total,
            daily: counts,
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('profile view read error:', error)
          return Response.json({ error: 'Failed to read view counts' }, { status: 500 })
        }
      },
    },
  },
})
