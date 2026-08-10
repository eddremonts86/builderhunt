// table-surface: organizationMembersCapability
import * as React from 'react'
import { Users, UserPlus, Mail, Crown, Shield, X, RefreshCw, Link2, Check } from 'lucide-react'
import {
  can,
  canChangeMemberRole,
  canRemoveMember,
  isOwnerRole,
  type InvitableRole,
  type InvitationSummaryDto,
  type OrganizationMemberDto,
  type OrganizationRole,
  type TeamSnapshotDto,
  type TenantPrincipal,
} from '~/shared/lib/organizations/contracts'
import { InvitationValuePreview } from '~/modules/organizations/components/InvitationValuePreview'
import {
  INVITATION_INTENT_LABELS,
  INVITATION_INTENTS,
  ROLE_TITLE_MAX_LENGTH,
  type InvitationIntent,
} from '~/shared/lib/organizations/invitation-personalization'
import { Button, Input, Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'
import { DataTable } from '~/shared/components/table'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery, TableSearch } from '~/shared/lib/table/types'
import { OrganizationDangerZone } from './OrganizationDangerZone'

/**
 * Pure presentation: every control's visibility comes from `can()` or one of
 * this module's per-target-role helpers — the exact functions the backend
 * itself gates on — so this component never invents its own authorization
 * rule. Mutation props are optional and default to no-ops so this renders
 * and tests standalone before task 5 wires real endpoints behind them.
 *
 * ## Two grids, not two lists
 *
 * The roster and the pending invitations arrived inside the snapshot, whole, and rendered as
 * `<ul>`s. They are `DataTable`s over their own keyset pages now — different record types with
 * different actions, so two grids rather than one merged people list. Every `data-testid` the old
 * markup carried is kept, `members-list` and `invitations-list` included: several e2e specs drive
 * this page by them, and a rename would turn a green suite red for a reason that has nothing to do
 * with teams.
 */
export interface TeamSettingsPageProps {
  snapshot: TeamSnapshotDto
  viewerUserId: string
  /** One keyset page of the roster, with the query that produced it. */
  membersPage: PageResult<MemberRow>
  membersSearch: TableSearch
  onMembersSearchChange: (next: TableSearch) => void
  onMembersLoadMore?: () => void
  membersLoading?: boolean
  /** One keyset page of pending invitations, with the query that produced it. */
  invitationsPage: PageResult<InvitationRow>
  invitationsSearch: TableSearch
  onInvitationsSearchChange: (next: TableSearch) => void
  onInvitationsLoadMore?: () => void
  invitationsLoading?: boolean
  busy?: boolean
  error?: string | null
  /** Set only for an invitation whose email was never actually sent (no email provider configured) — a manual-share fallback for exactly that invitation. */
  devLinkByInvitationId?: Record<string, string>
  /** Audit/reference id from the most recent danger-zone action (transfer/request-deletion/cancel) — passed through to OrganizationDangerZone. */
  dangerZoneReferenceId?: string | null
  /**
   * Plan 59 widened this: the sender's reason for inviting travels with the invitation.
   *
   * `personalization` is a third parameter rather than two more positional ones so the call site reads
   * as one thing — and so a caller that has not learned about intent still type-checks.
   */
  /** A deduplicated create, or any other truthful non-error outcome the sender must be told. */
  inviteNotice?: string | null
  onInvite?: (
    email: string,
    role: InvitableRole,
    personalization?: { intent: InvitationIntent; roleTitle: string | null },
  ) => void | Promise<void>
  onCancelInvite?: (invitationId: string) => void | Promise<void>
  onResendInvite?: (invitationId: string) => void | Promise<void>
  onChangeRole?: (userId: string, role: InvitableRole) => void | Promise<void>
  onRemoveMember?: (userId: string) => void | Promise<void>
  onLeave?: () => void | Promise<void>
  onTransferOwnership?: (userId: string) => void | Promise<void>
  onRequestDeletion?: () => void | Promise<void>
  onCancelDeletion?: () => void | Promise<void>
  onRequestImmediateDeletion?: (confirmOrganizationName: string) => void | Promise<void>
}

/** `DataTable` rows must be index-signature compatible; the DTOs are otherwise unchanged. */
export type MemberRow = OrganizationMemberDto & Record<string, unknown>
export type InvitationRow = InvitationSummaryDto & Record<string, unknown>

const ROLE_LABEL: Record<OrganizationRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

const MEMBER_FILTER_LABELS: Record<string, string> = { role: 'Role' }
const INVITATION_FILTER_LABELS: Record<string, string> = { role: 'Role' }

function noop() {}

export function TeamSettingsPage({
  snapshot,
  viewerUserId,
  membersPage,
  membersSearch,
  onMembersSearchChange,
  onMembersLoadMore,
  membersLoading = false,
  invitationsPage,
  invitationsSearch,
  onInvitationsSearchChange,
  onInvitationsLoadMore,
  invitationsLoading = false,
  busy = false,
  error = null,
  devLinkByInvitationId,
  dangerZoneReferenceId = null,
  inviteNotice = null,
  onInvite,
  onCancelInvite,
  onResendInvite,
  onChangeRole,
  onRemoveMember,
  onLeave,
  onTransferOwnership,
  onRequestDeletion,
  onCancelDeletion,
  onRequestImmediateDeletion,
}: TeamSettingsPageProps) {
  const [inviteEmail, setInviteEmail] = React.useState('')
  const [inviteRole, setInviteRole] = React.useState<InvitableRole>('member')
  // Defaulted to `other`, never to empty. `other` is a real intent with its own copy, so a sender who
  // does not want to answer still produces a complete card rather than a blank one.
  const [inviteIntent, setInviteIntent] = React.useState<InvitationIntent>('other')
  const [inviteRoleTitle, setInviteRoleTitle] = React.useState('')
  const [copiedInvitationId, setCopiedInvitationId] = React.useState<string | null>(null)
  const inviteEmailId = React.useId()
  const inviteRoleId = React.useId()
  const inviteIntentId = React.useId()
  const inviteRoleTitleId = React.useId()

  async function copyInviteLink(invitationId: string, link: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopiedInvitationId(invitationId)
      setTimeout(() => setCopiedInvitationId((current) => (current === invitationId ? null : current)), 2000)
    } catch {
      // Clipboard access can be denied by the browser — the link is still
      // visible in the button's title attribute as a fallback.
    }
  }

  const viewer: TenantPrincipal = {
    userId: viewerUserId,
    organizationId: snapshot.organization.id,
    role: snapshot.viewerRole,
    requestId: 'client',
  }

  const canInvite = can(viewer, 'organization:invite')
  const canManageMembers = can(viewer, 'organization:manage-members')
  const seatsFull = snapshot.seatUsage.used >= snapshot.seatUsage.limit

  const memberColumns = React.useMemo<ColumnDef<MemberRow>[]>(() => [
    {
      id: 'name',
      header: 'Member',
      priority: 'primary',
      value: (member) => member.name,
      cell: (member) => (
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {member.name}
            {member.userId === viewerUserId && <span className="text-bh-text-dim font-normal"> (you)</span>}
          </span>
          <span className="block truncate text-xs text-bh-text-muted">{member.email}</span>
        </span>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      value: (member) => member.role,
      cell: (member) => canChangeMemberRole(snapshot.viewerRole, member.role)
        ? (
          <div className="w-28 shrink-0">
            <Select
              value={member.role as InvitableRole}
              disabled={busy}
              onValueChange={(v) => (onChangeRole ?? noop)(member.userId, v as InvitableRole)}
            >
              <SelectTrigger
                aria-label={`Change role for ${member.name}`}
                className="text-xs"
                data-testid={`role-select-${member.userId}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="member">Member</SelectItem>
              </SelectContent>
            </Select>
          </div>
          )
        : (
          <span className="text-[10px] uppercase tracking-wider font-bold text-bh-text-dim flex items-center gap-1">
            {isOwnerRole(member.role) && <Crown className="w-3 h-3" aria-hidden="true" />}
            {ROLE_LABEL[member.role]}
          </span>
          ),
    },
    {
      id: 'joinedAt',
      header: 'Joined',
      sortable: true,
      align: 'end',
      priority: 'secondary',
      value: (member) => member.joinedAt,
      cell: (member) => new Date(member.joinedAt).toLocaleDateString(),
    },
    {
      id: 'remove',
      header: 'Remove',
      align: 'end',
      value: () => null,
      cell: (member) => canRemoveMember(snapshot.viewerRole, viewerUserId, member)
        ? (
          <Button
            type="button"
            onClick={() => (onRemoveMember ?? noop)(member.userId)}
            disabled={busy}
            variant="ghost"
            size="sm"
            className="text-bh-danger"
            aria-label={`Remove ${member.name}`}
            data-testid={`remove-member-${member.userId}`}
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </Button>
          )
        : null,
    },
  ], [busy, onChangeRole, onRemoveMember, snapshot.viewerRole, viewerUserId])

  const invitationColumns = React.useMemo<ColumnDef<InvitationRow>[]>(() => [
    {
      id: 'email',
      header: 'Invitee',
      priority: 'primary',
      value: (invitation) => invitation.email,
      cell: (invitation) => (
        <span className="min-w-0">
          <span className="block truncate text-sm">{invitation.email}</span>
          {devLinkByInvitationId?.[invitation.id] && (
            <span className="block text-xs text-bh-warning">
              Couldn't send the email — copy the link to share it manually.
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      value: (invitation) => invitation.role,
      cell: (invitation) => ROLE_LABEL[invitation.role],
    },
    {
      id: 'expiresAt',
      header: 'Expires',
      sortable: true,
      align: 'end',
      value: (invitation) => invitation.expiresAt,
      cell: (invitation) => new Date(invitation.expiresAt).toLocaleDateString(),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      value: () => null,
      cell: (invitation) => (
        <span className="flex items-center justify-end gap-1">
          {devLinkByInvitationId?.[invitation.id] && (
            <Button
              type="button"
              onClick={() => copyInviteLink(invitation.id, devLinkByInvitationId[invitation.id])}
              variant="ghost"
              size="sm"
              aria-label={`Copy invite link for ${invitation.email}`}
              title={devLinkByInvitationId[invitation.id]}
              data-testid={`copy-invitation-link-${invitation.id}`}
            >
              {copiedInvitationId === invitation.id
                ? <Check className="w-3.5 h-3.5 text-bh-success" aria-hidden="true" />
                : <Link2 className="w-3.5 h-3.5" aria-hidden="true" />}
            </Button>
          )}
          <Button
            type="button"
            onClick={() => (onResendInvite ?? noop)(invitation.id)}
            disabled={busy}
            variant="ghost"
            size="sm"
            aria-label={`Resend invitation to ${invitation.email}`}
            data-testid={`resend-invitation-${invitation.id}`}
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            onClick={() => (onCancelInvite ?? noop)(invitation.id)}
            disabled={busy}
            variant="ghost"
            size="sm"
            className="text-bh-danger"
            aria-label={`Cancel invitation to ${invitation.email}`}
            data-testid={`cancel-invitation-${invitation.id}`}
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </Button>
        </span>
      ),
    },
  ], [busy, copiedInvitationId, devLinkByInvitationId, onCancelInvite, onResendInvite])

  return (
    <div data-testid="team-settings-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Users className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          {snapshot.organization.name}
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          You are {ROLE_LABEL[snapshot.viewerRole]} · {snapshot.seatUsage.used}/{snapshot.seatUsage.limit} seats used
        </p>
      </header>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger" data-testid="team-error">
          {error}
        </div>
      )}

      {/* Members */}
      <section className="mb-6" data-testid="members-section">
        <h2 className="font-semibold flex items-center gap-2 mb-3">
          <Shield className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Members
        </h2>
        <div data-testid="members-list">
          <DataTable
            label="Team members"
            columns={memberColumns}
            page={membersPage}
            query={membersSearch.query}
            onQueryChange={(query: TableQuery) => onMembersSearchChange({
              ...membersSearch,
              query,
              page: { ...membersSearch.page, cursor: null },
            })}
            rowTestId={(member) => `member-row-${member.userId}`}
            rowId={(member) => member.userId}
            filterLabels={MEMBER_FILTER_LABELS}
            // Names and emails live on `auth_users`, which this capability cannot reach — see
            // `organization-members.ts`. A box that matched nothing would read as "no such member".
            searchable={false}
            status={membersLoading && membersPage.rows.length === 0 ? 'loading' : 'ready'}
            onLoadMore={onMembersLoadMore}
          />
        </div>
      </section>

      {/* Pending invitations */}
      {canManageMembers && (
        <section className="mb-6" data-testid="invitations-section">
          <h2 className="font-semibold flex items-center gap-2 mb-3">
            <Mail className="w-4 h-4 text-bh-accent" aria-hidden="true" />
            Pending invitations
          </h2>
          <div className="mb-4" data-testid="invitations-list">
            <DataTable
              label="Pending invitations"
              columns={invitationColumns}
              page={invitationsPage}
              query={invitationsSearch.query}
              onQueryChange={(query: TableQuery) => onInvitationsSearchChange({
                ...invitationsSearch,
                query,
                page: { ...invitationsSearch.page, cursor: null },
              })}
              rowTestId={(invitation) => `invitation-row-${invitation.id}`}
              rowId={(invitation) => invitation.id}
              filterLabels={INVITATION_FILTER_LABELS}
              status={invitationsLoading && invitationsPage.rows.length === 0 ? 'loading' : 'ready'}
              onLoadMore={onInvitationsLoadMore}
              emptyState={(
                <p className="px-4 py-8 text-center text-sm text-bh-text-muted" data-testid="no-invitations">
                  No pending invitations.
                </p>
              )}
            />
          </div>

          {canInvite && (
            <form
              className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-2 sm:items-end"
              onSubmit={(e) => {
                e.preventDefault()
                if (!inviteEmail.trim()) return
                // Trimmed to `null` here as well as on the server: an all-whitespace title must not
                // travel as a string the CHECK constraint would then reject with a 500.
                const roleTitle = inviteRoleTitle.trim() || null
                ;(onInvite ?? noop)(inviteEmail.trim(), inviteRole, { intent: inviteIntent, roleTitle })
                setInviteEmail('')
                setInviteRoleTitle('')
              }}
              data-testid="invite-form"
            >
              <div>
                <Label htmlFor={inviteEmailId}>Email</Label>
                <Input
                  id={inviteEmailId}
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  disabled={busy || seatsFull}
                  className="mt-1 text-sm"
                  data-testid="invite-email-input"
                />
              </div>
              <div>
                <Label htmlFor={inviteRoleId}>Role</Label>
                <Select
                  value={inviteRole}
                  onValueChange={(v) => setInviteRole(v as InvitableRole)}
                  disabled={busy || seatsFull}
                >
                  <SelectTrigger id={inviteRoleId} className="mt-1 w-full text-sm" data-testid="invite-role-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor={inviteIntentId}>Why are you inviting them?</Label>
                <Select
                  value={inviteIntent}
                  onValueChange={(v) => setInviteIntent(v as InvitationIntent)}
                  disabled={busy || seatsFull}
                >
                  <SelectTrigger id={inviteIntentId} className="mt-1 w-full text-sm" data-testid="invite-intent-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INVITATION_INTENTS.map((intent) => (
                      <SelectItem key={intent} value={intent}>{INVITATION_INTENT_LABELS[intent]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor={inviteRoleTitleId}>
                  Role title <span className="text-bh-text-dim font-normal">(optional)</span>
                </Label>
                <Input
                  id={inviteRoleTitleId}
                  type="text"
                  value={inviteRoleTitle}
                  onChange={(e) => setInviteRoleTitle(e.target.value.slice(0, ROLE_TITLE_MAX_LENGTH))}
                  placeholder="Staff Engineer"
                  disabled={busy || seatsFull}
                  className="mt-1 text-sm"
                  maxLength={ROLE_TITLE_MAX_LENGTH}
                  aria-describedby={`${inviteRoleTitleId}-count`}
                  data-testid="invite-role-title-input"
                />
                {/*
                  A visible count, not just a `maxLength`. `maxLength` silently stops accepting
                  characters, which reads as a broken keyboard; the number explains why typing stopped.
                */}
                <p id={`${inviteRoleTitleId}-count`} className="mt-1 text-xs text-bh-text-dim" data-testid="invite-role-title-count">
                  {inviteRoleTitle.length} / {ROLE_TITLE_MAX_LENGTH}
                </p>
              </div>

              {/*
                The card the recipient will see, from the same component they will see it from — so the
                sender is reviewing the real thing rather than a description of it.
              */}
              <div className="sm:col-span-2">
                <InvitationValuePreview
                  intent={inviteIntent}
                  roleTitle={inviteRoleTitle.trim() || null}
                  role={inviteRole}
                  audience="sender"
                />
              </div>

              {/*
                Rendered as a notice, not as an error and not as a success.
                A deduplicated create succeeded — the person is invited — but the context the sender
                just typed did not reach them, and the email that went out describes the first
                invitation's reason. `role="status"` rather than `role="alert"`: nothing went wrong.
              */}
              {inviteNotice && (
                <p
                  className="sm:col-span-2 rounded border border-bh-warning/30 bg-bh-warning/5 p-2 text-xs text-bh-warning"
                  role="status"
                  data-testid="invite-notice"
                >
                  {inviteNotice}
                </p>
              )}

              <div className="sm:col-span-2">
                <Button
                  type="submit"
                  disabled={busy || seatsFull}
                  className="text-sm"
                  data-testid="invite-submit-btn"
                >
                  <UserPlus className="w-4 h-4" aria-hidden="true" />
                  {seatsFull ? 'Seat limit reached' : 'Invite'}
                </Button>
              </div>
            </form>
          )}
        </section>
      )}

      <OrganizationDangerZone
        organizationName={snapshot.organization.name}
        isPersonal={snapshot.organization.isPersonal}
        viewerRole={snapshot.viewerRole}
        viewerUserId={viewerUserId}
        // The ownership picker is a `<select>` and cannot page, so it gets its own bounded read
        // rather than a slice of whichever roster page happens to be loaded — see
        // `listOwnershipTransferCandidates`.
        members={snapshot.transferCandidates}
        transferCandidatesTruncated={snapshot.transferCandidatesTruncated}
        pendingDeletion={snapshot.pendingDeletion}
        busy={busy}
        error={error}
        referenceId={dangerZoneReferenceId}
        onLeave={onLeave}
        onTransferOwnership={onTransferOwnership}
        onRequestDeletion={onRequestDeletion}
        onCancelDeletion={onCancelDeletion}
        onRequestImmediateDeletion={onRequestImmediateDeletion}
      />
    </div>
  )
}
