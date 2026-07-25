import * as React from 'react'
import { Users, UserPlus, Mail, Crown, Shield, X, RefreshCw, Link2, Check } from 'lucide-react'
import {
  can,
  canChangeMemberRole,
  canRemoveMember,
  isOwnerRole,
  type InvitableRole,
  type OrganizationRole,
  type TeamSnapshotDto,
  type TenantPrincipal,
} from '~/shared/lib/organizations/contracts'
import { Button, Input, Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'
import { OrganizationDangerZone } from './OrganizationDangerZone'

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
  /** Set only for an invitation whose email was never actually sent (no email provider configured) — a manual-share fallback for exactly that invitation. */
  devLinkByInvitationId?: Record<string, string>
  /** Audit/reference id from the most recent danger-zone action (transfer/request-deletion/cancel) — passed through to OrganizationDangerZone. */
  dangerZoneReferenceId?: string | null
  onInvite?: (email: string, role: InvitableRole) => void | Promise<void>
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

const ROLE_LABEL: Record<OrganizationRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

function noop() {}

export function TeamSettingsPage({
  snapshot,
  viewerUserId,
  busy = false,
  error = null,
  devLinkByInvitationId,
  dangerZoneReferenceId = null,
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
  const [copiedInvitationId, setCopiedInvitationId] = React.useState<string | null>(null)
  const inviteEmailId = React.useId()
  const inviteRoleId = React.useId()

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
                  // Fixed-width wrapper, not a width class on SelectTrigger directly:
                  // .input-field (globals.css) is unlayered CSS, which always beats a
                  // plain (non-!important) Tailwind utility of equal specificity
                  // regardless of source order — a `w-28` on the trigger itself is
                  // silently ignored and it re-claims 100% of the flex row instead.
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
                ) : (
                  <span className="text-[10px] uppercase tracking-wider font-bold text-bh-text-dim flex items-center gap-1">
                    {isOwnerRole(member.role) && <Crown className="w-3 h-3" aria-hidden="true" />}
                    {ROLE_LABEL[member.role]}
                  </span>
                )}

                {canRemoveThis && (
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
                    {devLinkByInvitationId?.[invitation.id] && (
                      <p className="text-xs text-bh-warning mt-0.5">
                        Couldn't send the email — copy the link to share it manually.
                      </p>
                    )}
                  </div>
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
                      {copiedInvitationId === invitation.id ? (
                        <Check className="w-3.5 h-3.5 text-bh-success" aria-hidden="true" />
                      ) : (
                        <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
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
                </li>
              ))}
            </ul>
          )}

          {canInvite && (
            <form
              className="grid grid-cols-1 sm:grid-cols-[1fr_140px_auto] gap-2 sm:items-end"
              onSubmit={(e) => {
                e.preventDefault()
                if (!inviteEmail.trim()) return
                ;(onInvite ?? noop)(inviteEmail.trim(), inviteRole)
                setInviteEmail('')
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
              <Button
                type="submit"
                disabled={busy || seatsFull}
                className="text-sm"
                data-testid="invite-submit-btn"
              >
                <UserPlus className="w-4 h-4" aria-hidden="true" />
                {seatsFull ? 'Seat limit reached' : 'Invite'}
              </Button>
            </form>
          )}
        </section>
      )}

      <OrganizationDangerZone
        organizationName={snapshot.organization.name}
        isPersonal={snapshot.organization.isPersonal}
        viewerRole={snapshot.viewerRole}
        viewerUserId={viewerUserId}
        members={snapshot.members}
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
