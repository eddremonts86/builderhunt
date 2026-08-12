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

/**
 * Members and seats.
 *
 * ## Renamed 2026-08-11, because three of the five original fields could not be produced
 *
 * The first version read `totalMembers`, `activeSeats` and `pendingInvitations`. None of them survived contact
 * with the database, and the reasons are worth keeping because they are not symmetric:
 *
 * - `activeSeats` was a second count of the same rows as `totalMembers` — a membership *is* an occupied seat, so
 *   the honest pair is "how many members" and "what the plan allows". That is `total` and `seatLimit`.
 * - `pendingInvitations` needs `organization_invitations`, which is granted to `builderhunt_auth` only because
 *   Better Auth owns invitations. A tenant dashboard connection is refused, so the field can only ever be a
 *   fabricated zero — and a workspace with three outstanding invitations reporting none is worse than a workspace
 *   that does not claim to know.
 *
 * `seatLimit` is nullable rather than 0-defaulted: an organization with no entitlement row has no cap, and 0 would
 * read as a cap of zero seats.
 */
export const orgAdminMembersSchema = z.object({
  total: boundedCountSchema,
  /** Owners, admins, members — counts only, no per-user identity. */
  byRole: z.object({
    owner: boundedCountSchema,
    admin: boundedCountSchema,
    member: boundedCountSchema,
  }),
  seatLimit: boundedCountSchema.nullable(),
})

export const orgAdminBillingSchema = z.object({
  /**
   * The tier as the entitlement row spells it, against the catalog's vocabulary — **including `pro_max`**.
   *
   * This was `z.enum(['free', 'pro', 'team'])`, which is the vocabulary migration `0004` created and `0029`
   * replaced. Beta mode grants `pro_max` to every workspace (plan 58), so once this schema is actually applied
   * the old enum would have thrown on the common case. It never threw before only because the envelope typed its
   * payload as `unknown` — see `orgAdminSectionEnvelope`.
   */
  tier: z.enum(['free', 'pro', 'pro_max', 'team']),
  /** The entitlement's own status — `active`, `past_due`, and so on. Bounded, not enumerated: the vocabulary is the billing module's. */
  status: z.string().min(1).max(32).regex(/^[a-z_]+$/),
  seatLimit: boundedCountSchema.nullable(),
  /** True at or past 80 % of the seat cap. A boolean, not a percentage — see the projection for why. */
  approachingSeatCap: z.boolean(),
  /** Days until renewal; null when there is no scheduled renewal. */
  renewalDays: z.number().int().nonnegative().nullable(),
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

/**
 * Deletion and export requests, counted per kind and per status.
 *
 * The first version was a single `pending` count plus an `allowedStatuses` list. Counting only the pending ones
 * throws away the distinction an admin acts on — a request stuck in `processing` for a week is the one that needs
 * attention, and it is not pending. `byKind` keeps both axes and still carries no identity: the projection groups
 * and counts, so there is no request id, subject or reason to leak.
 *
 * The status key is bounded by a character class rather than an enum because the two source tables have their own
 * status vocabularies and the projection already refuses anything outside `^[a-z_]{1,32}$`.
 */
export const orgAdminPrivacyRequestsSchema = z.object({
  /**
   * Two optional named keys rather than `z.record(z.enum([...]), …)`.
   *
   * Zod 4 treats an enum-keyed record as exhaustive — every member of the enum must be present — and the
   * projection emits only the kinds that have rows, so a workspace with deletions and no exports would fail to
   * parse. Spelling the two keys out and marking them optional says the same thing about the closed vocabulary
   * without requiring a kind nobody asked for.
   */
  byKind: z
    .object({
      deletion: z.record(z.string().min(1).max(32).regex(/^[a-z_]+$/), boundedCountSchema).optional(),
      export: z.record(z.string().min(1).max(32).regex(/^[a-z_]+$/), boundedCountSchema).optional(),
    })
    .strict(),
})

// ─────────────────────────────────────────────────────────────────
// Org-admin overview root
// ─────────────────────────────────────────────────────────────────

/**
 * One section's envelope, with its payload actually validated.
 *
 * ## Why this is a factory and not a constant
 *
 * It was a constant whose ready branch declared `data: z.unknown()`, and that one word is what let a four-field
 * rename reach a screenshot. The projection was rewritten on 2026-08-11 to emit `total`/`seatLimit`/`renewalDays`;
 * the component still read `totalMembers`/`activeSeats`/`renewalDaysRemaining`; and every layer between them said
 * yes. `parse()` accepted the payload because `unknown` accepts everything, and `tsc` accepted the component
 * because it reaches its fields through `data as z.infer<typeof orgAdminMembersSchema>` — a cast from `unknown`
 * asserts the shape rather than checking it. The dashboard shipped a card reading "total members · active seats"
 * with no numbers in it, on the plan whose entire subject is not showing a number you cannot stand behind.
 *
 * Passing each section's schema in closes it at the only place that can: the payload is now parsed against the
 * shape the client is about to read, so a rename fails the route's own `parse()` with the field name in the error
 * instead of rendering an `undefined` as empty space.
 *
 * The five non-ready branches carry no payload, which is the point of the envelope — `empty`, `unavailable` and
 * `forbidden` are answers, not missing data, and none of them has a shape to get wrong.
 */
export function orgAdminSectionEnvelope<Payload extends z.ZodObject<z.ZodRawShape>>(data: Payload) {
  return z.discriminatedUnion('state', [
    /**
     * `.strict()` on the payload, so an unexpected field is refused rather than quietly dropped.
     *
     * A plain `z.object()` *strips* unknown keys, which already keeps a forbidden marker off the wire — but it
     * keeps it off silently, so a projection that started emitting `memberEmail` would look correct forever. This
     * file made the same call for actions and wrote down why: "Refuse and force a schema bump." The same reasoning
     * applies with more force to a section payload, because that is where the eight forbidden markers would
     * actually arrive.
     *
     * The cost is that an additive projection change fails the route's `parse()` until the contract is updated,
     * which is the intended trade: the route turns it into one refused section, not a leak nobody sees.
     */
    z.object({ state: z.literal('ready'), data: data.strict(), generatedAt: isoTimestampSchema, actions: z.array(strictOrgAdminActionSchema).max(8) }),
    z.object({ state: z.literal('empty') }),
    z.object({ state: z.literal('loading') }),
    z.object({ state: z.literal('unavailable'), reason: z.enum(['dependency-missing', 'rate-limited', 'error']) }),
    z.object({ state: z.literal('forbidden') }),
  ])
}

/**
 * The envelope's *structure* with the payload left open — a **type**, not a schema.
 *
 * The shared view component switches on `state` and hands `data` to a per-section block without reading it, so it
 * needs one type that every section's envelope satisfies. What it must not have is a schema: a parser with an open
 * payload is exactly what let a renamed field through, and exporting one next to the typed factory would leave the
 * wrong choice one autocomplete away. Derived from the members envelope so it cannot drift from the real shape,
 * with `data` widened to `unknown`.
 */
type MembersEnvelope = z.infer<ReturnType<typeof orgAdminSectionEnvelope<typeof orgAdminMembersSchema>>>
export type OrgAdminSectionEnvelope =
  | Exclude<MembersEnvelope, { state: 'ready' }>
  | (Omit<Extract<MembersEnvelope, { state: 'ready' }>, 'data'> & { data: unknown })

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
  /**
   * Each section carries its own payload schema, so the route's `parse()` is the thing that catches a drift
   * between what the projection emits and what the component reads.
   *
   * The last three have no source in the product and always answer `unavailable: 'dependency-missing'`. Their
   * schemas stay wired anyway rather than being replaced with `z.never()`: the envelope only reaches the payload
   * on `ready`, so an unbuilt section costs nothing here, and the shape is the specification whoever builds it
   * will have to satisfy.
   */
  sections: z.object({
    members: orgAdminSectionEnvelope(orgAdminMembersSchema),
    billing: orgAdminSectionEnvelope(orgAdminBillingSchema),
    blockedWorkflows: orgAdminSectionEnvelope(orgAdminBlockedWorkflowsSchema),
    featureAdoption: orgAdminSectionEnvelope(orgAdminFeatureAdoptionSchema),
    securityPosture: orgAdminSectionEnvelope(orgAdminSecurityPostureSchema),
    privacyRequests: orgAdminSectionEnvelope(orgAdminPrivacyRequestsSchema),
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
