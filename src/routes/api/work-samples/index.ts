import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listWorkSampleAnalyses } from '~/shared/lib/repositories/work-samples'

export const Route = createFileRoute('/api/work-samples/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const url = new URL(request.url)
          const builderId = url.searchParams.get('builderId') ?? undefined
          const rows = await withTenantContext(principal, (tx) =>
            listWorkSampleAnalyses(tx, principal.userId, builderId),
          )
          return Response.json(rows)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('work-samples list error:', error)
          return Response.json({ error: 'Failed to fetch work samples' }, { status: 500 })
        }
      },
    },
  },
})
