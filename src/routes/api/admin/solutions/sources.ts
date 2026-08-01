/**
 * Solutions source register — list, review, and the per-source kill switch
 * (plan 43 — solutions-intelligence Phase 4).
 *
 * This is the operator surface the maintainer asked for: see every ingestion source and turn each one
 * on or off individually. Platform-admin only, because enabling a source decides that this product
 * will go and fetch data about people and services from somewhere — not a tenant-scoped choice, and
 * not one an ordinary session may make.
 *
 * Two separate actions on purpose:
 *
 * - `enable` / `disable` flips the switch.
 * - `record-review` records that a human reviewed a source's terms, robots policy and privacy
 *   posture. For a `public_scrape` source that review is a **precondition** of enabling — the database
 *   refuses otherwise (`solution_sources_scrape_needs_review_check`).
 *
 * Collapsing those two into one call would let a single click both approve and enable a crawl, which
 * is exactly the shortcut the moved legal gate in `plans/phase-5/01-production-readiness-audit`
 * exists to prevent.
 */
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { platformDb, publicDb } from '~/shared/lib/db/client'
import { listSolutionSources, recordSourceTermsReview, setSolutionSourceEnabled } from '~/shared/lib/repositories/solution-catalog'

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), key: z.string().min(1) }).strict(),
  z.object({ action: z.literal('disable'), key: z.string().min(1) }).strict(),
  z.object({
    action: z.literal('record-review'),
    key: z.string().min(1),
    /** Free-text register note: what was reviewed and what it permits. Bounded so an accidental paste
     * of a whole terms-of-service page does not land in the register. */
    notes: z.string().min(1).max(2000),
  }).strict(),
])

export const Route = createFileRoute('/api/admin/solutions/sources')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          // Read through the app connection: the register is not secret, and reading it needs no
          // elevated role.
          const sources = await listSolutionSources(publicDb)

          await auditPlatformAdminAction(principal, {
            action: 'admin.solutions.sources.list',
            targetType: 'solution-source',
            targetId: null,
            result: 'allowed',
            details: { count: sources.length, enabled: sources.filter((s) => s.enabled).length },
          })

          // Which register entries an adapter actually implements. A solutions source with no adapter is a
          // harmless state — it simply never ingests — but offering a live toggle for one is not: the
          // operator flips it, nothing happens, and the page has taught them to distrust it. Read from the
          // adapter list rather than a column, because "does code exist" is a fact about the repository.
          const { SOLUTION_ADAPTERS } = await import('~/lib/solutions/sources/runner')
          const implemented = new Set<string>(SOLUTION_ADAPTERS)

          return Response.json({
            sources: sources.map((source) => ({ ...source, connectorImplemented: implemented.has(source.key) })),
            // Surfaced so the UI can explain *why* a toggle is unavailable rather than just
            // disabling it: a scrape with no recorded review cannot be enabled at all.
            blockedOnReview: sources
              .filter((s) => s.kind === 'public_scrape' && !s.enabled && s.termsReviewedAt === null)
              .map((s) => s.key),
            blockedOnConnector: sources.filter((s) => !implemented.has(s.key)).map((s) => s.key),
          })
        } catch (error) {
          const response = platformAdminErrorResponse(error)
          if (response) return response
          console.error('admin solutions sources list error:', error)
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
            const recorded = await recordSourceTermsReview({
              key: body.key,
              reviewerUserId: principal.userId,
              notes: body.notes,
            }, platformDb)

            await auditPlatformAdminAction(principal, {
              action: 'admin.solutions.sources.record-review',
              targetType: 'solution-source',
              targetId: body.key,
              result: recorded ? 'allowed' : 'failed',
              // The note itself goes in the register, not the audit event — the audit trail records
              // that a review happened and by whom, which is the part that must be tamper-evident.
              details: { recorded },
            })

            if (!recorded) return Response.json({ error: 'not_found' }, { status: 404 })
            return Response.json({ key: body.key, termsReviewed: true })
          }

          // `platformDb`: migration 0125 gives neither the app nor the worker role UPDATE on
          // solution_sources. A worker able to enable its own data source would make the kill switch
          // decorative, so the only writer is a reviewed operator action — this one.
          const outcome = await setSolutionSourceEnabled(
            { key: body.key, enabled: body.action === 'enable' },
            platformDb,
          )

          await auditPlatformAdminAction(principal, {
            action: `admin.solutions.sources.${body.action}`,
            targetType: 'solution-source',
            targetId: body.key,
            result: outcome.status === 'updated' || outcome.status === 'unchanged' ? 'allowed' : 'failed',
            details: { outcome: outcome.status },
          })

          switch (outcome.status) {
            case 'not_found':
              return Response.json({ error: 'not_found' }, { status: 404 })
            case 'review_required':
              // 409, not 422: the request is well-formed and the operator is authorised. What is
              // missing is a recorded terms review, which they can supply and retry.
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
          console.error('admin solutions sources action error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
