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
import { Button, Dialog, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'
import { TransferOwnershipPreview } from './TransferOwnershipPreview'

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
  /**
   * Candidates for the ownership picker, **not** the roster.
   *
   * A `<select>` cannot page, so this list is bounded server-side
   * (`listOwnershipTransferCandidates`) rather than filtered out of every member the page happened
   * to load. `transferCandidatesTruncated` says when the bound bit.
   */
  members: OrganizationMemberDto[]
  transferCandidatesTruncated?: boolean
  pendingDeletion: OrganizationDeletionStatusDto | null
  busy?: boolean
  error?: string | null
  /** Audit/reference id from the most recent transfer/request-deletion/cancel — no sensitive payload, just enough to reference the action if support needs to look it up. */
  referenceId?: string | null
  onLeave?: () => void | Promise<void>
  onTransferOwnership?: (userId: string) => void | Promise<void>
  onRequestDeletion?: () => void | Promise<void>
  onCancelDeletion?: () => void | Promise<void>
  /** Distinct from `onRequestDeletion` — forfeits any remaining paid period and deletes product data right now instead of after a 30-day grace period. Takes the typed confirmation name so the route can re-validate it server-side too. */
  onRequestImmediateDeletion?: (confirmOrganizationName: string) => void | Promise<void>
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
  transferCandidatesTruncated = false,
  pendingDeletion,
  busy = false,
  error = null,
  referenceId = null,
  onLeave,
  onTransferOwnership,
  onRequestDeletion,
  onCancelDeletion,
  onRequestImmediateDeletion,
}: OrganizationDangerZoneProps) {
  const [transferTarget, setTransferTarget] = React.useState('')
  const [transferPreviewOpen, setTransferPreviewOpen] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [confirmName, setConfirmName] = React.useState('')
  const [immediateMode, setImmediateMode] = React.useState(false)
  const [forfeitureAcknowledged, setForfeitureAcknowledged] = React.useState(false)

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
              <Button
                type="button"
                onClick={() => (onCancelDeletion ?? noop)()}
                disabled={busy}
                size="sm"
                data-testid="cancel-organization-deletion-btn"
              >
                Cancel deletion
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {canLeaveOrganization(viewerRole) && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-bh-text-muted">Leave this organization.</p>
            <Button
              type="button"
              onClick={() => (onLeave ?? noop)()}
              disabled={busy}
              variant="danger-outline"
              size="sm"
              className="shrink-0"
              data-testid="leave-organization-btn"
            >
              <LogOut className="w-4 h-4" aria-hidden="true" />
              Leave
            </Button>
          </div>
        )}

        {viewerRole === 'owner' && transferableMembers.length > 0 && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-bh-text-muted">Transfer ownership to another member.</p>
            <div className="flex items-center gap-2 shrink-0">
              {/* Fixed-width wrapper. Was required when `.input-field` was unlayered
                  CSS whose `width: 100%` beat a plain Tailwind width utility; that root
                  cause is fixed (it now sits in the `components` layer — see
                  globals.css), so `w-48` on the trigger itself would work too. Left
                  alone since it renders identically. */}
              <div className="w-48 shrink-0">
                <Select
                  value={transferTarget}
                  onValueChange={setTransferTarget}
                  disabled={busy}
                >
                  <SelectTrigger aria-label="Transfer ownership to" className="text-sm" data-testid="transfer-target-select">
                    <SelectValue placeholder="Select a member…" />
                  </SelectTrigger>
                  <SelectContent>
                    {transferableMembers.map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>{m.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                onClick={() => transferTarget && setTransferPreviewOpen(true)}
                disabled={busy || !transferTarget}
                variant="danger-outline"
                className="text-sm"
                data-testid="transfer-ownership-btn"
              >
                <ArrowRightLeft className="w-4 h-4" aria-hidden="true" />
                Transfer
              </Button>
            </div>
          </div>
        )}

        {viewerRole === 'owner' && transferCandidatesTruncated && (
          // Saying so beats a list that simply ends. The picker holds the first hundred
          // transferable members; an organization larger than that needs the transfer done by
          // support rather than silently offered a truncated menu.
          <p className="text-xs text-bh-warning" data-testid="transfer-candidates-truncated">
            Showing the first {members.length} members. If the person you need is not listed, contact support to
            complete the transfer.
          </p>
        )}

        {transferPreviewOpen && (
          <Dialog
            open={transferPreviewOpen}
            onClose={() => setTransferPreviewOpen(false)}
            title={`Transfer ownership to ${transferableMembers.find((m) => m.userId === transferTarget)?.name ?? 'this member'}`}
          >
            <TransferOwnershipPreview
              targetName={transferableMembers.find((m) => m.userId === transferTarget)?.name ?? 'This member'}
              confirmDisabled={busy}
              onConfirm={() => {
                setTransferPreviewOpen(false)
                if (transferTarget) (onTransferOwnership ?? noop)(transferTarget)
              }}
              onCancel={() => setTransferPreviewOpen(false)}
            />
          </Dialog>
        )}

        {canDelete && !pendingDeletion && (
          <div className="pt-4 border-t border-bh-danger/20">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-bh-text-muted max-w-[45ch]">
                Schedules this organization, its members' access, and all its data for permanent deletion after a{' '}
                <strong className="text-bh-text">30-day</strong> grace period. Cancel anytime before then.
              </p>
              {!confirmDelete && (
                <Button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  variant="danger-outline"
                  size="sm"
                  className="shrink-0"
                  data-testid="delete-organization-btn"
                >
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                  Delete organization
                </Button>
              )}
            </div>

            {confirmDelete && (
              <div className="mt-4" data-testid="delete-confirm">
                <label className="text-sm text-bh-text-muted block mb-2">
                  Type <strong className="text-bh-text">{organizationName}</strong> to confirm.
                </label>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    placeholder={organizationName}
                    aria-label="Confirm organization name"
                    className="flex-1 text-sm"
                    data-testid="confirm-organization-name-input"
                  />
                  <Button
                    type="button"
                    onClick={() => (onRequestDeletion ?? noop)()}
                    disabled={busy || !nameMatches}
                    variant="danger"
                    className="text-sm shrink-0"
                    data-testid="confirm-delete-organization-btn"
                  >
                    Schedule deletion
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      setConfirmDelete(false)
                      setConfirmName('')
                      setImmediateMode(false)
                      setForfeitureAcknowledged(false)
                    }}
                    disabled={busy}
                    variant="secondary"
                    className="text-sm shrink-0"
                    data-testid="cancel-delete-organization-btn"
                  >
                    <X className="w-3 h-3" aria-hidden="true" />
                    Cancel
                  </Button>
                </div>

                {onRequestImmediateDeletion && !immediateMode && (
                  <button
                    type="button"
                    onClick={() => setImmediateMode(true)}
                    disabled={busy}
                    className="text-xs text-bh-danger underline mt-2"
                    data-testid="show-immediate-delete-btn"
                  >
                    Delete immediately instead
                  </button>
                )}

                {onRequestImmediateDeletion && immediateMode && (
                  <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mt-3" data-testid="immediate-delete-warning">
                    <p className="text-sm text-bh-danger font-medium mb-2">
                      This forfeits any remaining paid subscription period — no partial-period credit — and deletes
                      all product data right now, not after 30 days. This cannot be undone.
                    </p>
                    <label className="flex items-start gap-2 text-sm text-bh-text-muted mb-3">
                      <input
                        type="checkbox"
                        checked={forfeitureAcknowledged}
                        onChange={(e) => setForfeitureAcknowledged(e.target.checked)}
                        className="mt-0.5"
                        data-testid="immediate-delete-forfeiture-checkbox"
                      />
                      I understand this forfeits the remaining paid period and cannot be undone.
                    </label>
                    <Button
                      type="button"
                      onClick={() => (onRequestImmediateDeletion ?? noop)(confirmName)}
                      disabled={busy || !nameMatches || !forfeitureAcknowledged}
                      variant="danger"
                      className="text-sm"
                      data-testid="confirm-immediate-delete-organization-btn"
                    >
                      Delete immediately
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
