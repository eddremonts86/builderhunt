import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { generateOrganizationSlug, getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { listMyOrganizations, toOrganizationSummaryDtoList } from '~/shared/lib/organizations/contracts'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { requestNormalDeletion } from '~/shared/lib/organizations/deletion'

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

      // Schedules the caller's own active organization for deletion after a
      // grace period — never a client-chosen one, via `requireTenantPrincipal`.
      // `requestNormalDeletion` enforces owner-only + recent-auth (via the
      // underlying `requestOrganizationDeletion`) and additionally stops
      // subscription renewal right now (plans/stripe-billing-platform/
      // tasks.md §9 "Integrate subscription-safe organization deletion").
      DELETE: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const result = await requestNormalDeletion(request, principal, { provider: getBillingProvider() })
          return Response.json({ ok: true, id: result.id, gracePeriodEndsAt: result.gracePeriodEndsAt.toISOString() })
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
