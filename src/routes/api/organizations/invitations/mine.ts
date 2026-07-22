import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { listInvitationsForEmail, toMyPendingInvitationDto } from '~/shared/lib/organizations/contracts'

export const Route = createFileRoute('/api/organizations/invitations/mine')({
  component: () => null,
  server: {
    handlers: {
      // Always the CALLER'S OWN session email — never a client-supplied
      // address, or any authenticated user could enumerate who else has
      // been invited where. An unverified email returns an empty list
      // rather than an error: acceptance itself already requires a
      // verified, matching email, so an unverified account learning "yes,
      // there's an invitation waiting" would leak information it can't
      // act on anyway.
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Authentication required' }, { status: 401 })
          if (!session.user.emailVerified) return Response.json([])

          const invitations = await listInvitationsForEmail(session.user.email)
          return Response.json(invitations.map(toMyPendingInvitationDto))
        } catch (error) {
          console.error('My invitations list error:', error)
          return Response.json({ error: 'Failed to list invitations' }, { status: 500 })
        }
      },
    },
  },
})
