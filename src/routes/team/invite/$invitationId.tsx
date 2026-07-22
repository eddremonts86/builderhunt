import { createFileRoute } from '@tanstack/react-router'
import { OrganizationInvitationPage } from '~/modules/auth/components/OrganizationInvitationPage'

export const Route = createFileRoute('/team/invite/$invitationId')({
  component: InvitePage,
})

function InvitePage() {
  const { invitationId } = Route.useParams()
  return <OrganizationInvitationPage invitationId={invitationId} />
}
