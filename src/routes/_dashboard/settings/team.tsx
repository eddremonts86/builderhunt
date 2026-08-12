import * as React from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { organizationQueryKey } from '~/shared/lib/query-keys'
import { useActiveOrganizationId } from '~/shared/components/TenantQueryProvider'
import { TeamSettingsPage } from '~/modules/dashboard/components/TeamSettingsPage'
import type { InvitableRole, OrganizationSummaryDto, TeamSnapshotDto } from '~/shared/lib/organizations/contracts'
import type { InvitationIntent } from '~/shared/lib/organizations/invitation-personalization'
import type { InvitationRow, MemberRow } from '~/modules/dashboard/components/TeamSettingsPage'
import { emptyTableSearch, tableSearchToParams } from '~/shared/lib/table/query-url'
import type { PageResult, TableSearch } from '~/shared/lib/table/types'

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
  if (!res.ok) throw new Error('Could not load the team. Refresh the page to try again.')
  return res.json()
}

/**
 * The roster and the invitations are keyset pages now, fetched separately from the snapshot.
 *
 * They stay in component state rather than the URL, unlike the billing queues: this is one of
 * several sections on a settings page, and two tables writing `?sort=` and `?cursor=` into the
 * same address bar would collide on every parameter name they share.
 */
async function fetchTeamPage<Row>(path: string, search: TableSearch): Promise<PageResult<Row>> {
  const res = await fetch(`${path}?${tableSearchToParams(search).toString()}`, { credentials: 'include' })
  if (!res.ok) throw new Error('Could not load the team. Refresh the page to try again.')
  return res.json()
}

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return typeof body.error === 'string' ? body.error : fallback
}

/**
 * `authSessions.activeOrganizationId` has `onDelete: 'set null'` (schema.ts) — the FK sets the
 * EXISTING session's active org to null the moment the org/membership row is gone (leaving or
 * deleting an organization), and nothing auto-picks a replacement for an already-live session
 * (`pickDefaultActiveOrganizationId` only runs at sign-in/sign-up, in `session.create.before`).
 * Left alone, the next request lands on a dashboard with `activeOrganizationId: null` and every
 * org-scoped route (e.g. `/api/dashboard/stats`) 403s. Called before navigating away after leaving/
 * deleting the caller's own active organization — explicitly switches the session onto the user's
 * own personal workspace (every user has exactly one, `isPersonal: true`), mirroring
 * `OrganizationSwitcher`'s own switch flow. Best-effort: any failure here just leaves the user on a
 * dashboard with no active organization, same as if this function didn't exist — never throws.
 */
export async function switchToPersonalWorkspace(): Promise<void> {
  try {
    const res = await fetch('/api/organizations', { credentials: 'include' })
    if (!res.ok) return
    const organizations: OrganizationSummaryDto[] = await res.json()
    const personal = organizations.find((organization) => organization.isPersonal)
    if (!personal) return
    await fetch('/api/organizations/switch', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId: personal.id }),
    })
  } catch {
    // Best-effort — see doc comment above.
  }
}

const EMPTY_PAGE = { rows: [], nextCursor: null, total: 0, facets: {} }

function TeamSettingsRoute() {
  const { user } = Route.useRouteContext()
  const activeOrganizationId = useActiveOrganizationId()
  const queryClient = useQueryClient()
  const router = useRouter()
  const navigate = useNavigate()
  const [busy, setBusy] = React.useState(false)
  const [mutationError, setMutationError] = React.useState<string | null>(null)
  // Audit/reference id from the most recent danger-zone action (transfer,
  // request-deletion, cancel-deletion) — no sensitive payload, just enough
  // to point support at the right audit-log entry if something goes wrong.
  const [dangerZoneReferenceId, setDangerZoneReferenceId] = React.useState<string | null>(null)
  // `devLink` only ever comes back when no real email provider is configured
  // (dev mode) — the invitation exists but nothing was actually sent, so
  // TeamSettingsPage shows a manual-share fallback for exactly that invitation.
  const [devLinks, setDevLinks] = React.useState<Record<string, string>>({})
  // Not an error and not a success — a third outcome the sender has to be told about, because the
  // response for a deduplicated create is otherwise indistinguishable from a fresh send.
  const [inviteNotice, setInviteNotice] = React.useState<string | null>(null)

  const [membersSearch, setMembersSearch] = React.useState<TableSearch>(() => emptyTableSearch())
  const [invitationsSearch, setInvitationsSearch] = React.useState<TableSearch>(() => emptyTableSearch())

  const { data: snapshot, isLoading, error } = useQuery({
    queryKey: organizationQueryKey(activeOrganizationId, 'team'),
    queryFn: fetchTeamSnapshot,
    enabled: activeOrganizationId !== null,
  })

  const membersParams = tableSearchToParams(membersSearch).toString()
  const { data: membersPage, isLoading: membersLoading } = useQuery({
    queryKey: [...organizationQueryKey(activeOrganizationId, 'team'), 'members', membersParams],
    queryFn: () => fetchTeamPage<MemberRow>('/api/organizations/team/members', membersSearch),
    enabled: activeOrganizationId !== null,
  })

  const invitationsParams = tableSearchToParams(invitationsSearch).toString()
  const { data: invitationsPage, isLoading: invitationsLoading } = useQuery({
    queryKey: [...organizationQueryKey(activeOrganizationId, 'team'), 'invitations', invitationsParams],
    queryFn: () => fetchTeamPage<InvitationRow>('/api/organizations/team/invitations', invitationsSearch),
    enabled: activeOrganizationId !== null,
  })

  const teamQueryKey = organizationQueryKey(activeOrganizationId, 'team')

  // Role changes and member removal don't touch the caller's own active
  // organization — just refetch the snapshot to show the updated member/role.
  // Invalidating the snapshot key invalidates the two page queries with it: both are keyed by
  // that array plus a suffix, and TanStack Query matches keys by prefix. Inviting someone has to
  // refresh the invitations grid *and* the seat count, and they are three separate reads now.
  async function refreshSnapshot() {
    await queryClient.invalidateQueries({ queryKey: teamQueryKey })
  }

  // Leaving or deleting the organization ends the caller's own membership in
  // it — first move the session onto a workspace that's still valid
  // (see `switchToPersonalWorkspace`'s doc comment for why this is
  // necessary), then `router.invalidate()` re-reads the now-valid
  // `activeOrganizationId` from the session, which flows into
  // `TenantQueryProvider`'s effect and clears every cached query, and only
  // then do we navigate away from a settings page for an org that's gone.
  async function leaveOrganizationContext() {
    await switchToPersonalWorkspace()
    await router.invalidate()
    navigate({ to: '/dashboard' })
  }

  async function runMutation(
    action: () => Promise<Response>,
    fallbackErrorMessage: string,
    onSuccess: (body: unknown) => Promise<void> | void,
  ) {
    setBusy(true)
    setMutationError(null)
    try {
      const response = await action()
      if (!response.ok) {
        setMutationError(await parseErrorMessage(response, fallbackErrorMessage))
        return
      }
      const body = await response.json().catch(() => ({}))
      await onSuccess(body)
    } catch {
      setMutationError(fallbackErrorMessage)
    } finally {
      setBusy(false)
    }
  }

  function captureDevLink(body: unknown) {
    if (!body || typeof body !== 'object' || !('id' in body) || !('devLink' in body)) return
    const { id, devLink } = body as { id: string; devLink?: string }
    if (devLink) setDevLinks((prev) => ({ ...prev, [id]: devLink }))
  }

  function captureReferenceId(body: unknown, key: 'id' | 'requestId') {
    if (!body || typeof body !== 'object' || !(key in body)) return
    const value = (body as Record<string, unknown>)[key]
    setDangerZoneReferenceId(typeof value === 'string' ? value : null)
  }

  const handleChangeRole = (targetUserId: string, role: InvitableRole) =>
    runMutation(
      () => fetch(`/api/organizations/members/${encodeURIComponent(targetUserId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      }),
      'Could not update this member\'s role. Check the role you selected and try again.',
      refreshSnapshot,
    )

  const handleRemoveMember = (targetUserId: string) =>
    runMutation(
      () => fetch(`/api/organizations/members/${encodeURIComponent(targetUserId)}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
      'Could not remove this member. The organization owner can\'t be removed; transfer ownership first.',
      refreshSnapshot,
    )

  const handleLeave = () =>
    runMutation(
      () => fetch(`/api/organizations/members/${encodeURIComponent(user.userId!)}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
      'Could not leave the organization right now. Try again, or contact your admin.',
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
      'Could not transfer ownership. The target member must be an existing admin.',
      async (body) => {
        captureReferenceId(body, 'requestId')
        await refreshSnapshot()
      },
    )

  const handleRequestDeletion = () =>
    runMutation(
      () => fetch('/api/organizations', { method: 'DELETE', credentials: 'include' }),
      'Could not schedule the deletion. Verify the confirmation text matches the organization name exactly.',
      async (body) => {
        captureReferenceId(body, 'id')
        await refreshSnapshot()
      },
    )

  const handleCancelDeletion = () =>
    runMutation(
      () => fetch('/api/organizations/deletion', { method: 'DELETE', credentials: 'include' }),
      'Could not cancel the scheduled deletion. Try again from this page.',
      async (body) => {
        captureReferenceId(body, 'id')
        await refreshSnapshot()
      },
    )

  // Unlike scheduled deletion, this hard-deletes the organization right away — the caller's own
  // membership is gone by the time this resolves, so it ends the tenant context the same way
  // `leaveOrganizationContext` does for "leave organization", not a snapshot refresh.
  const handleRequestImmediateDeletion = (confirmOrganizationName: string) =>
    runMutation(
      () => fetch('/api/organizations/deletion/immediate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmOrganizationName }),
      }),
      'Could not delete the organization. Verify the confirmation text matches the organization name exactly.',
      leaveOrganizationContext,
    )

  const handleInvite = (
    email: string,
    role: InvitableRole,
    personalization?: { intent: InvitationIntent; roleTitle: string | null },
  ) =>
    runMutation(
      () => fetch('/api/organizations/invitations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // Spread conditionally: the create schema is `.strict()`, so sending `intent: undefined`
        // would be an unknown-key rejection rather than an omitted field.
        body: JSON.stringify({ email, role, ...(personalization ? personalization : {}) }),
      }),
      'Could not send the invitation. Check the email and the role, then try again.',
      async (body) => {
        captureDevLink(body)
        /**
         * A deduplicated create is reported as what it was.
         *
         * The winning row comes back either way, so without this the sender sees the same success as a
         * fresh send — and believes the context they just typed reached the recipient. It did not: the
         * email that went out describes the *first* invitation's intent, and the row was deliberately
         * not overwritten.
         */
        if (body && typeof body === 'object' && (body as { deduplicated?: boolean }).deduplicated) {
          setInviteNotice('An invitation to this address was already pending, so no new email was sent and your new context was not applied.')
        } else {
          setInviteNotice(null)
        }
        await refreshSnapshot()
      },
    )

  const handleCancelInvite = (invitationId: string) =>
    runMutation(
      () => fetch(`/api/organizations/invitations/${encodeURIComponent(invitationId)}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
      'Could not cancel this invitation. It may already be accepted or expired.',
      async () => {
        setDevLinks((prev) => {
          const next = { ...prev }
          delete next[invitationId]
          return next
        })
        await refreshSnapshot()
      },
    )

  const handleResendInvite = (invitationId: string) =>
    runMutation(
      () => fetch(`/api/organizations/invitations/${encodeURIComponent(invitationId)}`, {
        method: 'POST',
        credentials: 'include',
      }),
      'Failed to resend invitation',
      async (body) => {
        // Resend cancels the old invitation and mints a fresh one — drop any
        // stale link for the old id, the fresh id's link (if any) is captured below.
        setDevLinks((prev) => {
          const next = { ...prev }
          delete next[invitationId]
          return next
        })
        captureDevLink(body)
        await refreshSnapshot()
      },
    )

  if (isLoading) {
    return <div className="text-sm text-bh-text-muted" data-testid="team-settings-loading">Loading team…</div>
  }
  if (error || !snapshot) {
    return (
      <div className="card border-bh-danger/30 bg-bh-danger/5 p-4 text-sm text-bh-danger" data-testid="team-settings-error">
        Unable to load your team right now.
      </div>
    )
  }

  return (
    <TeamSettingsPage
      snapshot={snapshot}
      viewerUserId={user.userId!}
      membersPage={membersPage ?? EMPTY_PAGE}
      membersSearch={membersSearch}
      onMembersSearchChange={setMembersSearch}
      membersLoading={membersLoading}
      invitationsPage={invitationsPage ?? EMPTY_PAGE}
      invitationsSearch={invitationsSearch}
      onInvitationsSearchChange={setInvitationsSearch}
      invitationsLoading={invitationsLoading}
      busy={busy}
      error={mutationError}
      devLinkByInvitationId={devLinks}
      dangerZoneReferenceId={dangerZoneReferenceId}
      inviteNotice={inviteNotice}
      onInvite={handleInvite}
      onCancelInvite={handleCancelInvite}
      onResendInvite={handleResendInvite}
      onChangeRole={handleChangeRole}
      onRemoveMember={handleRemoveMember}
      onLeave={handleLeave}
      onTransferOwnership={handleTransferOwnership}
      onRequestDeletion={handleRequestDeletion}
      onCancelDeletion={handleCancelDeletion}
      onRequestImmediateDeletion={handleRequestImmediateDeletion}
    />
  )
}
