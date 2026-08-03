/**
 * `GET /api/solutions/briefs` — list saved briefs. `POST` — save one (plan 43 Phase 8).
 *
 * A brief is saved only when a user asks. Generation never writes one: a run carries its own `brief_snapshot`,
 * so keeping the question is a separate decision from keeping the answer.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { solutionBriefSchema } from '~/shared/lib/solutions/contracts'
import { listBriefs, saveBrief, SolutionsRepositoryError, toSolutionBriefDto } from '~/shared/lib/repositories/solutions'

const SaveBody = z.object({
  title: z.string().min(1).max(200),
  brief: solutionBriefSchema,
}).strict()

export const Route = createFileRoute('/api/solutions/briefs')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const rows = await withTenantContext(principal, (tx) => listBriefs(tx, principal))
          return Response.json(rows.map(toSolutionBriefDto))
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Solutions briefs list error:', error)
          return Response.json({ error: 'Failed to list briefs' }, { status: 500 })
        }
      },
      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit('solutions-brief-save', `${principal.organizationId}:${principal.userId}`, 100, 24 * 60 * 60)
          if (!limit.allowed) return Response.json({ error: 'Too many saved briefs today.' }, { status: 429 })

          const parsed = SaveBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid brief', issues: parsed.error.issues.slice(0, 5) }, { status: 422 })
          }
          const saved = await withTenantContext(principal, (tx) => saveBrief(tx, principal, {
            id: randomUUID(),
            title: parsed.data.title,
            brief: parsed.data.brief,
          }))
          return Response.json(toSolutionBriefDto(saved), { status: 201 })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof SolutionsRepositoryError) {
            return Response.json({ error: error.message, code: error.code }, { status: 422 })
          }
          console.error('Solutions brief save error:', error)
          return Response.json({ error: 'Failed to save brief' }, { status: 500 })
        }
      },
    },
  },
})
