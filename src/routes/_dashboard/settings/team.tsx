import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { organizationQueryKey } from '~/shared/lib/query-keys'
import { useActiveOrganizationId } from '~/shared/components/TenantQueryProvider'
import { TeamSettingsPage } from '~/modules/dashboard/components/TeamSettingsPage'
import type { TeamSnapshotDto } from '~/shared/lib/organizations/contracts'

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

function TeamSettingsRoute() {
  const { user } = Route.useRouteContext()
  const activeOrganizationId = useActiveOrganizationId()

  const { data: snapshot, isLoading, error } = useQuery({
    queryKey: organizationQueryKey(activeOrganizationId, 'team'),
    queryFn: fetchTeamSnapshot,
    enabled: activeOrganizationId !== null,
  })

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

  // Mutation wiring (invite/cancel/resend/role/remove/leave/transfer/delete)
  // lands with the API routes in the next increment — organization-lifecycle.ts
  // already implements and tests every one of those operations; only the thin
  // HTTP layer calling them is still missing, so those controls render per the
  // authorization matrix but are inert until then.
  return <TeamSettingsPage snapshot={snapshot} viewerUserId={user.userId!} />
}
