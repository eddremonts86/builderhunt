/**
 * Wave 5 admin-track contracts.
 *
 * Two parallel schemas:
 *
 *   - ORG_ADMIN_SCHEMA_VERSION / orgAdminOverviewSchema — owned by a tenant
 *     administrator (owner/admin role) inside a single organization. Answers
 *     member/seat state, billing/entitlements, blocked workflow counts,
 *     feature adoption, security posture, and eligible data/privacy actions.
 *     Never includes productivity rankings, member-level adoption scores,
 *     private workflow content, candidate emails, or session detail.
 *
 *   - PLATFORM_ADMIN_SCHEMA_VERSION / platformAdminOverviewSchema — owned
 *     by the platform staff. Aggregates incidents, operations, billing,
 *     abuse/trust, user anomalies, growth, and public content across
 *     tenants. Section states redacted at the row level.
 *
 * Both schemas are NOT assignable to one another (different root names,
 * different `schemaVersion` literals). A client that asks for the wrong
 * one will parse-fail before it misreads a payload.
 *
 * Action kinds are also closed. The platform-admin kind set is strictly
 * wider because operations can land on integration or billing surfaces
 * that the org-admin does not see; an unknown kind rejects the entire
 * section rather than rendering a dead control.
 */
import { z } from 'zod'

/** Independent version literals — bumping one does not bump the other. */
export const ORG_ADMIN_SCHEMA_VERSION = 1
export const PLATFORM_ADMIN_SCHEMA_VERSION = 2

/**
 * Org-admin and platform-admin share the range vocabulary (24h / 7d / 30d)
 * but each schema re-declares the enum. The schema-snapshot test in the
 * plan verifies the two root names and the two `schemaVersion` literals
 * are not interchangeable.
 */
export const adminRanges = ['24h', '7d', '30d'] as const
export type AdminRange = (typeof adminRanges)[number]

// ─────────────────────────────────────────────────────────────────
// Closed action-kind sets
// ─────────────────────────────────────────────────────────────────

/**
 * Org-admin action kinds. Every kind maps 1:1 to a real settings page;
 * adding a kind means adding the mapping in the same commit.
 */
export const orgAdminActionKinds = [
  'open-billing',
  'open-team',
  'open-roles',
  'open-privacy-requests',
  'open-blocked-workflows',
  'open-feature-adoption',
] as const
export type OrgAdminActionKind = (typeof orgAdminActionKinds)[number]

/**
 * Platform-admin action kinds. Wider set because platform ops can land
 * on integration or billing surfaces the org-admin does not see.
 */
export const platformAdminActionKinds = [
  'open-incident',
  'open-integration',
  'open-billing-platform',
  'open-abuse-trust',
  'open-user-anomaly',
  'open-growth',
  'open-public-content',
] as const
export type PlatformAdminActionKind = (typeof platformAdminActionKinds)[number]

// ─────────────────────────────────────────────────────────────────
// Reusable primitives
// ─────────────────────────────────────────────────────────────────

/** A bounded integer count. Always 0 or positive; reject negative input. */
export const boundedCountSchema = z.number().int().nonnegative()

/** ISO-8601 timestamp string. Caller is responsible for timezone correctness. */
export const isoTimestampSchema = z.string().datetime({ offset: true })

/** Action objects the queue may surface; the URL is server-controlled. */
export const orgAdminActionSchema = z.object({
  kind: z.enum(orgAdminActionKinds),
  label: z.string().min(1).max(80),
  url: z.string().regex(/^\/[a-z0-9/_-]+$/i, 'url must be a relative in-app path'),
})
export const platformAdminActionSchema = z.object({
  kind: z.enum(platformAdminActionKinds),
  label: z.string().min(1).max(80),
  url: z.string().regex(/^\/[a-z0-9/_-]+$/i, 'url must be a relative in-app path'),
})

/**
 * Reject any unknown action kind. `passthrough()` would let a server
 * introduce a new kind before the client renders it; the result would be
 * an unclickable or arbitrary control. Refuse and force a schema bump.
 */
export const strictOrgAdminActionSchema = orgAdminActionSchema.strict()
export const strictPlatformAdminActionSchema = platformAdminActionSchema.strict()

// ─────────────────────────────────────────────────────────────────
// Org-admin sections
// ─────────────────────────────────────────────────────────────────

export const orgAdminMembersSchema = z.object({
  totalMembers: boundedCountSchema,
  activeSeats: boundedCountSchema,
  pendingInvitations: boundedCountSchema,
  /** Owners, admins, members — counts only, no per-user identity. */
  byRole: z.object({
    owner: boundedCountSchema,
    admin: boundedCountSchema,
    member: boundedCountSchema,
  }),
})

export const orgAdminBillingSchema = z.object({
  tier: z.enum(['free', 'pro', 'team']),
  /** True when usage is approaching the cap; the action surfaces a billing link. */
  approachingCap: z.boolean(),
  /** Days until renewal; null when free / no scheduled renewal. */
  renewalDaysRemaining: z.number().int().nonnegative().nullable(),
})

export const orgAdminBlockedWorkflowsSchema = z.object({
  /** A count per blocked-workflow kind — never per-row identity. */
  blockedCounts: z.record(z.string().regex(/^[a-z0-9_-]+$/), boundedCountSchema),
  /** Total across kinds. */
  total: boundedCountSchema,
})

export const orgAdminFeatureAdoptionSchema = z.object({
  /** Adoption rate as a fraction in [0, 1]. */
  rates: z.record(z.string().regex(/^[a-z0-9_-]+$/), z.number().min(0).max(1)),
})

export const orgAdminSecurityPostureSchema = z.object({
  /** Number of admin users with email-not-verified status; 0 is healthy. */
  unverifiedAdmins: boundedCountSchema,
  /** Days since last org-admin sign-in, used to flag stale admin seats. */
  /**
   * Days since last org-admin sign-in, keyed by admin userId (UUID).
   * Capped at 50 by the projection; the contract trusts the cap and
   * does not re-enforce it (z.record has no max). Add a length cap at
   * the projection boundary.
   */
  /**
   * Keyed by user id, which is `text` for the same reason — see `organizationId` below.
   *
   * The projection no longer produces this map at all: `auth_users` has no sign-in timestamp, so there is nothing to
   * compute days-since from. The field stays in the contract because the security suite uses this schema to pin that
   * the platform and tenant DTOs are not interchangeable, and narrowing it further would be a change to a shape
   * nothing writes.
   */
  staleAdminDays: z.record(z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/), z.number().int().nonnegative()),
})

export const orgAdminPrivacyRequestsSchema = z.object({
  pending: boundedCountSchema,
  /** Allowed statuses are the public-facing ones; "completed_at" is omitted. */
  allowedStatuses: z.array(z.enum(['pending', 'processing'])).max(2),
})

// ─────────────────────────────────────────────────────────────────
// Org-admin overview root
// ─────────────────────────────────────────────────────────────────

export const orgAdminSectionEnvelopeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), data: z.unknown(), generatedAt: isoTimestampSchema, actions: z.array(strictOrgAdminActionSchema).max(8) }),
  z.object({ state: z.literal('empty') }),
  z.object({ state: z.literal('loading') }),
  z.object({ state: z.literal('unavailable'), reason: z.enum(['dependency-missing', 'rate-limited', 'error']) }),
  z.object({ state: z.literal('forbidden') }),
])

export const orgAdminOverviewSchema = z.object({
  schemaVersion: z.literal(ORG_ADMIN_SCHEMA_VERSION),
  /**
   * A server-internal organization id, not a UUID — and the difference cost a 500.
   *
   * This was `z.string().uuid()` when the contract was written, which nothing caught because nothing ever produced
   * a payload: the projection could not run and no route called it. With both wired, the first real request parsed
   * a Better Auth id — `organizations.id` is `text`, generated by the auth library, and not in UUID shape — and the
   * schema threw, which the route turned into a 500.
   *
   * Bounded rather than freed: a length ceiling and a character class, so the field still cannot carry a URL or a
   * sentence. What it cannot do is assert a format this product does not use.
   */
  organizationId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  range: z.enum(adminRanges),
  generatedAt: isoTimestampSchema,
  sections: z.object({
    members: orgAdminSectionEnvelopeSchema,
    billing: orgAdminSectionEnvelopeSchema,
    blockedWorkflows: orgAdminSectionEnvelopeSchema,
    featureAdoption: orgAdminSectionEnvelopeSchema,
    securityPosture: orgAdminSectionEnvelopeSchema,
    privacyRequests: orgAdminSectionEnvelopeSchema,
  }),
})

// ─────────────────────────────────────────────────────────────────
// Platform-admin sections
// ─────────────────────────────────────────────────────────────────

export const platformAdminIncidentsSchema = z.object({
  open: boundedCountSchema,
  /** Per-service counts; service names are server-controlled identifiers. */
  byService: z.record(z.string().regex(/^[a-z0-9_-]+$/), boundedCountSchema),
})

export const platformAdminOperationsSchema = z.object({
  /** Worker queue depth, integration lag, etc — each as a count or latency. */
  metrics: z.array(z.object({
    key: z.string().regex(/^[a-z0-9_.-]+$/),
    value: z.number().finite(),
    unit: z.enum(['count', 'ms', 'percent', 'rps']),
  })).max(20),
})

export const platformAdminBillingSchema = z.object({
  /** Tenant-level revenue roll-up; never includes customer identifiers. */
  totalActiveTenants: boundedCountSchema,
  mrrCents: boundedCountSchema,
})

export const platformAdminAbuseTrustSchema = z.object({
  openReports: boundedCountSchema,
  /** Aggregate only; no per-user data. */
  autoActioned24h: boundedCountSchema,
})

export const platformAdminUserAnomaliesSchema = z.object({
  suspiciousSignins: boundedCountSchema,
  /** Always 0 unless a real signal exists. */
  impossibleTravel: boundedCountSchema,
})

export const platformAdminGrowthSchema = z.object({
  signups: boundedCountSchema,
  activations: boundedCountSchema,
})

export const platformAdminPublicContentSchema = z.object({
  /** Content moderation queue size, public builder profile claims, etc. */
  reviewQueue: boundedCountSchema,
  claimedPublicProfiles: boundedCountSchema,
})

// ─────────────────────────────────────────────────────────────────
// Platform-admin overview root
// ─────────────────────────────────────────────────────────────────

export const platformAdminSectionEnvelopeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), data: z.unknown(), generatedAt: isoTimestampSchema, actions: z.array(strictPlatformAdminActionSchema).max(8) }),
  z.object({ state: z.literal('empty') }),
  z.object({ state: z.literal('loading') }),
  z.object({ state: z.literal('unavailable'), reason: z.enum(['dependency-missing', 'rate-limited', 'error']) }),
  z.object({ state: z.literal('forbidden') }),
])

/**
 * The platform-admin overview shape, kept as a contract while its projection is gone (plan 57, 2026-08-11).
 *
 * `readPlatformAdminOverview` was deleted: it read eight `platform_*` tables that appear in no migration and threw
 * `relation "platform_incidents" does not exist` on its first call, and nothing imported it. `PlatformAdminSection`
 * went with it — no page mounted it.
 *
 * This schema stays because it is not dead: `tests/unit/security/admin-contracts.test.ts` uses it to pin the two
 * properties that matter regardless of who renders them — the platform and tenant DTOs are not interchangeable, and
 * the eight forbidden member-data markers cannot enter either one. Deleting it would delete those assertions.
 *
 * ## Where the content went
 *
 * The maintainer narrowed this to "índice = metrics" on 2026-08-06, and the seven sections shipped as Admin Metrics
 * sections instead — each reading a registry that exists rather than a table that does not:
 *
 * | this schema's section | where it lives now |
 * | --------------------- | ------------------ |
 * | `incidents`           | `content` section — unresolved by severity, with the age of the oldest |
 * | `operations`          | `operations` section, `workers` variant — the schedule registry and job runs |
 * | `billing`             | `trust` section, `billing` variant — webhook events by status |
 * | `abuseTrust`          | `trust` section, `abuse` and `removals` variants |
 * | `growth`              | `overview` and `activation` sections |
 * | `publicContent`       | `content` section |
 * | `userAnomalies`       | **nowhere** — nothing in this product detects a suspicious sign-in |
 *
 * That last row is the reason the Billing/Abuse/Trust/User-Anomaly task stays partial rather than closed. A section
 * reporting "0 anomalies" would say the detector found nothing when there is no detector.
 */
export const platformAdminOverviewSchema = z.object({
  schemaVersion: z.literal(PLATFORM_ADMIN_SCHEMA_VERSION),
  range: z.enum(adminRanges),
  generatedAt: isoTimestampSchema,
  sections: z.object({
    incidents: platformAdminSectionEnvelopeSchema,
    operations: platformAdminSectionEnvelopeSchema,
    billing: platformAdminSectionEnvelopeSchema,
    abuseTrust: platformAdminSectionEnvelopeSchema,
    userAnomalies: platformAdminSectionEnvelopeSchema,
    growth: platformAdminSectionEnvelopeSchema,
    publicContent: platformAdminSectionEnvelopeSchema,
  }),
})

// ─────────────────────────────────────────────────────────────────
// Sentinel field — a server that ever returns this in any of the admin
// schemas is leaking member-level data and the request must be rejected.
// Defined as a literal string so a TypeScript-level constant table can
// pull a value from a build artifact if needed.
// ─────────────────────────────────────────────────────────────────

/** The 8 forbidden strings: any payload that contains one of these (member
 *  email, candidate email, productivity term, ranking term, session detail)
 *  is rejected by the section-level redactor before the contract parses.
 *  Listed here so a server build can grep for accidental inclusion. */
export const forbiddenMemberDataMarkers = [
  'memberEmail',
  'candidateEmail',
  'productivityScore',
  'rank',
  'sessionDetail',
  'individualAdoption',
  'searchContent',
  'noteContent',
] as const

export type ForbiddenMemberDataMarker = (typeof forbiddenMemberDataMarkers)[number]
