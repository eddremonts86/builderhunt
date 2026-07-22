import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'

const Body = z.object({
  organizationId: z.string().min(1),
})

export const Route = createFileRoute('/api/organizations/switch')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const parsed = Body.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const lifecycle = await getOrganizationLifecycle()
          await lifecycle.switchActiveOrganization(request, parsed.data.organizationId)
          return Response.json({ ok: true })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Organization switch error:', error)
          return Response.json({ error: 'Failed to switch organization' }, { status: 500 })
        }
      },
    },
  },
})

function lifecycleErrorResponse(error: unknown) {
  return error instanceof OrganizationLifecycleError
    ? Response.json({ error: error.message }, { status: error.status })
    : null
}
