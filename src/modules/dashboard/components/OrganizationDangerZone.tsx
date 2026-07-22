import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowRightLeft, Clock, LogOut, Trash2, X } from 'lucide-react'
import {
  canLeaveOrganization,
  canTransferOwnershipTo,
  isOwnerRole,
  STALE_SESSION_ERROR_MESSAGE,
  type OrganizationDeletionStatusDto,
  type OrganizationMemberDto,
  type OrganizationRole,
} from '~/shared/lib/organizations/contracts'

/**
 * Extracted from TeamSettingsPage so the recent-auth challenge, the
 * grace-period/cancel/status UI for organization deletion, and the reference
 * id display all live in one place instead of inline in the settings page.
 * Same rule as TeamSettingsPage: every control's visibility comes from the
 * shared per-target-role helpers, never a hand-rolled check here.
 */
export interface OrganizationDangerZoneProps {
  organizationName: string
  isPersonal: boolean
  viewerRole: OrganizationRole
  viewerUserId: string
  members: OrganizationMemberDto[]
  pendingDeletion: OrganizationDeletionStatusDto | null
  busy?: boolean
  error?: string | null
  /** Audit/reference id from the most recent transfer/request-deletion/cancel — no sensitive payload, just enough to reference the action if support needs to look it up. */
  referenceId?: string | null
  onLeave?: () => void | Promise<void>
  onTransferOwnership?: (userId: string) => void | Promise<void>
  onRequestDeletion?: () => void | Promise<void>
  onCancelDeletion?: () => void | Promise<void>
}

function noop() {}

function daysRemaining(gracePeriodEndsAt: string): number {
  return Math.max(0, Math.ceil((new Date(gracePeriodEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
}

export function OrganizationDangerZone({
  organizationName,
  isPersonal,
  viewerRole,
  viewerUserId,
  members,
  pendingDeletion,
  busy = false,
  error = null,
  referenceId = null,
  onLeave,
  onTransferOwnership,
  onRequestDeletion,
  onCancelDeletion,
}: OrganizationDangerZoneProps) {
  const [transferTarget, setTransferTarget] = React.useState('')
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [confirmName, setConfirmName] = React.useState('')

  const canDelete = isOwnerRole(viewerRole) && !isPersonal
  const transferableMembers = members.filter((m) => canTransferOwnershipTo(viewerRole, viewerUserId, m.userId))
  const isStaleSession = error === STALE_SESSION_ERROR_MESSAGE
  const nameMatches = confirmName.trim() === organizationName

  return (
    <section className="card border-bh-danger/30 p-5" data-testid="team-danger-zone">
      <h2 className="font-semibold flex items-center gap-2 text-bh-danger mb-4">
        <AlertTriangle className="w-4 h-4" aria-hidden="true" />
        Danger zone
      </h2>

      {/*
        A generic error (if any) is already shown by the parent settings page
        — this only adds a richer, action-specific banner for the one error
        worth special-casing: a stale session on a recent-auth-gated action
        (transfer/request-deletion) gets a direct "sign in again" CTA instead
        of a dead-end error string.
      */}
      {isStaleSession && (
        <div className="card border-bh-warning/30 bg-bh-warning/5 p-3 mb-4 text-sm text-bh-warning" data-testid="stale-session-banner">
          <p>Your session isn't recent enough for this action.</p>
          <Link
            to="/auth/sign-in"
            search={{ redirect: '/settings/team' }}
            className="inline-block mt-1 font-medium underline"
            data-testid="reauth-link"
          >
            Sign in again to continue
          </Link>
        </div>
      )}

      {referenceId && (
        <p className="text-xs text-bh-text-dim mb-4" data-testid="danger-zone-reference-id">Reference: {referenceId}</p>
      )}

      {pendingDeletion && (
        <div className="card border-bh-warning/30 bg-bh-warning/5 p-4 mb-4" data-testid="organization-deletion-warning">
          <div className="flex items-start gap-3">
            <Clock className="w-4 h-4 text-bh-warning shrink-0 mt-0.5" aria-hidden="true" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-bh-text mb-1">Organization scheduled for deletion</p>
              <p className="text-sm text-bh-text-muted mb-3">
                {daysRemaining(pendingDeletion.gracePeriodEndsAt)} day{daysRemaining(pendingDeletion.gracePeriodEndsAt) === 1 ? '' : 's'} remaining
                (ends {new Date(pendingDeletion.gracePeriodEndsAt).toLocaleString()}). All members will lose access after this date.
              </p>
              <button
                type="button"
                onClick={() => (onCancelDeletion ?? noop)()}
                disabled={busy}
                className="btn-primary btn-sm"
                data-testid="cancel-organization-deletion-btn"
              >
                Cancel deletion
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {canLeaveOrganization(viewerRole) && (
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

        {viewerRole === 'owner' && transferableMembers.length > 0 && (
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

        {canDelete && !pendingDeletion && (
          <div className="pt-4 border-t border-bh-danger/20">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-bh-text-muted max-w-[45ch]">
                Schedules this organization, its members' access, and all its data for permanent deletion after a{' '}
                <strong className="text-bh-text">30-day</strong> grace period. Cancel anytime before then.
              </p>
              {!confirmDelete && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="btn-danger-outline btn-sm shrink-0"
                  data-testid="delete-organization-btn"
                >
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                  Delete organization
                </button>
              )}
            </div>

            {confirmDelete && (
              <div className="mt-4" data-testid="delete-confirm">
                <label className="text-sm text-bh-text-muted block mb-2">
                  Type <strong className="text-bh-text">{organizationName}</strong> to confirm.
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    placeholder={organizationName}
                    aria-label="Confirm organization name"
                    className="flex-1 text-sm rounded-lg border border-bh-border bg-bh-surface px-3 py-1.5"
                    data-testid="confirm-organization-name-input"
                  />
                  <button
                    type="button"
                    onClick={() => (onRequestDeletion ?? noop)()}
                    disabled={busy || !nameMatches}
                    className="btn-danger btn-sm shrink-0"
                    data-testid="confirm-delete-organization-btn"
                  >
                    Schedule deletion
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmDelete(false)
                      setConfirmName('')
                    }}
                    disabled={busy}
                    className="btn-secondary btn-sm shrink-0"
                    data-testid="cancel-delete-organization-btn"
                  >
                    <X className="w-3 h-3" aria-hidden="true" />
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
