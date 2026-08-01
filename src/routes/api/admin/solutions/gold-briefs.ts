/**
 * `GET/POST/DELETE /api/admin/solutions/gold-briefs` — the human half of the gold set (plan 43 Phase 0).
 *
 * Platform-admin only, and written through the platform role: the evaluation corpus is not tenant data and an
 * ordinary session has no business reading it. `builderhunt_app` has no grant on `solution_gold_briefs` at all,
 * so a mistake in this route's authorization fails at the database rather than leaking the corpus.
 *
 * ## Why humans need CRUD at all
 *
 * The seeded 60 are machine-authored, and tasks.md is blunt about what that makes them: scaffolding for
 * regression detection, never evidence of quality, because the generator and the grader share assumptions. Only
 * human-authored judgments may be cited as a quality gate — so a person has to be able to add one during the
 * beta without a deploy, and that is this.
 *
 * `authorship` is forced to `human` on write. A synthetic record created here would be indistinguishable from a
 * curated one a week later, and the whole split depends on the two never mixing.
 */
import { createFileRoute } from '@tanstack/react-router'
import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { platformDb } from '~/shared/lib/db/client'
import { solutionGoldBriefs } from '~/shared/lib/db/schema'
import { goldBriefSchema } from '~/shared/lib/solutions/gold-set'

const CreateBody = z.object({
  briefText: z.string().min(1).max(4000),
  expected: goldBriefSchema.shape.expected,
  notes: z.string().max(1000).nullable().optional(),
}).strict()

const DeleteBody = z.object({ id: z.string().min(1).max(80) }).strict()

export const Route = createFileRoute('/api/admin/solutions/gold-briefs')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const rows = await platformDb.select().from(solutionGoldBriefs)
            .orderBy(desc(solutionGoldBriefs.createdAt))
            .limit(500)

          await auditPlatformAdminAction(principal, {
            action: 'admin.solutions.gold-briefs.list',
            targetType: 'solution-gold-brief',
            targetId: null,
            result: 'allowed',
            details: { count: rows.length },
          })

          return Response.json({
            briefs: rows.map((row) => ({
              id: row.id,
              authorship: row.authorship,
              briefText: row.briefText,
              expected: row.expected,
              notes: row.notes,
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
            })),
            // Stated in the payload so a dashboard cannot present a human count as the whole corpus: the
            // synthetic 60 live in `tests/fixtures/solutions/gold-set.json` and are not in this table.
            syntheticRecordsLiveInRepository: 'tests/fixtures/solutions/gold-set.json',
          })
        } catch (error) {
          const response = platformAdminErrorResponse(error)
          if (response) return response
          console.error('admin solutions gold-briefs list error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },

      POST: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const parsed = CreateBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_body', issues: parsed.error.issues.slice(0, 5) }, { status: 422 })
          }

          const [row] = await platformDb.insert(solutionGoldBriefs).values({
            id: randomUUID(),
            authorship: 'human',
            briefText: parsed.data.briefText,
            expected: parsed.data.expected as unknown as Record<string, unknown>,
            createdByUserId: principal.userId,
            notes: parsed.data.notes ?? null,
          }).returning()

          await auditPlatformAdminAction(principal, {
            action: 'admin.solutions.gold-briefs.create',
            targetType: 'solution-gold-brief',
            targetId: row.id,
            result: 'allowed',
            details: { capabilityKeys: parsed.data.expected.capabilityKeys },
          })

          return Response.json({ id: row.id, authorship: row.authorship }, { status: 201 })
        } catch (error) {
          const response = platformAdminErrorResponse(error)
          if (response) return response
          console.error('admin solutions gold-briefs create error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },

      DELETE: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const parsed = DeleteBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 422 })

          const deleted = await platformDb.delete(solutionGoldBriefs)
            .where(eq(solutionGoldBriefs.id, parsed.data.id))
            .returning({ id: solutionGoldBriefs.id })

          await auditPlatformAdminAction(principal, {
            action: 'admin.solutions.gold-briefs.delete',
            targetType: 'solution-gold-brief',
            targetId: parsed.data.id,
            result: deleted.length > 0 ? 'allowed' : 'denied',
            details: {},
          })

          if (deleted.length === 0) return Response.json({ error: 'Not found' }, { status: 404 })
          return new Response(null, { status: 204 })
        } catch (error) {
          const response = platformAdminErrorResponse(error)
          if (response) return response
          console.error('admin solutions gold-briefs delete error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
