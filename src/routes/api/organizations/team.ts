import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { getTeamSnapshot, requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/organizations/contracts'

export const Route = createFileRoute('/api/organizations/team')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const snapshot = await getTeamSnapshot(principal)
          if (!snapshot) return Response.json({ error: 'Organization not found' }, { status: 404 })
          return Response.json(snapshot)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Team snapshot error:', error)
          return Response.json({ error: 'Failed to load team' }, { status: 500 })
        }
      },
    },
  },
})
