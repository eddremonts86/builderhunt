import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { ENTITY_DETAIL_LIMIT, USER_SCOPED_LIMIT } from '../db/read-bounds'
import {
  availabilityOverrides,
  availabilityPolicies,
  availabilityRules,
  calendarEvents,
  candidateLinks,
  candidateSubmissions,
  organizations,
  privacyConsents,
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
    // One owner's weekly availability policy, rendered whole by the editor on `/calendar`. Bounded
    // by what a person sets by hand: `PUT /api/calendar/availability` replaces the policy wholesale,
    // so this grows only when somebody adds another window.
    .limit(USER_SCOPED_LIMIT)
}

export async function listAvailabilityOverrides(transaction: TenantTransaction, organizationId: string, ownerUserId: string) {
  return transaction
    .select(availabilityOverrideColumns)
    .from(availabilityOverrides)
    .where(and(eq(availabilityOverrides.organizationId, organizationId), eq(availabilityOverrides.ownerUserId, ownerUserId)))
    .orderBy(asc(availabilityOverrides.localDate))
    // Same ceiling and the same reason as the rules above: one owner's hand-entered exceptions.
    .limit(USER_SCOPED_LIMIT)
}

/**
 * `PUT /api/calendar/availability` replaces the owner's whole policy. Delete-then-insert inside
 * the caller's transaction keeps it atomic: a partial policy is never observable, and the delete
 * is owner-scoped so it can never clear someone else's rules.
 */
const availabilityPolicyColumns = {
  id: availabilityPolicies.id,
  organizationId: availabilityPolicies.organizationId,
  ownerUserId: availabilityPolicies.ownerUserId,
  defaultReminderOffsets: availabilityPolicies.defaultReminderOffsets,
  defaultReminderChannels: availabilityPolicies.defaultReminderChannels,
  version: availabilityPolicies.version,
} as const

export async function findAvailabilityPolicy(transaction: TenantTransaction, organizationId: string, ownerUserId: string) {
  const [row] = await transaction
    .select(availabilityPolicyColumns)
    .from(availabilityPolicies)
    .where(and(eq(availabilityPolicies.organizationId, organizationId), eq(availabilityPolicies.ownerUserId, ownerUserId)))
    .limit(1)
  return row ?? null
}

/**
 * Bumps the owner's policy header only if the caller held the current version.
 *
 * Returns `null` on a version mismatch, which is what turns a lost update into a visible `409`
 * instead of one editor silently overwriting the other. The row is created on first write, so an
 * owner who has never set availability starts at version 1 without a separate bootstrap step.
 */
export async function upsertAvailabilityPolicyWithVersion(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
  expectedVersion: number,
  header: { defaultReminderOffsets: number[]; defaultReminderChannels: string[] },
) {
  const existing = await findAvailabilityPolicy(transaction, organizationId, ownerUserId)
  if (!existing) {
    // First write: only version 1 is a coherent claim, since an owner with no row reads as the
    // empty policy at version 1.
    if (expectedVersion !== 1) return null
    // The new row lands at 2, not 1. Creating at 1 would make "saved once" indistinguishable from
    // "never saved", so two clients racing on the very first write would both see their expected
    // version satisfied and the second would silently overwrite the first.
    const [created] = await transaction
      .insert(availabilityPolicies)
      .values({ organizationId, ownerUserId, ...header, version: 2 })
      .returning(availabilityPolicyColumns)
    return created ?? null
  }

  const [updated] = await transaction
    .update(availabilityPolicies)
    .set({ ...header, version: existing.version + 1, updatedAt: new Date() })
    .where(and(
      eq(availabilityPolicies.organizationId, organizationId),
      eq(availabilityPolicies.ownerUserId, ownerUserId),
      eq(availabilityPolicies.version, expectedVersion),
    ))
    .returning(availabilityPolicyColumns)
  return updated ?? null
}

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

/**
 * The organization's display name, for the one place a candidate sees it: the invitation email.
 *
 * Here rather than in a general organizations repository because this is the only scheduling caller
 * and the reason is specific — an email that carries a credential link and does not say who sent it
 * reads exactly like phishing, which is the last impression this particular email can afford. Runs
 * inside tenant context, so RLS scopes it without a WHERE on organization_id being load-bearing.
 */
export async function findOrganizationDisplayName(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<string | null> {
  const [row] = await transaction
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
  return row?.name ?? null
}

const invitationColumns = {
  id: schedulingInvitations.id,
  organizationId: schedulingInvitations.organizationId,
  ownerUserId: schedulingInvitations.ownerUserId,
  organizationBuilderId: schedulingInvitations.organizationBuilderId,
  candidateEmailNormalized: schedulingInvitations.candidateEmailNormalized,
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
    // The invitations one organizer has issued, listed whole on their scheduling surface. An
    // organizer past this ceiling needs a filter, which is a product question rather than a query
    // one — and the surface has no "load more" to page into.
    .limit(USER_SCOPED_LIMIT)
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
    candidateEmailNormalized?: string | null
    roleTitle: string
    roleContext: string
    durationMinutes: number
    timezone: string
    modality: string
    meetingUrl?: string | null
    location?: string | null
    /** NULL for a draft — the secret is minted at send, not here. */
    capabilityHash: string | null
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
      candidateEmailNormalized: input.candidateEmailNormalized ?? null,
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
    /** Set exactly once, by the send transition that mints it. */
    capabilityHash: string
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
  /**
   * The confirmed appointment, once booked — otherwise a candidate who closes the tab and reopens
   * the link days later (to check the time, or to reschedule) sees "Your interview is confirmed"
   * with no date at all: nothing else in this DTO carries it, and `CandidatePortal`'s own `booking`
   * state is only ever populated by a fresh confirm/reschedule response in that same session.
   */
  booking: { eventId: string; startsAt: Date; endsAt: Date; timezone: string } | null
}

/**
 * Resolves an emailed capability to its invitation by SHA-256 hash. Returns `null` — never a
 * distinguishable error — for unknown, revoked, or expired invitations, so a caller cannot probe
 * which of those a given secret hit. The organizer's identity, the organization, and the stored
 * hash itself are all absent from the returned DTO; the joined event contributes only its own
 * start/end/timezone, never `owner_user_id` or anything else that would identify the organizer.
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
      bookedEventId: schedulingInvitations.bookedEventId,
      bookingStartsAt: calendarEvents.startsAt,
      bookingEndsAt: calendarEvents.endsAt,
      bookingTimezone: calendarEvents.timezone,
    })
    .from(schedulingInvitations)
    .leftJoin(calendarEvents, and(
      eq(calendarEvents.organizationId, schedulingInvitations.organizationId),
      eq(calendarEvents.id, schedulingInvitations.bookedEventId),
    ))
    .where(eq(schedulingInvitations.capabilityHash, capabilityHash))
    .limit(1)

  if (!row) return null
  if (row.revokedAt !== null) return null
  if (row.expiresAt !== null && row.expiresAt <= now) return null
  if (row.status === 'expired' || row.status === 'revoked' || row.status === 'declined') return null

  const {
    revokedAt: _revokedAt,
    bookedEventId,
    bookingStartsAt,
    bookingEndsAt,
    bookingTimezone,
    ...dto
  } = row

  return {
    ...dto,
    booking: bookedEventId && bookingStartsAt && bookingEndsAt
      ? { eventId: bookedEventId, startsAt: bookingStartsAt, endsAt: bookingEndsAt, timezone: bookingTimezone ?? row.timezone }
      : null,
  }
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
    // The links attached to one submission — "the children of this row". A submission with more
    // than this many is not a detail view any more.
    .limit(ENTITY_DETAIL_LIMIT)
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

// ── Consent ledger (privacy_consents, drizzle/0074-0075) ────────────────────────────────────────

/**
 * `requestEvidenceHash` is deliberately absent. It is the integrity witness over the request that
 * produced the decision, kept for audit; nothing in the product reads it back, and shipping it in a
 * DTO would only widen what a leak exposes.
 */
const consentColumns = {
  id: privacyConsents.id,
  invitationId: privacyConsents.invitationId,
  sessionId: privacyConsents.sessionId,
  subjectEmailHash: privacyConsents.subjectEmailHash,
  purpose: privacyConsents.purpose,
  noticeVersion: privacyConsents.noticeVersion,
  decision: privacyConsents.decision,
  decidedAt: privacyConsents.decidedAt,
  withdrawnAt: privacyConsents.withdrawnAt,
  supersedesId: privacyConsents.supersedesId,
} as const

export interface ConsentDecisionInput {
  organizationId: string
  invitationId: string
  sessionId?: string | null
  subjectEmailHash: string
  purpose: string
  noticeVersion: string
  decision: string
  requestEvidenceHash: string
  supersedesId?: string | null
  decidedAt?: Date
}

/**
 * Appends a decision, or returns the existing row when the same act of consent is submitted twice.
 *
 * The retry case is not an error: a candidate double-tapping `Confirm` on a phone, or a mobile
 * browser replaying a request it thinks failed, performed one act of consent and must end up with
 * one row. `onConflictDoNothing` against the spec's idempotency key makes that outcome the same
 * whether the second request arrives before or after the first commits, which a
 * read-then-insert cannot promise.
 */
export async function appendConsentDecision(transaction: TenantTransaction, input: ConsentDecisionInput) {
  const [inserted] = await transaction
    .insert(privacyConsents)
    .values({
      organizationId: input.organizationId,
      invitationId: input.invitationId,
      sessionId: input.sessionId ?? null,
      subjectEmailHash: input.subjectEmailHash,
      purpose: input.purpose,
      noticeVersion: input.noticeVersion,
      decision: input.decision,
      requestEvidenceHash: input.requestEvidenceHash,
      supersedesId: input.supersedesId ?? null,
      ...(input.decidedAt ? { decidedAt: input.decidedAt } : {}),
    })
    .onConflictDoNothing({
      target: [
        privacyConsents.organizationId,
        privacyConsents.invitationId,
        privacyConsents.subjectEmailHash,
        privacyConsents.purpose,
        privacyConsents.noticeVersion,
        privacyConsents.decision,
      ],
    })
    .returning(consentColumns)
  if (inserted) return inserted

  const [existing] = await transaction
    .select(consentColumns)
    .from(privacyConsents)
    .where(and(
      eq(privacyConsents.organizationId, input.organizationId),
      eq(privacyConsents.invitationId, input.invitationId),
      eq(privacyConsents.subjectEmailHash, input.subjectEmailHash),
      eq(privacyConsents.purpose, input.purpose),
      eq(privacyConsents.noticeVersion, input.noticeVersion),
      eq(privacyConsents.decision, input.decision),
    ))
    .limit(1)
  return existing ?? null
}

export async function listConsentsForInvitation(
  transaction: TenantTransaction,
  organizationId: string,
  invitationId: string,
) {
  return transaction
    .select(consentColumns)
    .from(privacyConsents)
    .where(and(
      eq(privacyConsents.organizationId, organizationId),
      eq(privacyConsents.invitationId, invitationId),
    ))
    .orderBy(asc(privacyConsents.decidedAt), asc(privacyConsents.id))
    // The consent receipts of one invitation. Bounded for the same reason as the links above, and
    // the ordering is already total (`decidedAt`, then `id`), so the ceiling cannot land inside a tie.
    .limit(ENTITY_DETAIL_LIMIT)
}

/**
 * The receipts a booking request presents, fetched by id and re-scoped to the invitation.
 *
 * Scoping by `invitationId` here rather than trusting the ids is the point: a candidate who has
 * legitimately consented under one invitation must not be able to satisfy a second invitation's
 * consent requirement by replaying the first one's receipt ids.
 */
export async function findConsentsByIds(
  transaction: TenantTransaction,
  organizationId: string,
  invitationId: string,
  consentIds: readonly string[],
) {
  if (consentIds.length === 0) return []
  return transaction
    .select(consentColumns)
    .from(privacyConsents)
    .where(and(
      eq(privacyConsents.organizationId, organizationId),
      eq(privacyConsents.invitationId, invitationId),
      inArray(privacyConsents.id, [...consentIds]),
    ))
    // Model-bounded by the caller's own array: `id` is the primary key, so the result cannot exceed
    // the ids asked for. Stated rather than assumed, because "it is an inArray" is the reasoning a
    // future `inArray` over a non-unique column would inherit without earning.
    .limit(consentIds.length)
}

/**
 * Stamps a withdrawal. Returns null when there was no live grant to withdraw, so an already-
 * withdrawn purpose is not reported as a fresh withdrawal.
 *
 * `isNull(withdrawnAt)` in the predicate makes this idempotent under concurrency without a lock:
 * two simultaneous withdrawal requests both target the same row, one updates it, the other matches
 * nothing.
 */
export async function withdrawConsent(
  transaction: TenantTransaction,
  organizationId: string,
  invitationId: string,
  purpose: string,
  withdrawnAt: Date,
) {
  const [row] = await transaction
    .update(privacyConsents)
    .set({ withdrawnAt })
    .where(and(
      eq(privacyConsents.organizationId, organizationId),
      eq(privacyConsents.invitationId, invitationId),
      eq(privacyConsents.purpose, purpose),
      eq(privacyConsents.decision, 'accepted'),
      isNull(privacyConsents.withdrawnAt),
    ))
    .returning(consentColumns)
  return row ?? null
}
