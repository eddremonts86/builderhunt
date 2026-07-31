// /api/lists/$listId — read one list, edit it, delete it.

import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import {
  deleteBuilderListForPrincipal,
  findVisibleBuilderListById,
  updateBuilderListForPrincipal,
} from '~/shared/lib/repositories/builder-lists'
import { SharedResourceError } from '~/shared/lib/shared-resources/contracts'

const UpdateBody = z.object({
  expectedVersion: z.number().int().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  visibility: z.enum(['private', 'organization']).optional(),
})

export const Route = createFileRoute('/api/lists/$listId')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const list = await withTenantContext(principal, (tx) =>
            findVisibleBuilderListById(tx, principal, params.listId),
          )
          if (!list) return Response.json({ error: 'not_found' }, { status: 404 })
          return Response.json(list)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('List read error:', error)
          return Response.json({ error: 'Failed to read list' }, { status: 500 })
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const raw = await request.json().catch(() => ({}))
          const parsed = UpdateBody.safeParse(raw)
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 422 })
          }
          const { expectedVersion, ...fields } = parsed.data
          const updated = await withTenantContext(principal, (tx) =>
            updateBuilderListForPrincipal(tx, principal, params.listId, { expectedVersion, ...fields }),
          )
          return Response.json(updated)
        } catch (error) {
          if (error instanceof SharedResourceError) {
            return Response.json({ error: error.code, message: error.message }, { status: error.status })
          }
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('List update error:', error)
          return Response.json({ error: 'Failed to update list' }, { status: 500 })
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          await withTenantContext(principal, (tx) =>
            deleteBuilderListForPrincipal(tx, principal, params.listId),
          )
          return Response.json({ success: true })
        } catch (error) {
          if (error instanceof SharedResourceError) {
            return Response.json({ error: error.code, message: error.message }, { status: error.status })
          }
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('List delete error:', error)
          return Response.json({ error: 'Failed to delete list' }, { status: 500 })
        }
      },
    },
  },
})
