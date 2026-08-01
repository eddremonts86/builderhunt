/**
 * People-search source register — list, review, and the per-source kill switch.
 *
 * The sibling of `/api/admin/solutions/sources`, for the connectors that search for *people* rather
 * than tools. Same shape and same two-action split deliberately: one operator page drives both
 * registers, and an operator should not have to learn two idioms because the data on the other side of
 * the switch happens to be a different kind of thing.
 *
 * Platform-admin only. Enabling a source decides that this product will contact a third party and
 * process personal data about people who are not its users — not a tenant-scoped choice.
 *
 * Three states the toggle can refuse, each with its own reason so the UI never has to guess:
 *
 * - `no_connector` — nothing implements this source, so there is nothing to switch on. The four
 *   hard-blocked platforms sit here permanently.
 * - `review_required` — a `public_scrape` source with no recorded terms review. The database refuses
 *   this too (`search_sources_scrape_needs_review_check`); returning it here is what turns a constraint
 *   violation into an answer an operator can act on.
 * - `not_found` — no register row.
 */
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { platformDb, publicDb } from '~/shared/lib/db/client'
import {
  listSearchSources,
  recordSearchSourceTermsReview,
  setSearchSourceEnabled,
} from '~/shared/lib/repositories/search-sources'

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), key: z.string().min(1) }).strict(),
  z.object({ action: z.literal('disable'), key: z.string().min(1) }).strict(),
  z.object({
    action: z.literal('record-review'),
    key: z.string().min(1),
    /** What was reviewed and what it permits. Bounded so an accidental paste of a whole terms-of-service
     * page does not land in the register. */
    notes: z.string().min(1).max(2000),
  }).strict(),
])

export const Route = createFileRoute('/api/admin/search-sources')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const sources = await listSearchSources(publicDb)

          await auditPlatformAdminAction(principal, {
            action: 'admin.search.sources.list',
            targetType: 'search-source',
            targetId: null,
            result: 'allowed',
            details: { count: sources.length, enabled: sources.filter((s) => s.enabled).length },
          })

          return Response.json({
            sources,
            // Both reasons a toggle is unavailable, surfaced separately. The UI explains which one
            // applies instead of rendering a dead control with no explanation.
            blockedOnReview: sources
              .filter((s) => s.kind === 'public_scrape' && !s.enabled && s.termsReviewedAt === null)
              .map((s) => s.key),
            blockedOnConnector: sources.filter((s) => !s.connectorImplemented).map((s) => s.key),
          })
        } catch (error) {
          const response = platformAdminErrorResponse(error)
          if (response) return response
          console.error('admin search sources list error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },

      POST: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const parsed = ActionSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 })
          }
          const body = parsed.data

          if (body.action === 'record-review') {
            const recorded = await recordSearchSourceTermsReview({
              key: body.key,
              reviewerUserId: principal.userId,
              notes: body.notes,
            }, platformDb)

            await auditPlatformAdminAction(principal, {
              action: 'admin.search.sources.record-review',
              targetType: 'search-source',
              targetId: body.key,
              result: recorded ? 'allowed' : 'failed',
              details: { recorded },
            })

            if (!recorded) return Response.json({ error: 'not_found' }, { status: 404 })
            return Response.json({ key: body.key, termsReviewed: true })
          }

          // `platformDb`: migration 0126 gives neither the app nor the worker role UPDATE on
          // search_sources, so the only writer is a reviewed operator action.
          const outcome = await setSearchSourceEnabled(
            { key: body.key, enabled: body.action === 'enable' },
            platformDb,
          )

          await auditPlatformAdminAction(principal, {
            action: `admin.search.sources.${body.action}`,
            targetType: 'search-source',
            targetId: body.key,
            result: outcome.status === 'updated' || outcome.status === 'unchanged' ? 'allowed' : 'failed',
            details: { outcome: outcome.status },
          })

          switch (outcome.status) {
            case 'not_found':
              return Response.json({ error: 'not_found' }, { status: 404 })
            case 'no_connector':
              // 409 rather than 422: the request is well-formed and the operator is authorised. The
              // obstacle is that no code queries this source, which is not something they can fix by
              // rephrasing the request.
              return Response.json({
                error: 'no_connector',
                detail: 'No connector implements this source, so there is nothing to enable. See its register notes.',
              }, { status: 409 })
            case 'review_required':
              return Response.json({
                error: 'review_required',
                detail: 'This is a public-scrape source. Record a terms/robots/privacy review before enabling it.',
              }, { status: 409 })
            case 'unchanged':
              return Response.json({ key: body.key, enabled: outcome.enabled, changed: false })
            case 'updated':
              return Response.json({ key: body.key, enabled: outcome.enabled, changed: true })
          }
        } catch (error) {
          const response = platformAdminErrorResponse(error)
          if (response) return response
          console.error('admin search sources action error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
