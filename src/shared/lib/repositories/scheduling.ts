import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import {
  availabilityOverrides,
  availabilityRules,
  candidateLinks,
  candidateSubmissions,
  schedulingInvitations,
} from '../db/schema'

/**
 * Tenant-scoped data access for availability, scheduling invitations, candidate submissions, and
 * candidate links (plan: calendar-scheduling-interview-intelligence, Phase 2 "Implement
 * scheduling repository").
 *
 * Two audiences, two shapes:
 *  - Organizer-facing functions take an owner id and re-filter on it, layered on top of the RLS
 *    policies in drizzle/0069 (defense-in-depth, same as `calendar.ts`).
 *  - Public-capability functions serve an unauthenticated candidate holding an emailed secret.
 *    They return `Public*Dto` shapes that deliberately omit `organizationId`, `ownerUserId`, and
 *    `capabilityHash`. spec.md §Public capability security: responses "never reveal organization
 *    IDs, internal conflicts, object keys, or candidate-account existence."
 */

export class SchedulingRepositoryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'SchedulingRepositoryError'
  }
}

// ── Availability ─────────────────────────────────────────────────────────────────────────────

const availabilityRuleColumns = {
  id: availabilityRules.id,
  organizationId: availabilityRules.organizationId,
  ownerUserId: availabilityRules.ownerUserId,
  timezone: availabilityRules.timezone,
  weekdays: availabilityRules.weekdays,
  localStart: availabilityRules.localStart,
  localEnd: availabilityRules.localEnd,
  effectiveFrom: availabilityRules.effectiveFrom,
  effectiveUntil: availabilityRules.effectiveUntil,
  slotMinutes: availabilityRules.slotMinutes,
  bufferBeforeMinutes: availabilityRules.bufferBeforeMinutes,
  bufferAfterMinutes: availabilityRules.bufferAfterMinutes,
  minNoticeMinutes: availabilityRules.minNoticeMinutes,
  horizonDays: availabilityRules.horizonDays,
  enabled: availabilityRules.enabled,
} as const

const availabilityOverrideColumns = {
  id: availabilityOverrides.id,
  organizationId: availabilityOverrides.organizationId,
  ownerUserId: availabilityOverrides.ownerUserId,
  localDate: availabilityOverrides.localDate,
  localStart: availabilityOverrides.localStart,
  localEnd: availabilityOverrides.localEnd,
  kind: availabilityOverrides.kind,
  timezone: availabilityOverrides.timezone,
} as const

export async function listAvailabilityRules(transaction: TenantTransaction, organizationId: string, ownerUserId: string) {
  return transaction
    .select(availabilityRuleColumns)
    .from(availabilityRules)
    .where(and(eq(availabilityRules.organizationId, organizationId), eq(availabilityRules.ownerUserId, ownerUserId)))
    .orderBy(asc(availabilityRules.localStart))
}

export async function listAvailabilityOverrides(transaction: TenantTransaction, organizationId: string, ownerUserId: string) {
  return transaction
    .select(availabilityOverrideColumns)
    .from(availabilityOverrides)
    .where(and(eq(availabilityOverrides.organizationId, organizationId), eq(availabilityOverrides.ownerUserId, ownerUserId)))
    .orderBy(asc(availabilityOverrides.localDate))
}

/**
 * `PUT /api/calendar/availability` replaces the owner's whole policy. Delete-then-insert inside
 * the caller's transaction keeps it atomic: a partial policy is never observable, and the delete
 * is owner-scoped so it can never clear someone else's rules.
 */
export async function replaceAvailabilityPolicy(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
  policy: {
    rules: Omit<typeof availabilityRules.$inferInsert, 'organizationId' | 'ownerUserId' | 'id'>[]
    overrides: Omit<typeof availabilityOverrides.$inferInsert, 'organizationId' | 'ownerUserId' | 'id'>[]
  },
) {
  await transaction
    .delete(availabilityRules)
    .where(and(eq(availabilityRules.organizationId, organizationId), eq(availabilityRules.ownerUserId, ownerUserId)))
  await transaction
    .delete(availabilityOverrides)
    .where(and(eq(availabilityOverrides.organizationId, organizationId), eq(availabilityOverrides.ownerUserId, ownerUserId)))

  const insertedRules = policy.rules.length === 0 ? [] : await transaction
    .insert(availabilityRules)
    .values(policy.rules.map((rule) => ({ ...rule, organizationId, ownerUserId })))
    .returning(availabilityRuleColumns)
  const insertedOverrides = policy.overrides.length === 0 ? [] : await transaction
    .insert(availabilityOverrides)
    .values(policy.overrides.map((override) => ({ ...override, organizationId, ownerUserId })))
    .returning(availabilityOverrideColumns)

  return { rules: insertedRules, overrides: insertedOverrides }
}

// ── Invitations (organizer view) ─────────────────────────────────────────────────────────────

const invitationColumns = {
  id: schedulingInvitations.id,
  organizationId: schedulingInvitations.organizationId,
  ownerUserId: schedulingInvitations.ownerUserId,
  organizationBuilderId: schedulingInvitations.organizationBuilderId,
  roleTitle: schedulingInvitations.roleTitle,
  roleContext: schedulingInvitations.roleContext,
  durationMinutes: schedulingInvitations.durationMinutes,
  timezone: schedulingInvitations.timezone,
  modality: schedulingInvitations.modality,
  meetingUrl: schedulingInvitations.meetingUrl,
  location: schedulingInvitations.location,
  status: schedulingInvitations.status,
  expiresAt: schedulingInvitations.expiresAt,
  openedAt: schedulingInvitations.openedAt,
  bookedAt: schedulingInvitations.bookedAt,
  revokedAt: schedulingInvitations.revokedAt,
  bookedEventId: schedulingInvitations.bookedEventId,
  rescheduleCount: schedulingInvitations.rescheduleCount,
  policyVersion: schedulingInvitations.policyVersion,
  version: schedulingInvitations.version,
} as const
// `capabilityHash` is absent by construction — it is never returned to any caller, organizer or
// candidate. It exists only to be matched against inside `findInvitationByCapabilityHash`.

export async function listInvitationsForOwner(transaction: TenantTransaction, organizationId: string, ownerUserId: string) {
  return transaction
    .select(invitationColumns)
    .from(schedulingInvitations)
    .where(and(eq(schedulingInvitations.organizationId, organizationId), eq(schedulingInvitations.ownerUserId, ownerUserId)))
    .orderBy(asc(schedulingInvitations.createdAt))
}

export async function findInvitationForOwner(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
  invitationId: string,
) {
  const [row] = await transaction
    .select(invitationColumns)
    .from(schedulingInvitations)
    .where(and(
      eq(schedulingInvitations.organizationId, organizationId),
      eq(schedulingInvitations.ownerUserId, ownerUserId),
      eq(schedulingInvitations.id, invitationId),
    ))
    .limit(1)
  return row ?? null
}

export async function insertInvitation(
  transaction: TenantTransaction,
  input: {
    organizationId: string
    ownerUserId: string
    organizationBuilderId?: string | null
    roleTitle: string
    roleContext: string
    durationMinutes: number
    timezone: string
    modality: string
    meetingUrl?: string | null
    location?: string | null
    capabilityHash: string
    policyVersion: string
    expiresAt?: Date | null
  },
) {
  const [row] = await transaction
    .insert(schedulingInvitations)
    .values({
      organizationId: input.organizationId,
      ownerUserId: input.ownerUserId,
      organizationBuilderId: input.organizationBuilderId ?? null,
      roleTitle: input.roleTitle,
      roleContext: input.roleContext,
      durationMinutes: input.durationMinutes,
      timezone: input.timezone,
      modality: input.modality,
      meetingUrl: input.meetingUrl ?? null,
      location: input.location ?? null,
      capabilityHash: input.capabilityHash,
      policyVersion: input.policyVersion,
      expiresAt: input.expiresAt ?? null,
    })
    .returning(invitationColumns)
  return row
}

/** Optimistic invitation state change; `null` means a concurrent writer moved it first (409). */
export async function updateInvitationStateWithVersion(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
  invitationId: string,
  expectedVersion: number,
  patch: Partial<{
    status: string
    expiresAt: Date | null
    openedAt: Date | null
    bookedAt: Date | null
    revokedAt: Date | null
    bookedEventId: string | null
    rescheduleCount: number
  }>,
) {
  const [row] = await transaction
    .update(schedulingInvitations)
    .set({ ...patch, version: sql`${schedulingInvitations.version} + 1`, updatedAt: new Date() })
    .where(and(
      eq(schedulingInvitations.organizationId, organizationId),
      eq(schedulingInvitations.ownerUserId, ownerUserId),
      eq(schedulingInvitations.id, invitationId),
      eq(schedulingInvitations.version, expectedVersion),
    ))
    .returning(invitationColumns)
  return row ?? null
}

// ── Invitations (public capability view) ─────────────────────────────────────────────────────

export interface PublicInvitationDto {
  id: string
  roleTitle: string
  roleContext: string
  durationMinutes: number
  timezone: string
  modality: string
  meetingUrl: string | null
  location: string | null
  status: string
  policyVersion: string
  version: number
  expiresAt: Date | null
}

/**
 * Resolves an emailed capability to its invitation by SHA-256 hash. Returns `null` — never a
 * distinguishable error — for unknown, revoked, expired, or already-booked invitations, so a
 * caller cannot probe which of those a given secret hit. The organizer's identity, the
 * organization, and the stored hash itself are all absent from the returned DTO.
 */
export async function findInvitationByCapabilityHash(
  transaction: TenantTransaction,
  capabilityHash: string,
  now: Date,
): Promise<PublicInvitationDto | null> {
  const [row] = await transaction
    .select({
      id: schedulingInvitations.id,
      roleTitle: schedulingInvitations.roleTitle,
      roleContext: schedulingInvitations.roleContext,
      durationMinutes: schedulingInvitations.durationMinutes,
      timezone: schedulingInvitations.timezone,
      modality: schedulingInvitations.modality,
      meetingUrl: schedulingInvitations.meetingUrl,
      location: schedulingInvitations.location,
      status: schedulingInvitations.status,
      policyVersion: schedulingInvitations.policyVersion,
      version: schedulingInvitations.version,
      expiresAt: schedulingInvitations.expiresAt,
      revokedAt: schedulingInvitations.revokedAt,
    })
    .from(schedulingInvitations)
    .where(eq(schedulingInvitations.capabilityHash, capabilityHash))
    .limit(1)

  if (!row) return null
  if (row.revokedAt !== null) return null
  if (row.expiresAt !== null && row.expiresAt <= now) return null
  if (row.status === 'expired' || row.status === 'revoked' || row.status === 'declined') return null

  const { revokedAt: _revokedAt, ...dto } = row
  return dto
}

/** Resolves the owning organization for a capability-authenticated request, so the route can enter tenant context server-side. */
export async function findInvitationTenantByCapabilityHash(transaction: TenantTransaction, capabilityHash: string) {
  const [row] = await transaction
    .select({ organizationId: schedulingInvitations.organizationId, ownerUserId: schedulingInvitations.ownerUserId, id: schedulingInvitations.id })
    .from(schedulingInvitations)
    .where(eq(schedulingInvitations.capabilityHash, capabilityHash))
    .limit(1)
  return row ?? null
}

/** Worker retention sweep: pending invitations whose expiry has passed. */
export async function listExpiredInvitations(transaction: TenantTransaction, organizationId: string, now: Date, limit: number) {
  return transaction
    .select({ id: schedulingInvitations.id, version: schedulingInvitations.version, status: schedulingInvitations.status })
    .from(schedulingInvitations)
    .where(and(
      eq(schedulingInvitations.organizationId, organizationId),
      lt(schedulingInvitations.expiresAt, now),
      isNull(schedulingInvitations.revokedAt),
      sql`${schedulingInvitations.status} in ('draft', 'sent', 'opened')`,
    ))
    .limit(limit)
}

export async function markInvitationExpired(transaction: TenantTransaction, organizationId: string, invitationId: string) {
  const [row] = await transaction
    .update(schedulingInvitations)
    .set({ status: 'expired', version: sql`${schedulingInvitations.version} + 1`, updatedAt: new Date() })
    .where(and(
      eq(schedulingInvitations.organizationId, organizationId),
      eq(schedulingInvitations.id, invitationId),
      sql`${schedulingInvitations.status} in ('draft', 'sent', 'opened')`,
    ))
    .returning({ id: schedulingInvitations.id })
  return row ?? null
}

// ── Candidate submissions ────────────────────────────────────────────────────────────────────

const submissionColumns = {
  id: candidateSubmissions.id,
  organizationId: candidateSubmissions.organizationId,
  invitationId: candidateSubmissions.invitationId,
  displayName: candidateSubmissions.displayName,
  emailNormalized: candidateSubmissions.emailNormalized,
  notes: candidateSubmissions.notes,
  submittedAt: candidateSubmissions.submittedAt,
  retentionExpiresAt: candidateSubmissions.retentionExpiresAt,
} as const

export async function findSubmissionByInvitation(transaction: TenantTransaction, organizationId: string, invitationId: string) {
  const [row] = await transaction
    .select(submissionColumns)
    .from(candidateSubmissions)
    .where(and(eq(candidateSubmissions.organizationId, organizationId), eq(candidateSubmissions.invitationId, invitationId)))
    .limit(1)
  return row ?? null
}

/** One submission per invitation — a candidate revisiting the portal updates their own row rather than creating a second. */
export async function upsertSubmission(
  transaction: TenantTransaction,
  input: {
    organizationId: string
    invitationId: string
    displayName: string
    emailNormalized: string
    notes?: string | null
    retentionExpiresAt: Date
  },
) {
  const [row] = await transaction
    .insert(candidateSubmissions)
    .values({
      organizationId: input.organizationId,
      invitationId: input.invitationId,
      displayName: input.displayName,
      emailNormalized: input.emailNormalized,
      notes: input.notes ?? null,
      submittedAt: new Date(),
      retentionExpiresAt: input.retentionExpiresAt,
    })
    .onConflictDoUpdate({
      target: candidateSubmissions.invitationId,
      set: {
        displayName: sql`excluded.display_name`,
        emailNormalized: sql`excluded.email_normalized`,
        notes: sql`excluded.notes`,
        submittedAt: sql`excluded.submitted_at`,
        updatedAt: new Date(),
      },
    })
    .returning(submissionColumns)
  return row
}

/** Worker retention sweep: submissions past their retention window, across the current org. */
export async function listExpiredSubmissions(transaction: TenantTransaction, organizationId: string, now: Date, limit: number) {
  return transaction
    .select({ id: candidateSubmissions.id, invitationId: candidateSubmissions.invitationId })
    .from(candidateSubmissions)
    .where(and(eq(candidateSubmissions.organizationId, organizationId), lt(candidateSubmissions.retentionExpiresAt, now)))
    .limit(limit)
}

export async function deleteSubmission(transaction: TenantTransaction, organizationId: string, submissionId: string) {
  const [row] = await transaction
    .delete(candidateSubmissions)
    .where(and(eq(candidateSubmissions.organizationId, organizationId), eq(candidateSubmissions.id, submissionId)))
    .returning({ id: candidateSubmissions.id })
  return row ?? null
}

// ── Candidate links ──────────────────────────────────────────────────────────────────────────

const linkColumns = {
  id: candidateLinks.id,
  organizationId: candidateLinks.organizationId,
  submissionId: candidateLinks.submissionId,
  url: candidateLinks.url,
  normalizedUrl: candidateLinks.normalizedUrl,
  sourceType: candidateLinks.sourceType,
  acquisitionMode: candidateLinks.acquisitionMode,
  authorizationNoticeVersion: candidateLinks.authorizationNoticeVersion,
  authorizationAttestedAt: candidateLinks.authorizationAttestedAt,
  policyDecision: candidateLinks.policyDecision,
  importState: candidateLinks.importState,
  label: candidateLinks.label,
} as const

export async function listLinksForSubmission(transaction: TenantTransaction, organizationId: string, submissionId: string) {
  return transaction
    .select(linkColumns)
    .from(candidateLinks)
    .where(and(eq(candidateLinks.organizationId, organizationId), eq(candidateLinks.submissionId, submissionId)))
    .orderBy(asc(candidateLinks.createdAt))
}

/** Idempotent on `(organization, submission, normalizedUrl)` — resubmitting the same link updates its label rather than duplicating it. */
export async function upsertLink(
  transaction: TenantTransaction,
  input: {
    organizationId: string
    submissionId: string
    url: string
    normalizedUrl: string
    sourceType: string
    acquisitionMode: string
    policyDecision: string
    label?: string | null
  },
) {
  const [row] = await transaction
    .insert(candidateLinks)
    .values({
      organizationId: input.organizationId,
      submissionId: input.submissionId,
      url: input.url,
      normalizedUrl: input.normalizedUrl,
      sourceType: input.sourceType,
      acquisitionMode: input.acquisitionMode,
      policyDecision: input.policyDecision,
      label: input.label ?? null,
    })
    .onConflictDoUpdate({
      target: [candidateLinks.organizationId, candidateLinks.submissionId, candidateLinks.normalizedUrl],
      set: { label: sql`excluded.label`, updatedAt: new Date() },
    })
    .returning(linkColumns)
  return row
}

/** Records the candidate's versioned ownership attestation — the only route to an `authorized_crawl` decision. */
export async function recordLinkAttestation(
  transaction: TenantTransaction,
  organizationId: string,
  submissionId: string,
  linkId: string,
  attestation: { noticeVersion: string; attestedAt: Date; policyDecision: string },
) {
  const [row] = await transaction
    .update(candidateLinks)
    .set({
      authorizationNoticeVersion: attestation.noticeVersion,
      authorizationAttestedAt: attestation.attestedAt,
      policyDecision: attestation.policyDecision,
      updatedAt: new Date(),
    })
    .where(and(
      eq(candidateLinks.organizationId, organizationId),
      eq(candidateLinks.submissionId, submissionId),
      eq(candidateLinks.id, linkId),
    ))
    .returning(linkColumns)
  return row ?? null
}

/** Scoped by submission as well as link id, so a capability for one invitation can never move another invitation's link. */
export async function updateLinkImportState(
  transaction: TenantTransaction,
  organizationId: string,
  submissionId: string,
  linkId: string,
  importState: string,
) {
  const [row] = await transaction
    .update(candidateLinks)
    .set({ importState, updatedAt: new Date() })
    .where(and(
      eq(candidateLinks.organizationId, organizationId),
      eq(candidateLinks.submissionId, submissionId),
      eq(candidateLinks.id, linkId),
    ))
    .returning(linkColumns)
  return row ?? null
}
