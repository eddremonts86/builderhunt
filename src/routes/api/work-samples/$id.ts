import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { deleteWorkSampleAnalysis } from '~/shared/lib/repositories/work-samples'

export const Route = createFileRoute('/api/work-samples/$id')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['DELETE']),

      DELETE: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const deleted = await withTenantContext(principal, (tx) =>
            deleteWorkSampleAnalysis(tx, principal.userId, params.id),
          )
          if (!deleted) return Response.json({ error: 'Not found' }, { status: 404 })
          return Response.json({ success: true })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('work-sample delete error:', error)
          return Response.json({ error: 'Failed to delete work sample' }, { status: 500 })
        }
      },
    },
  },
})
