import * as React from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { organizationQueryKey } from '~/shared/lib/query-keys'
import { useActiveOrganizationId } from '~/shared/components/TenantQueryProvider'
import { TeamSettingsPage } from '~/modules/dashboard/components/TeamSettingsPage'
import type { InvitableRole, TeamSnapshotDto } from '~/shared/lib/organizations/contracts'

export const Route = createFileRoute('/_dashboard/settings/team')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  component: TeamSettingsRoute,
})

async function fetchTeamSnapshot(): Promise<TeamSnapshotDto> {
  const res = await fetch('/api/organizations/team', { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to load team')
  return res.json()
}

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return typeof body.error === 'string' ? body.error : fallback
}

function TeamSettingsRoute() {
  const { user } = Route.useRouteContext()
  const activeOrganizationId = useActiveOrganizationId()
  const queryClient = useQueryClient()
  const router = useRouter()
  const navigate = useNavigate()
  const [busy, setBusy] = React.useState(false)
  const [mutationError, setMutationError] = React.useState<string | null>(null)

  const { data: snapshot, isLoading, error } = useQuery({
    queryKey: organizationQueryKey(activeOrganizationId, 'team'),
    queryFn: fetchTeamSnapshot,
    enabled: activeOrganizationId !== null,
  })

  const teamQueryKey = organizationQueryKey(activeOrganizationId, 'team')

  // Role changes and member removal don't touch the caller's own active
  // organization — just refetch the snapshot to show the updated member/role.
  async function refreshSnapshot() {
    await queryClient.invalidateQueries({ queryKey: teamQueryKey })
  }

  // Leaving or deleting the organization ends the caller's own membership in
  // it — mirrors OrganizationSwitcher's switch flow: `router.invalidate()`
  // re-reads the now-null `activeOrganizationId` from the session, which
  // flows into `TenantQueryProvider`'s effect and clears every cached query,
  // then navigate away from a settings page for an org that's gone.
  async function leaveOrganizationContext() {
    await router.invalidate()
    navigate({ to: '/dashboard' })
  }

  async function runMutation(action: () => Promise<Response>, fallbackErrorMessage: string, onSuccess: () => Promise<void>) {
    setBusy(true)
    setMutationError(null)
    try {
      const response = await action()
      if (!response.ok) {
        setMutationError(await parseErrorMessage(response, fallbackErrorMessage))
        return
      }
      await onSuccess()
    } catch {
      setMutationError(fallbackErrorMessage)
    } finally {
      setBusy(false)
    }
  }

  const handleChangeRole = (targetUserId: string, role: InvitableRole) =>
    runMutation(
      () => fetch(`/api/organizations/members/${encodeURIComponent(targetUserId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      }),
      'Failed to update member role',
      refreshSnapshot,
    )

  const handleRemoveMember = (targetUserId: string) =>
    runMutation(
      () => fetch(`/api/organizations/members/${encodeURIComponent(targetUserId)}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
      'Failed to remove member',
      refreshSnapshot,
    )

  const handleLeave = () =>
    runMutation(
      () => fetch(`/api/organizations/members/${encodeURIComponent(user.userId!)}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
      'Failed to leave organization',
      leaveOrganizationContext,
    )

  const handleTransferOwnership = (targetUserId: string) =>
    runMutation(
      () => fetch('/api/organizations/transfer-ownership', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId }),
      }),
      'Failed to transfer ownership',
      refreshSnapshot,
    )

  const handleDelete = () =>
    runMutation(
      () => fetch('/api/organizations', { method: 'DELETE', credentials: 'include' }),
      'Failed to delete organization',
      leaveOrganizationContext,
    )

  if (isLoading) {
    return <div className="p-6 max-w-3xl mx-auto text-sm text-bh-text-muted" data-testid="team-settings-loading">Loading team…</div>
  }
  if (error || !snapshot) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-sm text-bh-danger" data-testid="team-settings-error">
        Unable to load your team right now.
      </div>
    )
  }

  // Invite/cancel/resend still have no backing HTTP route (task 6's scope —
  // organization-lifecycle.ts implements and tests them, but no route calls
  // them yet), so those three controls remain inert for now.
  return (
    <TeamSettingsPage
      snapshot={snapshot}
      viewerUserId={user.userId!}
      busy={busy}
      error={mutationError}
      onChangeRole={handleChangeRole}
      onRemoveMember={handleRemoveMember}
      onLeave={handleLeave}
      onTransferOwnership={handleTransferOwnership}
      onDelete={handleDelete}
    />
  )
}
