import * as React from 'react'
import { Users, UserPlus, Mail, Crown, Shield, X, LogOut, ArrowRightLeft, Trash2, RefreshCw, AlertTriangle } from 'lucide-react'
import {
  can,
  canChangeMemberRole,
  canLeaveOrganization,
  canRemoveMember,
  canTransferOwnershipTo,
  isOwnerRole,
  type InvitableRole,
  type OrganizationRole,
  type TeamSnapshotDto,
  type TenantPrincipal,
} from '~/shared/lib/organizations/contracts'

/**
 * Pure presentation: every control's visibility comes from `can()` or one of
 * this module's per-target-role helpers — the exact functions the backend
 * itself gates on — so this component never invents its own authorization
 * rule. Mutation props are optional and default to no-ops so this renders
 * and tests standalone before task 5 wires real endpoints behind them.
 */
export interface TeamSettingsPageProps {
  snapshot: TeamSnapshotDto
  viewerUserId: string
  busy?: boolean
  error?: string | null
  onInvite?: (email: string, role: InvitableRole) => void | Promise<void>
  onCancelInvite?: (invitationId: string) => void | Promise<void>
  onResendInvite?: (invitationId: string) => void | Promise<void>
  onChangeRole?: (userId: string, role: InvitableRole) => void | Promise<void>
  onRemoveMember?: (userId: string) => void | Promise<void>
  onLeave?: () => void | Promise<void>
  onTransferOwnership?: (userId: string) => void | Promise<void>
  onDelete?: () => void | Promise<void>
}

const ROLE_LABEL: Record<OrganizationRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

function noop() {}

export function TeamSettingsPage({
  snapshot,
  viewerUserId,
  busy = false,
  error = null,
  onInvite,
  onCancelInvite,
  onResendInvite,
  onChangeRole,
  onRemoveMember,
  onLeave,
  onTransferOwnership,
  onDelete,
}: TeamSettingsPageProps) {
  const [inviteEmail, setInviteEmail] = React.useState('')
  const [inviteRole, setInviteRole] = React.useState<InvitableRole>('member')
  const [transferTarget, setTransferTarget] = React.useState('')
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  const viewer: TenantPrincipal = {
    userId: viewerUserId,
    organizationId: snapshot.organization.id,
    role: snapshot.viewerRole,
    requestId: 'client',
  }

  const canInvite = can(viewer, 'organization:invite') && !snapshot.organization.isPersonal
  const canManageMembers = can(viewer, 'organization:manage-members')
  const canDelete = can(viewer, 'organization:delete')
  const seatsFull = snapshot.seatUsage.used >= snapshot.seatUsage.limit
  const transferableMembers = snapshot.members.filter((m) => canTransferOwnershipTo(snapshot.viewerRole, viewerUserId, m.userId))

  return (
    <div className="p-6 max-w-3xl mx-auto" data-testid="team-settings-page">
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
      <section className="card p-5 mb-6" data-testid="members-section">
        <h2 className="font-semibold flex items-center gap-2 mb-4">
          <Shield className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Members
        </h2>
        <ul className="space-y-2" data-testid="members-list">
          {snapshot.members.map((member) => {
            const isSelf = member.userId === viewerUserId
            const canChangeThisRole = canChangeMemberRole(snapshot.viewerRole, member.role)
            const canRemoveThis = canRemoveMember(snapshot.viewerRole, viewerUserId, member)
            return (
              <li
                key={member.userId}
                className="flex items-center gap-3 py-2 border-b border-bh-border/40 last:border-0"
                data-testid={`member-row-${member.userId}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {member.name}
                    {isSelf && <span className="text-bh-text-dim font-normal"> (you)</span>}
                  </p>
                  <p className="text-xs text-bh-text-muted truncate">{member.email}</p>
                </div>

                {canChangeThisRole ? (
                  <select
                    value={member.role as InvitableRole}
                    disabled={busy}
                    onChange={(e) => (onChangeRole ?? noop)(member.userId, e.target.value as InvitableRole)}
                    aria-label={`Change role for ${member.name}`}
                    className="text-xs rounded-lg border border-bh-border bg-bh-surface px-2 py-1"
                    data-testid={`role-select-${member.userId}`}
                  >
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                  </select>
                ) : (
                  <span className="text-[10px] uppercase tracking-wider font-bold text-bh-text-dim flex items-center gap-1">
                    {isOwnerRole(member.role) && <Crown className="w-3 h-3" aria-hidden="true" />}
                    {ROLE_LABEL[member.role]}
                  </span>
                )}

                {canRemoveThis && (
                  <button
                    type="button"
                    onClick={() => (onRemoveMember ?? noop)(member.userId)}
                    disabled={busy}
                    className="btn-ghost btn-sm text-bh-danger"
                    aria-label={`Remove ${member.name}`}
                    data-testid={`remove-member-${member.userId}`}
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {/* Pending invitations */}
      {canManageMembers && (
        <section className="card p-5 mb-6" data-testid="invitations-section">
          <h2 className="font-semibold flex items-center gap-2 mb-4">
            <Mail className="w-4 h-4 text-bh-accent" aria-hidden="true" />
            Pending invitations
          </h2>
          {snapshot.pendingInvitations.length === 0 ? (
            <p className="text-sm text-bh-text-muted" data-testid="no-invitations">No pending invitations.</p>
          ) : (
            <ul className="space-y-2 mb-4" data-testid="invitations-list">
              {snapshot.pendingInvitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex items-center gap-3 py-2 border-b border-bh-border/40 last:border-0"
                  data-testid={`invitation-row-${invitation.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{invitation.email}</p>
                    <p className="text-xs text-bh-text-dim">
                      {ROLE_LABEL[invitation.role]} · expires {new Date(invitation.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => (onResendInvite ?? noop)(invitation.id)}
                    disabled={busy}
                    className="btn-ghost btn-sm"
                    aria-label={`Resend invitation to ${invitation.email}`}
                    data-testid={`resend-invitation-${invitation.id}`}
                  >
                    <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => (onCancelInvite ?? noop)(invitation.id)}
                    disabled={busy}
                    className="btn-ghost btn-sm text-bh-danger"
                    aria-label={`Cancel invitation to ${invitation.email}`}
                    data-testid={`cancel-invitation-${invitation.id}`}
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {snapshot.organization.isPersonal && (
            <p className="text-sm text-bh-text-dim" data-testid="personal-org-invite-note">
              Personal workspaces are solo — create a team from the organization switcher to invite others.
            </p>
          )}

          {canInvite && (
            <form
              className="flex flex-col sm:flex-row gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (!inviteEmail.trim()) return
                ;(onInvite ?? noop)(inviteEmail.trim(), inviteRole)
                setInviteEmail('')
              }}
              data-testid="invite-form"
            >
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@example.com"
                disabled={busy || seatsFull}
                aria-label="Invite email"
                className="flex-1 text-sm rounded-lg border border-bh-border bg-bh-surface px-3 py-1.5"
                data-testid="invite-email-input"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as InvitableRole)}
                disabled={busy || seatsFull}
                aria-label="Invite role"
                className="text-sm rounded-lg border border-bh-border bg-bh-surface px-2 py-1.5"
                data-testid="invite-role-select"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button
                type="submit"
                disabled={busy || seatsFull}
                className="btn-primary btn-sm"
                data-testid="invite-submit-btn"
              >
                <UserPlus className="w-4 h-4" aria-hidden="true" />
                {seatsFull ? 'Seat limit reached' : 'Invite'}
              </button>
            </form>
          )}
        </section>
      )}

      {/* Danger zone */}
      <section className="card border-bh-danger/30 p-5" data-testid="team-danger-zone">
        <h2 className="font-semibold flex items-center gap-2 text-bh-danger mb-4">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" />
          Danger zone
        </h2>

        <div className="flex flex-col gap-4">
          {canLeaveOrganization(snapshot.viewerRole) && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-bh-text-muted">Leave this organization.</p>
              <button
                type="button"
                onClick={() => (onLeave ?? noop)()}
                disabled={busy}
                className="btn-danger-outline btn-sm shrink-0"
                data-testid="leave-organization-btn"
              >
                <LogOut className="w-4 h-4" aria-hidden="true" />
                Leave
              </button>
            </div>
          )}

          {snapshot.viewerRole === 'owner' && transferableMembers.length > 0 && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-bh-text-muted">Transfer ownership to another member.</p>
              <div className="flex items-center gap-2 shrink-0">
                <select
                  value={transferTarget}
                  onChange={(e) => setTransferTarget(e.target.value)}
                  disabled={busy}
                  aria-label="Transfer ownership to"
                  className="text-sm rounded-lg border border-bh-border bg-bh-surface px-2 py-1.5"
                  data-testid="transfer-target-select"
                >
                  <option value="">Select a member…</option>
                  {transferableMembers.map((m) => (
                    <option key={m.userId} value={m.userId}>{m.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => transferTarget && (onTransferOwnership ?? noop)(transferTarget)}
                  disabled={busy || !transferTarget}
                  className="btn-danger-outline btn-sm"
                  data-testid="transfer-ownership-btn"
                >
                  <ArrowRightLeft className="w-4 h-4" aria-hidden="true" />
                  Transfer
                </button>
              </div>
            </div>
          )}

          {canDelete && !snapshot.organization.isPersonal && (
            <div className="flex items-center justify-between gap-3 pt-4 border-t border-bh-danger/20">
              <p className="text-sm text-bh-text-muted max-w-[45ch]">
                Permanently delete this organization and all its members' access. This cannot be undone.
              </p>
              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="btn-danger-outline btn-sm shrink-0"
                  data-testid="delete-organization-btn"
                >
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                  Delete organization
                </button>
              ) : (
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => (onDelete ?? noop)()}
                    disabled={busy}
                    className="btn-danger btn-sm"
                    data-testid="confirm-delete-organization-btn"
                  >
                    Confirm delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    disabled={busy}
                    className="btn-secondary btn-sm"
                    data-testid="cancel-delete-organization-btn"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
