// /api/queries/$id/visibility — flip a saved query between `private`
// and `organization`. The principal-scoped repository is the only
// place the visibility check is enforced; a peer who can read the
// row can flip it (can()'s `resource:share` action), but a peer who
// cannot even read it gets a 404, not a 403.

import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { changeSavedQueryVisibilityForPrincipal } from '~/shared/lib/repositories/saved-queries'
import { SharedResourceError, VisibilitySchema } from '~/shared/lib/shared-resources/contracts'

const Body = z.object({
  visibility: VisibilitySchema,
})

export const Route = createFileRoute('/api/queries/$id/visibility')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const raw = await request.json().catch(() => ({}))
          const parsed = Body.safeParse(raw)
          if (!parsed.success) {
            return Response.json(
              { error: 'invalid_visibility', issues: parsed.error.issues },
              { status: 422 },
            )
          }
          const updated = await withTenantContext(principal, (tx) =>
            changeSavedQueryVisibilityForPrincipal(tx, principal, params.id, parsed.data.visibility),
          )
          return Response.json(updated)
        } catch (error) {
          if (error instanceof SharedResourceError) {
            return Response.json(
              { error: error.code, message: error.message },
              { status: error.status },
            )
          }
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Query visibility error:', error)
          return Response.json({ error: 'Failed to change visibility' }, { status: 500 })
        }
      },
    },
  },
})
