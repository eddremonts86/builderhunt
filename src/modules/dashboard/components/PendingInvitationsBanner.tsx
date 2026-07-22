import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Mail } from 'lucide-react'

interface MyPendingInvitation {
  id: string
  organizationName: string
  role: 'admin' | 'member'
  expiresAt: string
}

/**
 * Invitations are keyed by email, not user id, so this is the only way a
 * signed-in user's own pending invitations ever surface inside the app
 * itself — otherwise they only exist as a link in an email that, in any
 * environment without a real email provider configured, never even gets
 * sent (see TeamSettingsPage's "Copy invite link" for the admin side of
 * that same gap).
 */
export function PendingInvitationsBanner() {
  const [invitations, setInvitations] = React.useState<MyPendingInvitation[]>([])

  React.useEffect(() => {
    fetch('/api/organizations/invitations/mine', { credentials: 'include' })
      .then(async (r) => (r.ok ? r.json() : []))
      .then((data) => setInvitations(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  if (invitations.length === 0) return null

  return (
    <div
      className="glass-panel p-4 border-bh-accent/30 bg-bh-accent-soft/20"
      data-testid="pending-invitations-banner"
      role="status"
    >
      <div className="flex items-center gap-3">
        <Mail className="w-5 h-5 text-bh-accent shrink-0" aria-hidden="true" />
        <p className="text-sm font-semibold text-bh-text">
          {invitations.length === 1
            ? "You've been invited to join a team"
            : `You've been invited to join ${invitations.length} teams`}
        </p>
      </div>
      <ul className="space-y-2 mt-3">
        {invitations.map((invitation) => (
          <li
            key={invitation.id}
            className="flex items-center justify-between gap-3 pl-8"
            data-testid={`pending-invitation-${invitation.id}`}
          >
            <p className="text-sm text-bh-text-muted truncate">
              <span className="font-medium text-bh-text">{invitation.organizationName}</span>
              {' — as '}
              {invitation.role}
            </p>
            <Link
              to="/team/invite/$invitationId"
              params={{ invitationId: invitation.id }}
              className="btn-primary btn-sm shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
            >
              View invitation
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
