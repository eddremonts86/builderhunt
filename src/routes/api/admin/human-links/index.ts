/**
 * Identity-link review queue (plan 43 — solutions-intelligence Phase 3, "Implement reversible
 * identity linking"): the human decision point that a probabilistic candidate cannot bypass.
 *
 * Platform-admin only, and deliberately so. Approving a link asserts that two source accounts belong
 * to the same real person — a claim about someone who is usually not a user of this product and has
 * not asked to be catalogued. That is not a tenant-scoped action, and no organization owns the
 * answer, which is why this sits behind `requirePlatformAdminPrincipal` rather than a tenant guard.
 *
 * Without this surface the queue is a dead end: `decideLink` routes every similarity signal to
 * `pending_review`, and the database refuses to auto-approve one, so nothing would ever promote a
 * correct-but-inferred match. GET lists, POST records a verdict.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { platformDb, publicDb } from '~/shared/lib/db/client'
import { listLinkReviewQueue, resolveLinkReview } from '~/shared/lib/repositories/human-profiles'

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const VerdictSchema = z.object({
  sourceLinkId: z.string().min(1),
  verdict: z.enum(['approved', 'rejected']),
}).strict()

export const Route = createFileRoute('/api/admin/human-links/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const url = new URL(request.url)
          const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_query', issues: parsed.error.issues }, { status: 422 })
          }

          const queue = await listLinkReviewQueue(parsed.data.limit, publicDb)

          await auditPlatformAdminAction(principal, {
            action: 'admin.human-links.list',
            targetType: 'human-source-link',
            targetId: null,
            result: 'allowed',
            details: { count: queue.length },
          })

          return Response.json({ queue })
        } catch (error) {
          const response = platformAdminErrorResponse(error)
          if (response) return response
          console.error('admin human-links list error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },

      POST: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const parsed = VerdictSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 })
          }

          // `platformDb`, not `publicDb`: migration 0122 gives the app role SELECT only on
          // `human_source_links` on purpose — asserting that two real people are the same person is
          // never a request-scoped write. Routing this through the app connection returned 500
          // (permission denied) on the first live call, which is the grant design working, not a
          // schema mistake to loosen.
          const resolved = await resolveLinkReview({
            sourceLinkId: parsed.data.sourceLinkId,
            verdict: parsed.data.verdict,
            reviewerUserId: principal.userId,
          }, platformDb)

          await auditPlatformAdminAction(principal, {
            action: `admin.human-links.${parsed.data.verdict}`,
            targetType: 'human-source-link',
            targetId: parsed.data.sourceLinkId,
            // A lost race is not a failure of authorization, but it is worth recording that the
            // verdict did not land — otherwise the audit trail implies a decision that never applied.
            result: resolved ? 'allowed' : 'failed',
            details: { verdict: parsed.data.verdict, applied: resolved },
          })

          if (!resolved) {
            // 409, not 404: the row exists, it is simply no longer pending. Another reviewer decided
            // first, or the proposal was withdrawn. Silently overwriting that is exactly what a
            // review queue must never do, so the caller is told to re-read instead.
            return Response.json(
              { error: 'not_pending', detail: 'This proposal is no longer awaiting review — reload the queue.' },
              { status: 409 },
            )
          }

          return Response.json({ sourceLinkId: parsed.data.sourceLinkId, verdict: parsed.data.verdict })
        } catch (error) {
          const response = platformAdminErrorResponse(error)
          if (response) return response
          console.error('admin human-links verdict error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
