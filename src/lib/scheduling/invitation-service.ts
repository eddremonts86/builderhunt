/**
 * Interview invitation lifecycle (plan: calendar-scheduling-interview-intelligence, Phase 5
 * "Implement invitation service").
 *
 * Sits between the routes and `repositories/scheduling.ts` and owns the state machine. Three
 * things are worth knowing before changing anything here:
 *
 * 1. **Owner-only, with no admin branch.** `scheduling:manage` resolves to
 *    `creatorUserId === principal.userId` and nothing else (`authorization/permissions.ts`), which
 *    mirrors the RLS policies in `drizzle/0069_calendar_scheduling_rls_grants.sql`. An organization
 *    admin who is not the organizer gets the same answer as a stranger. That is deliberate: the
 *    invitation is the doorway to candidate personal data.
 * 2. **One live capability per invitation.** The secret is issued once, at create, and never
 *    re-issued. `send` does not mint a new one, so forwarding an old email still works and a
 *    resend cannot silently orphan a link the candidate already has. Revocation is the only way to
 *    kill a capability, and it is terminal.
 * 3. **The role context is snapshotted, not referenced.** `roleTitle`/`roleContext` are copied onto
 *    the invitation row at create time. If the tracked builder record later changes or is deleted,
 *    what the candidate was actually told stays intact — needed for the consent record to mean
 *    anything months later.
 *
 * Transitions, and the only legal moves out of each:
 *
 *   draft ──send──▶ sent ──open──▶ opened ──book──▶ booked
 *     │               │              │
 *     └──revoke──▶ revoked ◀─────────┘
 *                     ▲              │
 *   any ──expire──▶ expired         └──decline──▶ declined
 *
 * `booked` is not terminal for the event, but it is terminal for the invitation: rescheduling and
 * cancellation act on the event (`booking-service.ts`), never by moving the invitation backwards.
 */
import type { TenantTransaction } from '~/shared/lib/db/client'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { can } from '~/shared/lib/authorization/permissions'
import {
  findInvitationForOwner,
  insertInvitation,
  listInvitationsForOwner,
  updateInvitationStateWithVersion,
} from '~/shared/lib/repositories/scheduling'
import { issueCapability } from './capability'

/** Mirrors the `scheduling_invitations_status_check` constraint. */
export type InvitationStatus = 'draft' | 'sent' | 'opened' | 'booked' | 'declined' | 'expired' | 'revoked'

export type InvitationModality = 'in_person' | 'remote_call'

export type InvitationServiceError =
  | 'not_found'
  | 'forbidden'
  | 'invalid_transition'
  | 'version_conflict'
  | 'invalid_input'

export interface InvitationServiceFailure {
  ok: false
  error: InvitationServiceError
  /** Safe to show a user. Never contains anything about *why* a row was not found. */
  message: string
}

export type InvitationServiceResult<T> = { ok: true; value: T } | InvitationServiceFailure

const fail = (error: InvitationServiceError, message: string): InvitationServiceFailure =>
  ({ ok: false, error, message })

/**
 * Which statuses each action may be applied from. Encoding this as data rather than a chain of
 * `if`s is what lets the tests assert the whole matrix, and makes an illegal transition a lookup
 * failure instead of a forgotten branch.
 */
const ALLOWED_FROM: Record<'send' | 'open' | 'decline' | 'revoke' | 'expire', readonly InvitationStatus[]> = {
  send: ['draft', 'sent'],          // resend is idempotent-ish and allowed; see `send`
  open: ['sent', 'opened'],         // re-opening a link is normal, not an error
  decline: ['sent', 'opened'],
  revoke: ['draft', 'sent', 'opened'],
  expire: ['draft', 'sent', 'opened'],
}

/** Bounds that are the service's business, not the database's. */
const MIN_DURATION_MINUTES = 5
const MAX_DURATION_MINUTES = 480
const MAX_ROLE_TITLE = 200
const MAX_ROLE_CONTEXT = 4000

export interface CreateInvitationInput {
  roleTitle: string
  roleContext: string
  durationMinutes: number
  timezone: string
  modality: InvitationModality
  organizationBuilderId?: string | null
  meetingUrl?: string | null
  location?: string | null
  expiresAt?: Date | null
}

export interface CreatedInvitation {
  invitation: Awaited<ReturnType<typeof insertInvitation>>
  /**
   * The only time this value exists outside the candidate's URL. The caller must put it in a link
   * fragment and drop it — it is deliberately absent from every read path.
   */
  capabilitySecret: string
}

/**
 * Validates the parts the database cannot: a timezone the runtime actually knows, a modality that
 * carries the field it needs, and text bounded before it reaches storage.
 */
function validateCreateInput(input: CreateInvitationInput): InvitationServiceFailure | null {
  const title = input.roleTitle.trim()
  if (title.length === 0 || title.length > MAX_ROLE_TITLE) {
    return fail('invalid_input', `Role title must be between 1 and ${MAX_ROLE_TITLE} characters.`)
  }
  if (input.roleContext.length > MAX_ROLE_CONTEXT) {
    return fail('invalid_input', `Role context must be at most ${MAX_ROLE_CONTEXT} characters.`)
  }
  if (!Number.isInteger(input.durationMinutes)
    || input.durationMinutes < MIN_DURATION_MINUTES
    || input.durationMinutes > MAX_DURATION_MINUTES) {
    return fail('invalid_input', `Duration must be a whole number of minutes between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}.`)
  }
  if (!isKnownTimeZone(input.timezone)) {
    return fail('invalid_input', 'Timezone must be a valid IANA timezone identifier.')
  }
  // A remote invitation with no way to join it is a support ticket waiting to happen, and the
  // candidate is the one who discovers it. Catch it at create, not at booking.
  if (input.modality === 'remote_call' && !input.meetingUrl?.trim()) {
    return fail('invalid_input', 'A remote interview needs a meeting URL.')
  }
  if (input.modality === 'in_person' && !input.location?.trim()) {
    return fail('invalid_input', 'An in-person interview needs a location.')
  }
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    return fail('invalid_input', 'Expiry must be in the future.')
  }
  return null
}

/** `Intl` is the only source of truth available at runtime for whether a zone name is real. */
export function isKnownTimeZone(timezone: string): boolean {
  if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > 100) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export async function createInvitation(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: CreateInvitationInput,
  policyVersion: string,
): Promise<InvitationServiceResult<CreatedInvitation>> {
  // The creator is the owner by construction, so the permission check is about the capability
  // existing at all rather than about a specific row.
  if (!can(principal, 'scheduling:manage', { creatorUserId: principal.userId })) {
    return fail('forbidden', 'You cannot create interview invitations.')
  }
  const invalid = validateCreateInput(input)
  if (invalid) return invalid

  const { secret, hash } = issueCapability()
  const invitation = await insertInvitation(transaction, {
    organizationId: principal.organizationId,
    ownerUserId: principal.userId,
    organizationBuilderId: input.organizationBuilderId ?? null,
    roleTitle: input.roleTitle.trim(),
    roleContext: input.roleContext,
    durationMinutes: input.durationMinutes,
    timezone: input.timezone,
    modality: input.modality,
    meetingUrl: input.meetingUrl?.trim() || null,
    location: input.location?.trim() || null,
    capabilityHash: hash,
    policyVersion,
    expiresAt: input.expiresAt ?? null,
  })

  return { ok: true, value: { invitation, capabilitySecret: secret } }
}

export async function listInvitations(transaction: TenantTransaction, principal: TenantPrincipal) {
  if (!can(principal, 'scheduling:manage', { creatorUserId: principal.userId })) return []
  return listInvitationsForOwner(transaction, principal.organizationId, principal.userId)
}

/**
 * Reads one invitation. Returns `not_found` rather than `forbidden` when the row belongs to
 * someone else — the repository query is already scoped by `ownerUserId`, so a non-owner cannot
 * distinguish "exists but not yours" from "does not exist". That is the intended behaviour.
 */
export async function getInvitation(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  invitationId: string,
): Promise<InvitationServiceResult<NonNullable<Awaited<ReturnType<typeof findInvitationForOwner>>>>> {
  const invitation = await findInvitationForOwner(transaction, principal.organizationId, principal.userId, invitationId)
  if (!invitation) return fail('not_found', 'Invitation not found.')
  if (!can(principal, 'scheduling:manage', { creatorUserId: invitation.ownerUserId })) {
    return fail('not_found', 'Invitation not found.')
  }
  return { ok: true, value: invitation }
}

interface TransitionOptions {
  /** Set when the transition is a no-op that should still succeed (idempotent resend/open). */
  patch?: Parameters<typeof updateInvitationStateWithVersion>[5]
}

async function transition(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  invitationId: string,
  expectedVersion: number,
  action: keyof typeof ALLOWED_FROM,
  nextStatus: InvitationStatus,
  options: TransitionOptions = {},
) {
  const current = await getInvitation(transaction, principal, invitationId)
  if (!current.ok) return current

  const status = current.value.status as InvitationStatus
  if (!ALLOWED_FROM[action].includes(status)) {
    return fail('invalid_transition', `An invitation that is ${status} cannot be ${action === 'expire' ? 'expired' : `${action}d`}.`)
  }

  const row = await updateInvitationStateWithVersion(
    transaction,
    principal.organizationId,
    principal.userId,
    invitationId,
    expectedVersion,
    { status: nextStatus, ...options.patch },
  )
  // `null` means someone else moved this row between our read and our write. Surfacing it as a
  // conflict rather than retrying keeps the organizer's UI honest about what happened.
  if (!row) return fail('version_conflict', 'This invitation changed while you were working on it. Reload and try again.')
  return { ok: true as const, value: row }
}

/**
 * Marks an invitation as sent. Does **not** deliver the email — the caller writes an outbox
 * message inside the same transaction so a committed `sent` status and a queued email cannot
 * disagree. A send from `sent` is allowed (resend) and reuses the existing capability.
 */
export async function markInvitationSent(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  invitationId: string,
  expectedVersion: number,
  expiresAt?: Date | null,
) {
  return transition(transaction, principal, invitationId, expectedVersion, 'send', 'sent', {
    patch: expiresAt === undefined ? undefined : { expiresAt },
  })
}

export async function revokeInvitation(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  invitationId: string,
  expectedVersion: number,
  now: Date = new Date(),
) {
  return transition(transaction, principal, invitationId, expectedVersion, 'revoke', 'revoked', {
    patch: { revokedAt: now },
  })
}

export async function expireInvitation(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  invitationId: string,
  expectedVersion: number,
) {
  return transition(transaction, principal, invitationId, expectedVersion, 'expire', 'expired')
}

/**
 * Audit details for an invitation action. Deliberately excludes the capability secret, the
 * candidate's name and their email — an audit log is read by more people than the invitation is,
 * and `spec.md` requires redacted details.
 */
export function invitationAuditDetails(invitation: { id: string; status: string; version: number; modality: string }) {
  return {
    invitationId: invitation.id,
    status: invitation.status,
    version: invitation.version,
    modality: invitation.modality,
  }
}
