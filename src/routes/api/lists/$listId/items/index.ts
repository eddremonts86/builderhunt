// /api/lists/$listId/items — list the items, add a new one.

import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import {
  addItemToListForPrincipal,
  listItemsForList,
} from '~/shared/lib/repositories/builder-lists'
import { SharedResourceError, stripOrganizationAuthority } from '~/shared/lib/shared-resources/contracts'

const AddBody = z.object({
  builderIdentityId: z.string().min(1),
})

export const Route = createFileRoute('/api/lists/$listId/items/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const items = await withTenantContext(principal, (tx) =>
            listItemsForList(tx, principal, params.listId),
          )
          return Response.json(items)
        } catch (error) {
          if (error instanceof SharedResourceError) {
            return Response.json({ error: error.code, message: error.message }, { status: error.status })
          }
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Items list error:', error)
          return Response.json({ error: 'Failed to fetch items' }, { status: 500 })
        }
      },
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const limitResult = await rateLimit('builder-list-item-add', `${principal.organizationId}:${principal.userId}`, 100, 60 * 60)
          if (!limitResult.allowed) {
            return Response.json(
              { error: 'Too many item additions in the last hour. Try again later.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limitResult.resetMs / 1000)) } },
            )
          }
          const raw = await request.json().catch(() => ({}))
          const sanitized = stripOrganizationAuthority(raw as Record<string, unknown>)
          const parsed = AddBody.safeParse(sanitized)
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 422 })
          }
          const item = await withTenantContext(principal, (tx) =>
            addItemToListForPrincipal(tx, principal, params.listId, parsed.data.builderIdentityId),
          )
          // Idempotent: a duplicate add returns 200 with the existing item
          // (the repository returns null on the duplicate, so the body is null).
          return Response.json(item, { status: item ? 201 : 200 })
        } catch (error) {
          if (error instanceof SharedResourceError) {
            return Response.json({ error: error.code, message: error.message }, { status: error.status })
          }
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Items add error:', error)
          return Response.json({ error: 'Failed to add item' }, { status: 500 })
        }
      },
    },
  },
})
