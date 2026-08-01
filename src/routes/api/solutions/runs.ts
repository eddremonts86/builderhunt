/**
 * `GET /api/solutions/runs` — list saved runs. `POST` — save one explicitly (plan 43 Phase 8).
 *
 * The POST is the "explicit save" spec.md requires: generation returns a run, and keeping it is a separate act.
 * The body carries the run the server just produced, which invites the obvious question — why trust the client
 * with it? Because the alternative is worse. Holding every generated run server-side to be claimed later means
 * storing what nobody asked to keep, which is the exact thing "nothing is saved until you explicitly save"
 * forbids. So the payload is re-validated against the domain contracts on the way in, and what it cannot do is
 * more interesting than what it can: the credit fields are not accepted from the client at all, and every row is
 * written under the principal's own organization.
 */
import { createFileRoute } from '@tanstack/react-router'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { solutionBriefSchema, solutionRouteSchema } from '~/shared/lib/solutions/contracts'
import { listRuns, saveRun, SolutionsRepositoryError, toSolutionRunDto, findRun } from '~/shared/lib/repositories/solutions'

const SaveBody = z.object({
  brief: solutionBriefSchema,
  briefId: z.string().min(1).max(200).optional(),
  rankingMode: z.enum(['recommended', 'maximum_quality', 'lower_cost_time']),
  retrievalQueryHash: z.string().min(1).max(200),
  compositionHash: z.string().min(1).max(200),
  composerVersion: z.string().min(1).max(80),
  interpretPromptVersion: z.string().min(1).max(80).nullable().optional(),
  explainPromptVersion: z.string().min(1).max(80).nullable().optional(),
  componentVersionIds: z.array(z.string().min(1)).max(100).default([]),
  evidenceIds: z.array(z.string().min(1)).max(200).default([]),
  warnings: z.array(z.string().min(1).max(300)).max(20).default([]),
  routes: z.array(z.object({
    route: solutionRouteSchema,
    explanationProvenance: z.enum(['model', 'deterministic']),
    explanationFallbackReason: z.string().min(1).max(80).nullable().optional(),
  }).strict()).min(1).max(3),
}).strict()

export const Route = createFileRoute('/api/solutions/runs')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const briefId = new URL(request.url).searchParams.get('briefId')
          const rows = await withTenantContext(principal, (tx) =>
            listRuns(tx, principal, { ...(briefId ? { briefId } : {}), limit: 50 }))
          // The list carries no routes: three route graphs per run would make a list of fifty enormous, and a
          // list is for choosing which run to open.
          return Response.json(rows.map((run) => ({
            id: run.id,
            briefId: run.briefId,
            rankingMode: run.rankingMode,
            compositionHash: run.compositionHash,
            composerVersion: run.composerVersion,
            createdAt: run.createdAt.toISOString(),
          })))
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Solutions runs list error:', error)
          return Response.json({ error: 'Failed to list runs' }, { status: 500 })
        }
      },
      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit('solutions-run-save', `${principal.organizationId}:${principal.userId}`, 100, 24 * 60 * 60)
          if (!limit.allowed) {
            return Response.json({ error: 'Too many saved runs today.' }, { status: 429 })
          }

          const parsed = SaveBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid run', issues: parsed.error.issues.slice(0, 5) }, { status: 422 })
          }

          const id = randomUUID()
          const saved = await withTenantContext(principal, async (tx) => {
            await saveRun(tx, principal, {
              id,
              briefId: parsed.data.briefId ?? null,
              briefSnapshot: parsed.data.brief,
              rankingMode: parsed.data.rankingMode,
              retrievalQueryHash: parsed.data.retrievalQueryHash,
              compositionHash: parsed.data.compositionHash,
              composerVersion: parsed.data.composerVersion,
              interpretPromptVersion: parsed.data.interpretPromptVersion ?? null,
              explainPromptVersion: parsed.data.explainPromptVersion ?? null,
              componentVersionIds: parsed.data.componentVersionIds,
              evidenceIds: parsed.data.evidenceIds,
              sourceStatuses: [],
              warnings: parsed.data.warnings,
              // Deliberately not from the body. A client that could name its own reservation could attribute a
              // charge to one that belongs to a different run.
              creditReservationId: null,
              creditSettledUnits: null,
              routes: parsed.data.routes.map((entry) => ({
                route: entry.route,
                explanationProvenance: entry.explanationProvenance,
                explanationFallbackReason: entry.explanationFallbackReason ?? null,
              })),
            })
            return findRun(tx, principal, id)
          })

          if (!saved) return Response.json({ error: 'Failed to save run' }, { status: 500 })
          return Response.json(toSolutionRunDto(saved.run, saved.routes), { status: 201 })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof SolutionsRepositoryError) {
            return Response.json({ error: error.message, code: error.code }, { status: 422 })
          }
          console.error('Solutions run save error:', error)
          return Response.json({ error: 'Failed to save run' }, { status: 500 })
        }
      },
    },
  },
})
