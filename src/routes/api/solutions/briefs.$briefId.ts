/**
 * `PATCH /api/solutions/briefs/:briefId` — rename or edit a saved brief. `DELETE` — erase it and everything it
 * produced (plan 43 Phase 8).
 *
 * Editing a brief cannot rewrite history: every run stores its own `brief_snapshot`. Deleting one does erase
 * its runs, by cascade, because that is what an erasure request means by "delete this brief".
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { solutionBriefSchema } from '~/shared/lib/solutions/contracts'
import { deleteBrief, findBrief, SolutionsRepositoryError, toSolutionBriefDto, updateBrief } from '~/shared/lib/repositories/solutions'

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  brief: solutionBriefSchema.optional(),
}).strict().refine((body) => body.title !== undefined || body.brief !== undefined, {
  message: 'Nothing to change',
})

export const Route = createFileRoute('/api/solutions/briefs/$briefId')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PATCH', 'DELETE']),

      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const brief = await withTenantContext(principal, (tx) => findBrief(tx, principal, params.briefId))
          if (!brief) return Response.json({ error: 'Brief not found' }, { status: 404 })
          return Response.json(toSolutionBriefDto(brief))
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Solutions brief read error:', error)
          return Response.json({ error: 'Failed to read brief' }, { status: 500 })
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = PatchBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid change', issues: parsed.error.issues.slice(0, 5) }, { status: 422 })
          }
          const updated = await withTenantContext(principal, (tx) => updateBrief(tx, principal, params.briefId, {
            ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
            ...(parsed.data.brief === undefined ? {} : { brief: parsed.data.brief }),
          }))
          return Response.json(toSolutionBriefDto(updated))
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof SolutionsRepositoryError) {
            const status = error.code === 'not_found' ? 404 : 422
            return Response.json({ error: error.message, code: error.code }, { status })
          }
          console.error('Solutions brief update error:', error)
          return Response.json({ error: 'Failed to update brief' }, { status: 500 })
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const deleted = await withTenantContext(principal, (tx) => deleteBrief(tx, principal, params.briefId))
          if (!deleted) return Response.json({ error: 'Brief not found' }, { status: 404 })
          return new Response(null, { status: 204 })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Solutions brief delete error:', error)
          return Response.json({ error: 'Failed to delete brief' }, { status: 500 })
        }
      },
    },
  },
})
