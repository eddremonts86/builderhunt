import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { randomId } from '~/lib/utils'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import {
  createOrganizationBuilderNote,
  listOrganizationBuilderNotes,
  resolveOrganizationBuilderId,
} from '~/shared/lib/repositories/organization-builders'

const NoteBody = z.object({ content: z.string().trim().min(1).max(10_000) })

export const Route = createFileRoute('/api/builders/$builderId/notes')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const notes = await withTenantContext(principal, async (tx) => {
            const resolvedId = await resolveOrganizationBuilderId(tx, principal.organizationId, params.builderId)
            if (!resolvedId) return []
            return listOrganizationBuilderNotes(tx, principal.organizationId, resolvedId)
          })
          return Response.json(notes)
        } catch (error) {
          const response = tenantAuthorizationResponse(error)
          if (response) return response
          console.error('Notes fetch error:', error)
          return Response.json({ error: 'Failed to fetch notes' }, { status: 500 })
        }
      },
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = NoteBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }
          const note = await withTenantContext(principal, async (tx) => {
            const resolvedId = await resolveOrganizationBuilderId(tx, principal.organizationId, params.builderId)
            if (!resolvedId) return null
            return createOrganizationBuilderNote(tx, {
              id: randomId(),
              organizationId: principal.organizationId,
              userId: principal.userId,
              builderId: resolvedId,
              content: parsed.data.content,
            })
          })
          if (!note) return Response.json({ error: 'Builder not found' }, { status: 404 })
          return Response.json(note)
        } catch (error) {
          const response = tenantAuthorizationResponse(error)
          if (response) return response
          console.error('Notes create error:', error)
          return Response.json({ error: 'Failed to create note' }, { status: 500 })
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
