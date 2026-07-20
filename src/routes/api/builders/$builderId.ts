import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import {
  deleteOrganizationBuilder,
  updateOrganizationBuilder,
} from '~/shared/lib/repositories/organization-builders'
import { findPublishedBuilderProfile } from '~/shared/lib/repositories/public-builders'

const PatchBody = z.object({
  topics: z.array(z.string().min(1).max(40)).max(20).optional(),
  country: z.string().min(2).max(60).nullable().optional(),
  language: z.string().min(2).max(40).nullable().optional(),
})

export const Route = createFileRoute('/api/builders/$builderId')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const builder = await findPublishedBuilderProfile(params.builderId)
          if (!builder) return Response.json({ error: 'Builder not found' }, { status: 404 })
          return Response.json(builder)
        } catch (error) {
          console.error('Builder fetch error:', error)
          return Response.json({ error: 'Failed to fetch builder' }, { status: 500 })
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = PatchBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }
          if (Object.keys(parsed.data).length === 0) {
            return Response.json({ error: 'No fields to update' }, { status: 400 })
          }
          const updated = await withTenantContext(principal, (tx) =>
            updateOrganizationBuilder(tx, principal.organizationId, params.builderId, parsed.data),
          )
          if (!updated) return Response.json({ error: 'Builder not found' }, { status: 404 })
          return Response.json(updated)
        } catch (error) {
          const response = tenantAuthorizationResponse(error)
          if (response) return response
          console.error('Builder update error:', error)
          return Response.json({ error: 'Failed to update builder' }, { status: 500 })
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const deleted = await withTenantContext(principal, (tx) =>
            deleteOrganizationBuilder(tx, principal.organizationId, params.builderId),
          )
          if (!deleted) return Response.json({ error: 'Builder not found' }, { status: 404 })
          return Response.json({ success: true })
        } catch (error) {
          const response = tenantAuthorizationResponse(error)
          if (response) return response
          console.error('Builder delete error:', error)
          return Response.json({ error: 'Failed to delete builder' }, { status: 500 })
        }
      },
    },
  },
})

function tenantAuthorizationResponse(error: unknown) {
  return error instanceof TenantAuthorizationError
    ? Response.json({ error: error.message }, { status: error.status })
    : null
}
