import { createFileRoute } from '@tanstack/react-router'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { findLinkedAccountClusters } from '~/shared/lib/abuse/linked-accounts'

const DEFAULT_WINDOW_DAYS = 30

export const Route = createFileRoute('/api/admin/abuse/clusters')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const url = new URL(request.url)
          const windowDaysParam = Number(url.searchParams.get('windowDays'))
          const windowDays = Number.isFinite(windowDaysParam) && windowDaysParam > 0 ? windowDaysParam : DEFAULT_WINDOW_DAYS
          const sinceDate = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

          const clusters = await findLinkedAccountClusters(sinceDate)
          return Response.json({ windowDays, clusters })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin abuse clusters error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
