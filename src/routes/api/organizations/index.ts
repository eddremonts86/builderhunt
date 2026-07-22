import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { generateOrganizationSlug, getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { listMyOrganizations, toOrganizationSummaryDtoList } from '~/shared/lib/organizations/contracts'

const CreateBody = z.object({
  name: z.string().trim().min(2).max(80),
})

export const Route = createFileRoute('/api/organizations/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Authentication required' }, { status: 401 })
          const records = await listMyOrganizations(session.user.id)
          return Response.json(toOrganizationSummaryDtoList(records))
        } catch (error) {
          console.error('Organizations list error:', error)
          return Response.json({ error: 'Failed to list organizations' }, { status: 500 })
        }
      },

      POST: async ({ request }) => {
        try {
          const parsed = CreateBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const lifecycle = await getOrganizationLifecycle()
          const organization = await lifecycle.createOrganization(request, {
            name: parsed.data.name,
            slug: generateOrganizationSlug(parsed.data.name),
          })
          return Response.json({ id: organization.id, name: organization.name, slug: organization.slug })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Organization create error:', error)
          return Response.json({ error: 'Failed to create organization' }, { status: 500 })
        }
      },

      // Deletes the caller's own active organization — never a client-chosen
      // one — via `requireTenantPrincipal`. `deleteOrganization` itself
      // enforces owner-only + recent-auth.
      DELETE: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const lifecycle = await getOrganizationLifecycle()
          await lifecycle.deleteOrganization(request, principal.organizationId)
          return Response.json({ ok: true })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Organization delete error:', error)
          return Response.json({ error: 'Failed to delete organization' }, { status: 500 })
        }
      },
    },
  },
})

function lifecycleErrorResponse(error: unknown) {
  if (error instanceof OrganizationLifecycleError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  return null
}
