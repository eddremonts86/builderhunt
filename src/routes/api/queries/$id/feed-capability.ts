/**
 * Feed capability mint API (plan: shared-resources, task 9).
 *
 * POST mints a fresh `feed_capabilities` row for a saved query the caller's organization owns and
 * returns its id + the one-time raw token, so the dashboard can build a real
 * `/api/feeds/$capabilityId?format=rss&token=...` URL.
 *
 * Found missing during the 2026-07-31 phase-1 audit: the dashboard's "Copy RSS feed URL" button
 * built its link from a legacy HMAC-over-saved-query-id scheme (`~/shared/lib/security/feed-capability`),
 * which the real `/api/feeds/$searchId` route never accepts — every copied link 404'd. The function
 * that mints a real capability (`~/shared/lib/repositories/public-feeds`) existed and was fully
 * built, but no route ever called it. This is that route.
 */
import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { findSavedQueryById } from '~/shared/lib/repositories/saved-queries'
import { rateLimit } from '~/shared/lib/rate-limit'

export const Route = createFileRoute('/api/queries/$id/feed-capability')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const query = await withTenantContext(principal, (tx) =>
            findSavedQueryById(tx, principal.organizationId, params.id),
          )
          if (!query) return Response.json({ error: 'Saved search not found' }, { status: 404 })

          const limitResult = await rateLimit('feed-capability-mint', `${principal.organizationId}:${principal.userId}`, 20, 60 * 60)
          if (!limitResult.allowed) {
            return Response.json(
              { error: 'Too many feed links minted in the last hour. Try again later.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limitResult.resetMs / 1000)) } },
            )
          }

          const { createFeedCapability } = await import('~/shared/lib/repositories/public-feeds')
          const minted = await createFeedCapability(principal.organizationId, params.id, {
            mintedByUserId: principal.userId,
          })
          return Response.json({
            id: minted.id,
            token: minted.capability,
            url: `/api/feeds/${minted.id}?format=rss&token=${encodeURIComponent(minted.capability)}`,
          }, { status: 201 })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Feed capability mint error:', error)
          return Response.json({ error: 'Failed to create feed link' }, { status: 500 })
        }
      },
    },
  },
})
