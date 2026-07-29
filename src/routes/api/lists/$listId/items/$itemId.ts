// /api/lists/$listId/items/$itemId — remove a single item.

import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { removeItemFromListForPrincipal } from '~/shared/lib/repositories/builder-lists'
import { SharedResourceError } from '~/shared/lib/shared-resources/contracts'

export const Route = createFileRoute('/api/lists/$listId/items/$itemId')({
  component: () => null,
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          await withTenantContext(principal, (tx) =>
            removeItemFromListForPrincipal(tx, principal, params.listId, params.itemId),
          )
          return Response.json({ success: true })
        } catch (error) {
          if (error instanceof SharedResourceError) {
            return Response.json({ error: error.code, message: error.message }, { status: error.status })
          }
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Item remove error:', error)
          return Response.json({ error: 'Failed to remove item' }, { status: 500 })
        }
      },
    },
  },
})
