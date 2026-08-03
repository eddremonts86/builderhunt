/**
 * `GET /api/solutions/runs/:runId` — read one saved run. `DELETE` — erase it. `POST` — record feedback
 * (plan 43 Phase 8).
 *
 * There is deliberately no PATCH. `solution_runs` carries no UPDATE grant, and a route that offered one would
 * fail at the database with a 500 rather than saying what it means: a stored recommendation is what an
 * organization was told on a given day, and one that could be edited afterwards is worthless in the dispute it
 * exists for.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { deleteRun, findRun, listFeedback, recordFeedback, toSolutionRunDto } from '~/shared/lib/repositories/solutions'

const FeedbackBody = z.object({
  routeType: z.enum(['human', 'ai', 'hybrid']),
  chosen: z.boolean(),
  reason: z.string().max(500).nullable().optional(),
}).strict()

export const Route = createFileRoute('/api/solutions/runs/$runId')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),

      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const found = await withTenantContext(principal, async (tx) => {
            const run = await findRun(tx, principal, params.runId)
            if (!run) return null
            return { ...run, feedback: await listFeedback(tx, principal, params.runId) }
          })
          // 404 rather than 403 for another tenant's run: a distinguishable "forbidden" confirms the id exists.
          if (!found) return Response.json({ error: 'Run not found' }, { status: 404 })

          return Response.json({
            ...toSolutionRunDto(found.run, found.routes),
            // Only whether *this* member has answered, and what they said. Another member's opinion is not
            // theirs to read from a run view.
            myFeedback: found.feedback
              .filter((row) => row.createdByUserId === principal.userId)
              .map((row) => ({ routeType: row.routeType, chosen: row.chosen, reason: row.reason })),
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Solutions run read error:', error)
          return Response.json({ error: 'Failed to read run' }, { status: 500 })
        }
      },
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = FeedbackBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid feedback', issues: parsed.error.issues.slice(0, 5) }, { status: 422 })
          }
          const recorded = await withTenantContext(principal, async (tx) => {
            // Checked here so feedback on another tenant's run is a 404 rather than a foreign-key error.
            const run = await findRun(tx, principal, params.runId)
            if (!run) return null
            return recordFeedback(tx, principal, {
              id: randomUUID(),
              runId: params.runId,
              routeType: parsed.data.routeType,
              chosen: parsed.data.chosen,
              reason: parsed.data.reason ?? null,
            })
          })
          if (!recorded) return Response.json({ error: 'Run not found' }, { status: 404 })
          return Response.json({ routeType: recorded.routeType, chosen: recorded.chosen, reason: recorded.reason })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Solutions feedback error:', error)
          return Response.json({ error: 'Failed to record feedback' }, { status: 500 })
        }
      },
      /**
       * A stored run is immutable, and this says so with a status instead of by omission.
       *
       * Without an explicit handler the framework answers an unimplemented method with **200 and an HTML
       * document** — found by the e2e spec that asserted a PATCH is refused. A client scripting against this
       * API would read 200 and conclude the edit landed. 405 with `Allow` is the answer that is both true and
       * actionable.
       */
      PATCH: () => Response.json(
        { error: 'A saved run is immutable. Delete it and generate a new one.', code: 'method_not_allowed' },
        { status: 405, headers: { allow: 'GET, POST, DELETE' } },
      ),
      PUT: () => Response.json(
        { error: 'A saved run is immutable. Delete it and generate a new one.', code: 'method_not_allowed' },
        { status: 405, headers: { allow: 'GET, POST, DELETE' } },
      ),
      DELETE: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const deleted = await withTenantContext(principal, (tx) => deleteRun(tx, principal, params.runId))
          if (!deleted) return Response.json({ error: 'Run not found' }, { status: 404 })
          return new Response(null, { status: 204 })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Solutions run delete error:', error)
          return Response.json({ error: 'Failed to delete run' }, { status: 500 })
        }
      },
    },
  },
})
