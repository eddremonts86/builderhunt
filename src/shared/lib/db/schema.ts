import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, boolean, integer, jsonb, numeric, primaryKey, unique, uniqueIndex, uuid, index, check, foreignKey, vector, time, date } from 'drizzle-orm/pg-core'
import { EMBEDDING_DIM } from '~/shared/lib/ai/embedding-dim'
// The embedding projection and the Solutions catalog share one entity vocabulary on purpose —
// see `builderEmbeddings.entityKind`. Type-only import, and `contracts.ts` imports nothing but
// zod, so this cannot cycle back into the schema.
import type { ComponentKind, ComponentKind as SemanticEntityKind } from '~/shared/lib/solutions/contracts'
import type { EmbeddingPayload } from '~/lib/semantic/embedding-doc'
import type { EnrichmentEvidencePayload } from '~/lib/enrichment/types'
import type { ExtractedCriteria, QueryVariant, SprintCursor, SprintProfileSnapshot } from '~/shared/lib/sprints-shared'
import type { WorkSampleAnalysis } from '~/shared/lib/work-sample'

// ---------------------------------------------------------------------------
// Authentication Tables (Better Auth)
// ---------------------------------------------------------------------------

export const authUsers = pgTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    activeOrganizationId: text('active_organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('auth_sessions_active_organization_idx').on(table.activeOrganizationId),
  ],
)

export const authAccounts = pgTable('auth_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  idToken: text('id_token'),
  password: text('password'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  providerAccountUnique: unique('auth_accounts_provider_account_unique').on(t.accountId, t.providerId),
}))

export const authVerifications = pgTable('auth_verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const organizationMembers = pgTable(
  'organization_members',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('organization_members_org_user_unique').on(table.organizationId, table.userId),
    uniqueIndex('organization_members_one_owner_unique').on(table.organizationId).where(sql`${table.role} = 'owner'`),
    index('organization_members_user_idx').on(table.userId),
    check('organization_members_role_check', sql`${table.role} in ('owner', 'admin', 'member')`),
  ],
)

export const organizationInvitations = pgTable(
  'organization_invitations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    inviterId: text('inviter_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('organization_invitations_email_idx').on(table.organizationId, table.email),
    index('organization_invitations_expires_idx').on(table.expiresAt),
    check('organization_invitations_role_check', sql`${table.role} is null or ${table.role} in ('admin', 'member')`),
    check('organization_invitations_status_check', sql`${table.status} in ('pending', 'accepted', 'rejected', 'canceled')`),
  ],
)

export const organizationDeletionRequests = pgTable(
  'organization_deletion_requests',
  {
    id: text('id').primaryKey(),
    // No FK to organizations: this row is the compliance/audit record that a
    // grace-period delete happened, so it must outlive the organizations row
    // the worker eventually deletes (same rationale as deletionRequests
    // above, for the account-level equivalent).
    organizationId: text('organization_id').notNull().unique(),
    requestedByUserId: text('requested_by_user_id').notNull(),
    status: text('status').notNull().default('pending'), // 'pending' | 'completed' | 'cancelled'
    gracePeriodEndsAt: timestamp('grace_period_ends_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('organization_deletion_requests_grace_period_idx').on(table.gracePeriodEndsAt),
    check('organization_deletion_requests_status_check', sql`${table.status} in ('pending', 'completed', 'cancelled')`),
  ],
)

// ---------------------------------------------------------------------------
// App Tables
// ---------------------------------------------------------------------------

export const builderIdentities = pgTable(
  'builder_identities',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    bio: text('bio'),
    profileUrl: text('profile_url').notNull(),
    followersCount: integer('followers_count').notNull().default(0),
    language: text('language'),
    country: text('country'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('builder_identities_source_source_id_unique').on(table.source, table.sourceId),
    index('builder_identities_source_username_idx').on(table.source, table.username),
  ],
)

// ---------------------------------------------------------------------------
// Canonical humans (plan 43 — solutions-intelligence Phase 3)
//
// `builder_identities` is a *source account*: one row per (source, source_id). One person can hold
// several. `canonical_humans` is the stable person those accounts may belong to, and
// `human_source_links` is the evidence that says so.
//
// The separation exists because the naive alternative — treating one username as one person — is
// what plan 43 Phase 2 had to rip out of `dedup.ts`, where it merged unrelated people who happened
// to share a handle and made the losers unfindable. Linking accounts is a claim about a real human,
// so it carries evidence, a confidence, a review state, and a validity window that lets it be
// withdrawn. Nothing here may be inferred from name similarity alone: see `linkMethod`.
//
// Global-public, like `builder_identities` — no organization column, read through `publicDb`,
// mutated only by workers and reviewed admin actions. Tenant-private judgements about a person stay
// where they already are, in `organization_builders.private_metadata`.
// ---------------------------------------------------------------------------

export const canonicalHumans = pgTable(
  'canonical_humans',
  {
    id: text('id').primaryKey(),
    /**
     * Canonical projections, chosen from linked source accounts rather than authored here. Every
     * one of them is nullable because a canonical human with no agreed display name is a normal
     * state, not an error — two sources disagreeing is exactly the case `fieldProvenance` records
     * instead of silently picking a winner.
     */
    displayName: text('display_name'),
    headline: text('headline'),
    country: text('country'),
    language: text('language'),
    /**
     * Which source link each projected field came from, so a merge can be undone field by field:
     * `{ displayName: { sourceLinkId, observedAt } }`. Without this, unmerging restores the rows but
     * leaves the projection carrying values whose origin has been detached — the plan's
     * "reversible field provenance".
     */
    fieldProvenance: jsonb('field_provenance').$type<Record<string, { sourceLinkId: string; observedAt: string }>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
)

/** How a source account came to be attached to a canonical human. Ordered by strength. */
export const HUMAN_LINK_METHODS = [
  /** The person proved control of the account through the claim flow. Strongest; auto-approves. */
  'verified_claim',
  /** Account A publicly links to account B (a profile field pointing at the other). Auto-approves. */
  'explicit_cross_link',
  /** A deterministic signal (same verified email hash, same signed key) a human then reviewed. */
  'reviewed_deterministic',
  /**
   * A similarity signal — matching names, overlapping topics, embedding proximity. NEVER auto-links:
   * it may only ever create a `pending_review` row for a human to decide, which is the mechanism
   * that stops "two people called alice" from becoming one person again.
   */
  'probabilistic_candidate',
] as const

export const HUMAN_LINK_REVIEW_STATES = ['auto_approved', 'pending_review', 'approved', 'rejected'] as const

export const humanSourceLinks = pgTable(
  'human_source_links',
  {
    id: text('id').primaryKey(),
    canonicalHumanId: text('canonical_human_id').notNull().references(() => canonicalHumans.id, { onDelete: 'cascade' }),
    builderIdentityId: text('builder_identity_id').notNull().references(() => builderIdentities.id, { onDelete: 'cascade' }),
    linkMethod: text('link_method').notNull(),
    reviewState: text('review_state').notNull().default('pending_review'),
    /** Basis points (0-10000), so confidence is an integer and cannot drift through float rounding. */
    confidenceBps: integer('confidence_bps').notNull().default(0),
    /** What actually justified the link. Never a raw scraped payload — an identifier and a kind. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().default({}).notNull(),
    reviewedByUserId: text('reviewed_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /**
     * Validity window rather than a delete. Withdrawing a link sets `validUntil`, which keeps the
     * history that a link once existed — required for the plan's reversible merges, and for
     * answering "why was this person shown as that account last week".
     */
    validFrom: timestamp('valid_from', { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One link row per (human, account): a re-link reuses and revalidates the row rather than
    // stacking duplicates that later disagree about review state.
    unique('human_source_links_human_identity_unique').on(table.canonicalHumanId, table.builderIdentityId),
    /**
     * The core integrity rule: a source account may belong to at most ONE canonical human at a time.
     * Partial, so withdrawn (`valid_until IS NOT NULL`) and rejected links do not block a later
     * correct link — which is what makes an unmerge followed by a re-merge possible at all.
     */
    uniqueIndex('human_source_links_active_identity_unique')
      .on(table.builderIdentityId)
      .where(sql`valid_until is null and review_state in ('auto_approved', 'approved')`),
    index('human_source_links_review_queue_idx').on(table.reviewState, table.createdAt),
    index('human_source_links_human_idx').on(table.canonicalHumanId),
    check('human_source_links_method_check', sql`${table.linkMethod} in ('verified_claim', 'explicit_cross_link', 'reviewed_deterministic', 'probabilistic_candidate')`),
    check('human_source_links_review_state_check', sql`${table.reviewState} in ('auto_approved', 'pending_review', 'approved', 'rejected')`),
    check('human_source_links_confidence_range_check', sql`${table.confidenceBps} between 0 and 10000`),
    /**
     * A probabilistic signal can never be auto-approved. This is the constraint that enforces the
     * spec's "Semantic similarity can propose ... but cannot activate it" at the storage layer, so a
     * future code path cannot bypass it by writing the row directly.
     */
    check(
      'human_source_links_probabilistic_needs_review_check',
      sql`${table.linkMethod} <> 'probabilistic_candidate' or ${table.reviewState} <> 'auto_approved'`,
    ),
    check('human_source_links_validity_order_check', sql`${table.validUntil} is null or ${table.validUntil} > ${table.validFrom}`),
  ],
)

/**
 * Merge lineage. Every merge of one canonical human into another records enough to put it back:
 * which links moved, and what the surviving projection looked like before.
 *
 * Append-only audit, never updated in place except to stamp `revertedAt` — a merge history that can
 * be edited cannot be trusted to reverse anything.
 */
export const humanMergeEvents = pgTable(
  'human_merge_events',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** The human that survived and absorbed the other. */
    targetCanonicalHumanId: text('target_canonical_human_id').notNull().references(() => canonicalHumans.id, { onDelete: 'cascade' }),
    /** The human that was absorbed. Deliberately NOT a foreign key: the row it names may be deleted
     * after the merge, and the lineage has to survive that to remain reversible. */
    sourceCanonicalHumanId: text('source_canonical_human_id').notNull(),
    performedByUserId: text('performed_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    /** Pre-merge snapshot: the absorbed human's own fields and the ids of the links that moved. */
    restoreSnapshot: jsonb('restore_snapshot').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    revertedByUserId: text('reverted_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('human_merge_events_target_idx').on(table.targetCanonicalHumanId, table.createdAt),
    index('human_merge_events_source_idx').on(table.sourceCanonicalHumanId),
  ],
)

export const builderSourceSnapshots = pgTable(
  'builder_source_snapshots',
  {
    // uuidv7 — append-heavy, see postgres-18-upgrade Phase 5 task 1.
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    builderIdentityId: text('builder_identity_id').notNull().references(() => builderIdentities.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('builder_source_snapshots_identity_hash_unique').on(table.builderIdentityId, table.contentHash),
    index('builder_source_snapshots_identity_observed_idx').on(table.builderIdentityId, table.observedAt),
  ],
)

// ---------------------------------------------------------------------------
// Plan 28 — Shared Builder Lists
//
// A list is a tenant-owned collection of builders the organization
// is tracking. Visibility follows the same private|organization
// enum as `organization_builders`: a private list is the creator's
// alone, an organization list is every member's. Items are pinned
// to a canonical `builderIdentityId` (the same identity
// `organization_builders` references) so a list can never name a
// builder the organization has not tracked.
// ---------------------------------------------------------------------------

export const builderLists = pgTable(
  'builder_lists',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    createdByUserId: text('created_by_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    visibility: text('visibility').notNull().default('private'),
    // Optimistic concurrency for the rename/description/visibility PATCH (plans/UI/tasks.md Wave 2
    // "Shortlist metadata and visibility editing") — same shape as every other versioned resource
    // in this schema (e.g. interview_sessions, calendar_availability_policies).
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('builder_lists_org_visibility_creator_idx').on(table.organizationId, table.visibility, table.createdByUserId),
    check('builder_lists_visibility_check', sql`${table.visibility} in ('private', 'organization')`),
  ],
)

export const builderListItems = pgTable(
  'builder_list_items',
  {
    id: text('id').primaryKey(),
    // The composite FK (organization_id, builder_identity_id) requires
    // a row in organization_builders first. A list item pointing at a
    // builder the org has not tracked fails at the database, not at
    // the application — a future feature that lifts the restriction
    // would not silently let an untracked builder into a list.
    listId: text('list_id').notNull().references(() => builderLists.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    builderIdentityId: text('builder_identity_id').notNull().references(() => builderIdentities.id, { onDelete: 'cascade' }),
    createdByUserId: text('created_by_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('builder_list_items_list_builder_unique').on(table.listId, table.builderIdentityId),
    index('builder_list_items_org_builder_idx').on(table.organizationId, table.builderIdentityId),
    foreignKey({
      columns: [table.organizationId, table.builderIdentityId],
      foreignColumns: [organizationBuilders.organizationId, organizationBuilders.builderIdentityId],
      name: 'builder_list_items_org_builder_tracked_fk',
    }),
  ],
)

export const organizationBuilders = pgTable(
  'organization_builders',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    builderIdentityId: text('builder_identity_id').notNull().references(() => builderIdentities.id, { onDelete: 'restrict' }),
    /**
     * The canonical human this tracked account currently resolves to (plan 43 Phase 3,
     * "Dual-read/write organization tracking"). Additive and nullable throughout the migration:
     * `builder_identity_id` above stays the authoritative key, and every read still works when this
     * is null — which is the state for every row until the backfill runs, and the state a row falls
     * back to if its canonical human is later deleted.
     *
     * `ON DELETE SET NULL`, deliberately not cascade: deleting or unmerging a canonical human must
     * never take an organization's tracking, notes or status with it. The tenant keeps its record and
     * loses only the pointer, which is what makes a cutover reversible.
     */
    canonicalHumanId: text('canonical_human_id').references(() => canonicalHumans.id, { onDelete: 'set null' }),
    creatorUserId: text('creator_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
    visibility: text('visibility').notNull().default('private'),
    status: text('status').notNull().default('tracked'),
    privateMetadata: jsonb('private_metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('organization_builders_org_identity_unique').on(table.organizationId, table.builderIdentityId),
    uniqueIndex('organization_builders_organization_id_id_unique').on(table.organizationId, table.id),
    // Reads that go by canonical human ("every account this person holds that we track") need this,
    // and the parity check scans it per organization.
    index('organization_builders_canonical_human_idx').on(table.organizationId, table.canonicalHumanId),
    check('organization_builders_visibility_check', sql`${table.visibility} in ('private', 'organization')`),
    check('organization_builders_status_check', sql`${table.status} in ('tracked', 'shortlisted', 'archived')`),
  ],
)

export const builderClaims = pgTable(
  'builder_claims',
  {
    id: text('id').primaryKey(),
    builderIdentityId: text('builder_identity_id').notNull().references(() => builderIdentities.id, { onDelete: 'cascade' }),
    subjectUserId: text('subject_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    evidenceSource: text('evidence_source').notNull(),
    evidenceReference: text('evidence_reference').notNull(),
    verificationSecretHash: text('verification_secret_hash'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: text('revoked_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    revocationReason: text('revocation_reason'),
    // Namespaced like organization_builders.privateMetadata — sibling
    // features (portfolio, future ones) get their own top-level key so a
    // read-modify-write on one never clobbers another's data.
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('builder_claims_active_identity_unique').on(table.builderIdentityId).where(sql`${table.status} in ('pending', 'verified')`),
    index('builder_claims_subject_idx').on(table.subjectUserId),
    check('builder_claims_status_check', sql`${table.status} in ('pending', 'verified', 'rejected', 'revoked', 'expired')`),
  ],
)

export const publishedBuilderProfiles = pgTable('published_builder_profiles', {
  builderIdentityId: text('builder_identity_id').primaryKey().references(() => builderIdentities.id, { onDelete: 'cascade' }),
  publishedByUserId: text('published_by_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
  displayName: text('display_name'),
  bio: text('bio'),
  openToStatus: jsonb('open_to_status').$type<string[]>().default([]).notNull(),
  topics: jsonb('topics').$type<string[]>().default([]).notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const builders = pgTable(
  'builders',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => authUsers.id),
    source: text('source').notNull(), // github | reddit | hn | devto
    sourceId: text('source_id').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    bio: text('bio'),
    profileUrl: text('profile_url').notNull(),
    followersCount: integer('followers_count').default(0),
    language: text('language'),
    country: text('country'),
    topics: jsonb('topics').$type<string[]>().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    firstSeen: timestamp('first_seen').defaultNow(),
    lastSeen: timestamp('last_seen').defaultNow(),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
    // Claimable profile fields (Plan 8)
    isClaimed: boolean('is_claimed').default(false).notNull(),
    claimedByUserId: text('claimed_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    isVerified: boolean('is_verified').default(false).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    openToStatus: jsonb('open_to_status').$type<string[]>().default([]).notNull(),
    claimedTopics: jsonb('claimed_topics').$type<string[]>().default([]).notNull(),
  },
  (table) => ({
    userSourceUnique: unique('builders_user_source_unique').on(table.userId, table.source, table.sourceId),
    organizationIdIdUnique: uniqueIndex('builders_organization_id_id_unique').on(table.organizationId, table.id),
  }),
)

export const savedQueries = pgTable(
  'saved_queries',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => authUsers.id),
    name: text('name').notNull(),
    keywords: jsonb('keywords').$type<string[]>().notNull(),
    sources: jsonb('sources').$type<string[]>().default(['github']),
    language: text('language'),
    country: text('country'),
    // Plan 28 task 3: organization-visible saved queries. Default is
    // 'private' so a pre-existing row is correctly classified as
    // owner-only — adding a default of 'organization' would have
    // silently widened every pre-existing query's visibility on the
    // migration run.
    visibility: text('visibility').notNull().default('private'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    organizationIdIdUnique: uniqueIndex('saved_queries_organization_id_id_unique').on(table.organizationId, table.id),
    // Plan 28: list "rows the principal can see" with a single index.
    // The (org, visibility, user) composite covers the most common
    // query shape — a per-org list grouped by visibility, with the
    // creator pinned to the second column so the planner can stop
    // early when the user is the creator.
    orgVisibilityCreatorIdx: index('saved_queries_org_visibility_creator_idx').on(table.organizationId, table.visibility, table.userId),
    checkVisibility: check('saved_queries_visibility_check', sql`${table.visibility} in ('private', 'organization')`),
  }),
)

// Plan: public-landing-pages Phase 2 ("public radars"). Deliberately no RLS —
// the whole point of this table is unauthenticated lookup by `slug` from
// `/r/$slug` before any principal exists to set `app.organization_id`, same
// "global, non-tenant" rationale as `builderEmbeddings`/`devpostProfiles`
// above. Writes only ever happen after an application-layer ownership check
// against the RLS-protected `savedQueries` table (see
// src/routes/api/queries/$id/share.ts), not via a Postgres policy on this
// table itself. `organizationId` + the compound FK exist so the public page
// can resolve the owning org and re-read `savedQueries` inside a manually
// scoped tenant transaction (same technique as
// `repositories/public-feeds.ts`'s `findCapabilitySavedQuery`).
export const publicRadars = pgTable('public_radars', {
  savedQueryId: text('saved_query_id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  organizationQueryFk: foreignKey({
    columns: [table.organizationId, table.savedQueryId],
    foreignColumns: [savedQueries.organizationId, savedQueries.id],
    name: 'public_radars_organization_query_fk',
  }).onDelete('cascade'),
}))

export const alerts = pgTable('alerts', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => authUsers.id),
  queryId: text('query_id').references(() => savedQueries.id),
  name: text('name').notNull(),
  keywords: jsonb('keywords').$type<string[]>().notNull(),
  frequency: text('frequency').default('daily'), // hourly | daily | weekly
  enabled: boolean('enabled').default(true),
  lastTriggeredAt: timestamp('last_triggered_at'),
  // Plan: smart-alerts Phase 1 — when the worker last evaluated this alert
  // (set on every worker pass regardless of match outcome), so `isDueForCheck`
  // can honor `frequency` instead of re-evaluating every alert every run.
  lastCheckedAt: timestamp('last_checked_at'),
  /**
   * When the worker intends to evaluate this alert next (plan:
   * calendar-scheduling-interview-intelligence, Phase 4 "Persist honest alert evaluation timing").
   *
   * This is the *checking* time, never a promise that something will be found. The calendar feed
   * reads it directly instead of recomputing a frequency window client-side, so what a user sees is
   * the worker's actual intent — including a shortened retry after a failure, which a recomputed
   * estimate would silently get wrong.
   */
  nextEvaluationAt: timestamp('next_evaluation_at'),
  /** Drives retry backoff. Reset to 0 on any successful evaluation. */
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** Short redacted code only — this surfaces in the alerts UI and the calendar feed. */
  lastEvaluationErrorCode: text('last_evaluation_error_code'),
  createdAt: timestamp('created_at').defaultNow(),
  // Plan: smart-alerts
  triggerConditions: jsonb('trigger_conditions')
    .$type<{
      eventType: 'new_repo' | 'new_product' | 'keyword_match' | 'any_activity'
      minStars?: number
      minFollowers?: number
      keywords?: string[]
      builderId?: string
    }>()
    .notNull()
    .default({ eventType: 'any_activity' }),
  deliveryChannel: text('delivery_channel').default('email'),
}, (table) => ({
  organizationIdIdUnique: uniqueIndex('alerts_organization_id_id_unique').on(table.organizationId, table.id),
  organizationQueryFk: foreignKey({
    columns: [table.organizationId, table.queryId],
    foreignColumns: [savedQueries.organizationId, savedQueries.id],
    name: 'alerts_organization_query_fk',
  }),
  // The worker's due-set scan; also the calendar feed's read path for upcoming evaluations.
  nextEvaluationIdx: index('alerts_next_evaluation_idx').on(table.enabled, table.nextEvaluationAt),
  failuresCheck: check('alerts_consecutive_failures_check', sql`${table.consecutiveFailures} >= 0`),
}))

export const alertTriggers = pgTable('alert_triggers', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  alertId: text('alert_id').notNull().references(() => alerts.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  builderId: text('builder_id').references(() => builders.id, { onDelete: 'set null' }),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
}, (table) => ({
  organizationIdIdUnique: uniqueIndex('alert_triggers_organization_id_id_unique').on(table.organizationId, table.id),
  organizationAlertFk: foreignKey({
    columns: [table.organizationId, table.alertId],
    foreignColumns: [alerts.organizationId, alerts.id],
    name: 'alert_triggers_organization_alert_fk',
  }),
  organizationBuilderFk: foreignKey({
    columns: [table.organizationId, table.builderId],
    foreignColumns: [builders.organizationId, builders.id],
    name: 'alert_triggers_organization_builder_fk',
  }),
}))

export const builderNotes = pgTable('builder_notes', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => authUsers.id),
  /**
   * References `organization_builders`, not the legacy `builders` table, because that is the id
   * space this column actually holds: `resolveOrganizationBuilderId` (notes.ts) resolves an
   * `organization_builders.id` and stores it here.
   *
   * CORRECTION to migration 0120's comment, which claimed nothing writes to `builders` anymore.
   * That is wrong — `trackOrganizationBuilder` still inserts a `builders` row using the *same* id as
   * the `organization_builders` row it creates (organization-builders.ts, the single remaining write
   * site; 5 such rows exist in local dev). So the old FK did resolve, but only by coincidence of that
   * shared id, never by design. Any path that creates an `organization_builders` row without going
   * through `trackOrganizationBuilder` — test fixtures did, and Phase 3's ingestion does — produced a
   * row whose notes could not be written at all. Repointing the FK at the table whose id this column
   * holds is correct either way; the coincidence was just load-bearing without being documented.
   */
  builderId: text('builder_id').notNull().references(() => organizationBuilders.id),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  organizationIdIdUnique: uniqueIndex('builder_notes_organization_id_id_unique').on(table.organizationId, table.id),
  organizationBuilderFk: foreignKey({
    columns: [table.organizationId, table.builderId],
    foreignColumns: [organizationBuilders.organizationId, organizationBuilders.id],
    name: 'builder_notes_organization_builder_fk',
  }),
}))
// ---------------------------------------------------------------------------
// Claimable Profiles (Plan 8)
// ---------------------------------------------------------------------------

export const builderClaimRequests = pgTable('builder_claim_requests', {
  id: text('id').primaryKey(),
  builderId: text('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const builderProfileViews = pgTable(
  'builder_profile_views',
  {
    // uuidv7 — append-heavy, see postgres-18-upgrade Phase 5 task 1.
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    // References `builderIdentities`, not the legacy per-organization `builders` table — every
    // caller (the views route, `isVerifiedBuilderClaimant`, the public `/builders/$builderId`
    // page) already addresses a builder by its identity id, the same id space `builder_claims`
    // and `published_builder_profiles` use. The FK pointed at `builders` from this table's
    // original migration (predates the builder_identities normalization) and was never updated,
    // which meant every write 500'd with a foreign-key violation for any real profile view.
    builderId: text('builder_id').notNull().references(() => builderIdentities.id, { onDelete: 'cascade' }),
    viewerId: text('viewer_id').references(() => authUsers.id, { onDelete: 'set null' }),
    viewedAt: timestamp('viewed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    builderIdx: index('builder_views_builder_idx').on(t.builderId),
  }),
)

// ---------------------------------------------------------------------------
// Onboarding (Plan: onboarding-flow)
// ---------------------------------------------------------------------------

export const onboardingProgress = pgTable(
  'onboarding_progress',
  {
    userId: text('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    step: integer('step').notNull().default(0), // 0..3
    completed: boolean('completed').notNull().default(false),
    skipped: boolean('skipped').notNull().default(false),
    skippedCount: integer('skipped_count').notNull().default(0),
    firstQueryId: text('first_query_id'),
    firstBuilderIds: jsonb('first_builder_ids').$type<string[]>().default([]).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    organizationIdIdUnique: uniqueIndex('onboarding_progress_organization_id_id_unique').on(table.organizationId, table.userId),
  }),
)

// `builderRef` stores the same opaque, source-specific id (e.g. `gh-123`,
// `cb-repo-456`) that /api/search/builders already returns per result — these
// are onboarding-time search picks, not FKs to `organizationBuilders`, since
// the builder is frequently never imported/tracked at selection time.
export const onboardingSelectedBuilders = pgTable(
  'onboarding_selected_builders',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => onboardingProgress.userId, { onDelete: 'cascade' }),
    builderRef: text('builder_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('onboarding_selected_builders_user_builder_unique').on(table.userId, table.builderRef),
    index('onboarding_selected_builders_organization_idx').on(table.organizationId),
    foreignKey({
      columns: [table.organizationId, table.userId],
      foreignColumns: [onboardingProgress.organizationId, onboardingProgress.userId],
      name: 'onboarding_selected_builders_organization_user_fk',
    }),
  ],
)

// ---------------------------------------------------------------------------
// Status & Trust (Plan: status-and-trust)
// ---------------------------------------------------------------------------

export const incidents = pgTable('incidents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('investigating'), // investigating | identified | monitoring | resolved
  severity: text('severity').notNull().default('minor'), // minor | major | critical
  affectedComponents: jsonb('affected_components').$type<string[]>().default([]).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  identifiedAt: timestamp('identified_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const changelog = pgTable('changelog', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull(), // markdown
  slug: text('slug').notNull().unique(),
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const roadmapItems = pgTable('roadmap_items', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('planned'), // planned | in_progress | shipped
  shipEstimate: text('ship_estimate'), // free text: "Q3 2026", "Aug 2026", etc.
  category: text('category').default('general'), // integrations | features | infrastructure
  sortOrder: integer('sort_order').notNull().default(0),
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const roadmapVotes = pgTable(
  'roadmap_votes',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id').notNull().references(() => roadmapItems.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemUserUnique: unique('roadmap_votes_item_user').on(t.itemId, t.userId),
  }),
)

/**
 * System-operational, no owning subject — a periodic uptime snapshot, not tenant/user data.
 * `builderhunt_worker` inserts (and prunes rows older than 90 days) from the cron-triggered
 * snapshot endpoint; `builderhunt_app`/`builderhunt_readonly` get read-only access for the public
 * `/api/status` uptime computation, same public-read pattern as `incidents`/`changelog`.
 */
export const statusChecks = pgTable(
  'status_checks',
  {
    id: text('id').primaryKey(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    ok: boolean('ok').notNull(),
    components: jsonb('components').$type<Array<{ name: string; ok: boolean; message?: string }>>().notNull(),
  },
  (table) => [
    index('status_checks_checked_at_idx').on(table.checkedAt),
  ],
)

/**
 * Per-surface search-engine indexing directives, editable by a platform admin
 * at any time without a deploy.
 *
 * System-operational, no owning subject — a platform setting, not tenant or user
 * data, so no RLS is possible or needed here (same reasoning as `status_checks`).
 * Access is controlled entirely by GRANT: `builderhunt_app` reads it on every
 * public render of an affected page, `builderhunt_platform` writes it.
 *
 * `surface` deliberately carries no CHECK constraint: the set of surfaces lives
 * in `src/shared/lib/seo/surfaces.ts`, which validates writes and ignores
 * unknown rows on read, so adding one is a code change and a row rather than a
 * migration.
 */
export const publicSurfaceIndexing = pgTable('public_surface_indexing', {
  surface: text('surface').primaryKey(),
  /** `noindex` — keep the page out of the index. */
  noindex: boolean('noindex').notNull().default(true),
  /** `nofollow` — do not follow links out of the page. */
  nofollow: boolean('nofollow').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Platform admin who last changed it. Never a tenant user. */
  updatedBy: text('updated_by'),
})

// ---------------------------------------------------------------------------
// Legal & Compliance (Plan: legal-and-compliance)
// ---------------------------------------------------------------------------

export const userConsents = pgTable('user_consents', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  document: text('document').notNull(), // 'tos' | 'privacy' | 'cookies'
  version: text('version').notNull(), // e.g. 'v1.0'
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
})

export const dataExportRequests = pgTable('data_export_requests', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'), // 'pending' | 'ready' | 'failed' | 'expired'
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const deletionRequests = pgTable('deletion_requests', {
  id: text('id').primaryKey(),
  // No FK to auth_users: this row is the compliance record that a hard delete happened,
  // so it must outlive the user row the purge worker deletes (performHardDelete/legal.ts).
  userId: text('user_id').notNull().unique(),
  status: text('status').notNull().default('pending'), // 'pending' | 'completed' | 'cancelled'
  gracePeriodEndsAt: timestamp('grace_period_ends_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// Pricing & Plans (Plan: pricing-and-billing, admin-managed, no Stripe)
// ---------------------------------------------------------------------------

export const plans = pgTable('plans', {
  userId: text('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  plan: text('plan').notNull().default('free'), // 'free' | 'pro' | 'team'
  status: text('status').notNull().default('active'), // 'active' | 'past_due' | 'canceled' | 'trialing'
  planEndsAt: timestamp('plan_ends_at', { withTimezone: true }),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const planChanges = pgTable('plan_changes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  fromPlan: text('from_plan'),
  toPlan: text('to_plan').notNull(),
  changedBy: text('changed_by').notNull(), // admin userId
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const planRequests = pgTable('plan_requests', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  requestedPlan: text('requested_plan').notNull(), // 'pro' | 'team'
  status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'declined'
  message: text('message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const organizationEntitlements = pgTable(
  'organization_entitlements',
  {
    organizationId: text('organization_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
    tier: text('tier').notNull().default('free'),
    status: text('status').notNull().default('active'),
    billingPeriod: text('billing_period').notNull().default('none'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    seatLimit: integer('seat_limit').notNull().default(1),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('organization_entitlements_tier_check', sql`${table.tier} in ('free', 'pro', 'pro_max', 'team')`),
    check('organization_entitlements_status_check', sql`${table.status} in ('active', 'past_due', 'canceled', 'trialing')`),
    check('organization_entitlements_period_check', sql`${table.billingPeriod} in ('none', 'monthly', 'annual')`),
    check('organization_entitlements_seat_limit_check', sql`${table.seatLimit} between 1 and 10`),
  ],
)

export const organizationPlanChanges = pgTable(
  'organization_plan_changes',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    fromTier: text('from_tier'),
    toTier: text('to_tier').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('organization_plan_changes_org_created_idx').on(table.organizationId, table.createdAt),
    check('organization_plan_changes_from_tier_check', sql`${table.fromTier} is null or ${table.fromTier} in ('free', 'pro', 'team')`),
    check('organization_plan_changes_to_tier_check', sql`${table.toTier} in ('free', 'pro', 'team')`),
  ],
)

export const migrationBackfillRuns = pgTable(
  'migration_backfill_runs',
  {
    name: text('name').primaryKey(),
    status: text('status').notNull().default('pending'),
    cursor: text('cursor'),
    processedCount: integer('processed_count').notNull().default(0),
    migratedCount: integer('migrated_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    conflictCount: integer('conflict_count').notNull().default(0),
    orphanCount: integer('orphan_count').notNull().default(0),
    checksum: text('checksum'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    check('migration_backfill_runs_status_check', sql`${table.status} in ('pending', 'running', 'completed', 'failed')`),
    check('migration_backfill_runs_counts_check', sql`${table.processedCount} >= 0 and ${table.migratedCount} >= 0 and ${table.skippedCount} >= 0 and ${table.conflictCount} >= 0 and ${table.orphanCount} >= 0`),
  ],
)

export const migrationBackfillConflicts = pgTable(
  'migration_backfill_conflicts',
  {
    // uuidv7 — append-heavy, see postgres-18-upgrade Phase 5 task 1.
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    runName: text('run_name').notNull().references(() => migrationBackfillRuns.name, { onDelete: 'cascade' }),
    sourceTable: text('source_table').notNull(),
    sourceId: text('source_id').notNull(),
    reason: text('reason').notNull(),
    checksum: text('checksum').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('migration_backfill_conflicts_source_reason_unique').on(table.runName, table.sourceTable, table.sourceId, table.reason),
    index('migration_backfill_conflicts_unresolved_idx').on(table.runName, table.resolvedAt),
  ],
)

// ---------------------------------------------------------------------------
// Semantic Search (Plan: semantic-search)
//
// Global, non-tenant table: one row per unique (source, sourceId) shared
// across all users (public profile data only, no userId — see spec.md's
// "per-user vs global tension" resolution). Read/written via `publicDb`
// (src/shared/lib/db/index.ts), never `withTenantContext`.
// ---------------------------------------------------------------------------

export const builderEmbeddings = pgTable(
  'builder_embeddings',
  {
    id: text('id').primaryKey(),
    // Which kind of thing this vector describes (plan 43 Phase 2, "support explicit human and
    // catalog entity kinds"). Deliberately the SAME vocabulary as the Solutions catalog's
    // `COMPONENT_KINDS` rather than a parallel one: Phase 5 indexes humans, generic roles and
    // catalog components into this one projection, and a second vocabulary would mean a
    // translation table on the hot retrieval path. Every row that predates migration 0121 is a
    // real person, hence the default.
    entityKind: text('entity_kind').notNull().default('human_profile').$type<SemanticEntityKind>(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    contentHash: text('content_hash').notNull(),
    document: text('document').notNull(),
    profile: jsonb('profile').$type<EmbeddingPayload>().notNull(),
    // NULL = pending embed (picked up by the run-worker).
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // (entity_kind, source, source_id), not (source, source_id): a catalog component and a person
    // can legitimately share a source and an id — e.g. a GitHub org that is both an indexed
    // account and a `service` in the catalog — and collapsing them would let one overwrite the
    // other's document on upsert.
    unique('builder_embeddings_entity_unique').on(table.entityKind, table.source, table.sourceId),
    check(
      'builder_embeddings_entity_kind_check',
      sql`${table.entityKind} in ('human_profile', 'human_role', 'agent', 'model', 'model_endpoint', 'mcp_server', 'tool', 'service')`,
    ),
    // Worker scan target: `WHERE embedding IS NULL` benefits from indexing
    // embeddedAt (NULL rows sort first); the HNSW vector index itself is
    // hand-written SQL appended to the generated migration (drizzle-kit
    // does not emit `USING hnsw`) — see drizzle/000X_*.sql.
    index('builder_embeddings_pending_idx').on(table.embeddedAt),
    // Retrieval filters by kind before the vector sort (Phase 5 asks for AI-only or human-only
    // lanes), so the planner needs this to avoid scanning the whole projection.
    index('builder_embeddings_entity_kind_idx').on(table.entityKind),
  ],
)

// ---------------------------------------------------------------------------
// Proactive Discovery (plan: proactive-discovery) — single-row cursor state
// for the background worker that walks DISCOVERY_MATRIX
// (src/lib/discovery/matrix.ts) and write-throughs into builder_embeddings
// above. Postgres, not Redis, because the cursor must survive restarts.
// ---------------------------------------------------------------------------

export const discoveryState = pgTable('discovery_state', {
  id: text('id').primaryKey(), // constant 'default'
  cursor: integer('cursor').notNull().default(0),
  lastCellKey: text('last_cell_key'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  stats: jsonb('stats')
    .$type<{ runs: number; upserted: number; errors: number }>()
    .notNull()
    .default({ runs: 0, upserted: 0, errors: 0 }),
})

// ---------------------------------------------------------------------------
// Devpost Ingestion (plan: devpost-integration) — global, non-tenant scraped
// store. Devpost has no API and bot-challenges plain server-side fetch (see
// plans/phase-1/19-devpost-integration/spec.md), so a headless-browser worker
// (src/lib/devpost/worker.ts) populates this table on a cron cadence; the
// `devpost` source connector (src/lib/sources/devpost.ts) only ever reads
// it, never scrapes live inside a search request. Deliberately a table of
// its own rather than reusing `builderIdentities`: that table only gets
// populated when a user tracks a specific result (same as every other
// source, via `trackOrganizationBuilder`), and it has no column for the
// search-time metadata (`projectsCount`) Devpost needs for scoring before
// anyone has tracked anything.
// ---------------------------------------------------------------------------

export const devpostProfiles = pgTable('devpost_profiles', {
  id: text('id').primaryKey(), // Devpost username — globally unique on Devpost
  username: text('username').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  profileUrl: text('profile_url').notNull(),
  projectsCount: integer('projects_count').notNull().default(0),
  // The discovery keyword(s) that surfaced this profile (e.g. "open source")
  // — Devpost bios are frequently empty (verified live), so the profile's
  // OWN text is a poor keyword-match signal; the hackathon project topic
  // that led to discovering this person is the real one. Unioned across
  // runs as the same person keeps turning up under different keywords.
  topics: jsonb('topics').$type<string[]>().notNull().default([]),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// Single-row cursor state for the worker: which keyword/page it scrapes
// next. Postgres, not Redis, so the cursor survives restarts (same rationale
// as `discoveryState` above).
export const devpostIngestionState = pgTable('devpost_ingestion_state', {
  id: text('id').primaryKey(), // constant 'default'
  keywordIndex: integer('keyword_index').notNull().default(0),
  page: integer('page').notNull().default(1),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  stats: jsonb('stats')
    .$type<{ runs: number; projectsSeen: number; profilesUpserted: number; errors: number }>()
    .notNull()
    .default({ runs: 0, projectsSeen: 0, profilesUpserted: 0, errors: 0 }),
})

// ---------------------------------------------------------------------------
// AI Sourcing Sprints (plan: ai-sourcing-sprints) — organization-scoped
// saved query variants re-executed by a background worker until a result
// quota is reached. No FK to `organizationBuilders`/`builders` — results are
// per-(source, sourceId) public snapshots, same identity convention as
// `builderEmbeddings`. Tracking a result uses the existing track endpoint.
// ---------------------------------------------------------------------------

export const sourcingSprints = pgTable(
  'sourcing_sprints',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    creatorUserId: text('creator_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    criteria: jsonb('criteria').$type<ExtractedCriteria>().notNull(),
    variants: jsonb('variants').$type<QueryVariant[]>().notNull(),
    status: text('status').notNull().default('active'),
    quota: integer('quota').notNull().default(200),
    cursor: jsonb('cursor').$type<SprintCursor>().notNull().default({ variantIndex: 0, page: 1 }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sourcing_sprints_organization_id_id_unique').on(table.organizationId, table.id),
    index('sourcing_sprints_org_status_last_run_idx').on(table.organizationId, table.status, table.lastRunAt),
    check('sourcing_sprints_status_check', sql`${table.status} in ('active', 'paused', 'completed')`),
  ],
)

export const sprintResults = pgTable(
  'sprint_results',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    sprintId: text('sprint_id').notNull().references(() => sourcingSprints.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    profile: jsonb('profile').$type<SprintProfileSnapshot>().notNull(),
    matchedVariant: text('matched_variant').notNull(),
    score: integer('score').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('sprint_results_sprint_source_unique').on(table.sprintId, table.source, table.sourceId),
    index('sprint_results_sprint_created_idx').on(table.sprintId, table.createdAt),
    foreignKey({
      columns: [table.organizationId, table.sprintId],
      foreignColumns: [sourcingSprints.organizationId, sourcingSprints.id],
      name: 'sprint_results_organization_sprint_fk',
    }),
  ],
)

// ---------------------------------------------------------------------------
// Public Profile Enrichment (plan: stealth-scraping) — organization-scoped
// job queue + evidence, plus one platform-scoped subject-restriction table.
// Spec: plans/phase-1/42-stealth-scraping/spec.md §7. Reuses the organization_builders
// composite-FK convention (organization_id, builder_identity_id) so a job can
// never reference a builder identity the organization hasn't tracked.
// ---------------------------------------------------------------------------

export const enrichmentJobs = pgTable(
  'enrichment_jobs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    builderIdentityId: text('builder_identity_id').notNull().references(() => builderIdentities.id, { onDelete: 'cascade' }),
    requestedByUserId: text('requested_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    trigger: text('trigger').notNull().default('manual'),
    status: text('status').notNull().default('queued'),
    requestedConnectors: jsonb('requested_connectors').$type<string[]>().default([]).notNull(),
    submittedUrls: jsonb('submitted_urls').$type<string[]>().default([]).notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('enrichment_jobs_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      columns: [table.organizationId, table.builderIdentityId],
      foreignColumns: [organizationBuilders.organizationId, organizationBuilders.builderIdentityId],
      name: 'enrichment_jobs_organization_builder_fk',
    }),
    uniqueIndex('enrichment_jobs_active_unique')
      .on(table.organizationId, table.builderIdentityId)
      .where(sql`${table.status} in ('queued', 'running')`),
    index('enrichment_jobs_worker_scan_idx').on(table.status, table.availableAt, table.leaseExpiresAt),
    check('enrichment_jobs_status_check', sql`${table.status} in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')`),
    check('enrichment_jobs_trigger_check', sql`${table.trigger} in ('manual', 'scheduled')`),
    check('enrichment_jobs_attempt_count_check', sql`${table.attemptCount} >= 0`),
  ],
)

export const enrichmentEvidence = pgTable(
  'enrichment_evidence',
  {
    // uuidv7 — append-heavy, see postgres-18-upgrade Phase 5 task 1.
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    jobId: text('job_id').notNull(),
    builderIdentityId: text('builder_identity_id').notNull().references(() => builderIdentities.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    acquisitionMode: text('acquisition_mode').notNull(),
    sourceUrl: text('source_url').notNull(),
    sourceRecordId: text('source_record_id'),
    contentHash: text('content_hash').notNull(),
    payload: jsonb('payload').$type<EnrichmentEvidencePayload>().notNull(),
    confidenceBps: integer('confidence_bps').notNull(),
    resolverVersion: integer('resolver_version').notNull(),
    scoreComponents: jsonb('score_components').$type<Record<string, number>>().notNull(),
    matchSignals: jsonb('match_signals').$type<string[]>().notNull(),
    contradictions: jsonb('contradictions').$type<string[]>().notNull(),
    resolution: text('resolution').notNull().default('review'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    reviewedByUserId: text('reviewed_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('enrichment_evidence_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      columns: [table.organizationId, table.builderIdentityId],
      foreignColumns: [organizationBuilders.organizationId, organizationBuilders.builderIdentityId],
      name: 'enrichment_evidence_organization_builder_fk',
    }),
    foreignKey({
      columns: [table.organizationId, table.jobId],
      foreignColumns: [enrichmentJobs.organizationId, enrichmentJobs.id],
      name: 'enrichment_evidence_organization_job_fk',
    }),
    uniqueIndex('enrichment_evidence_org_builder_connector_hash_unique')
      .on(table.organizationId, table.builderIdentityId, table.connector, table.contentHash),
    index('enrichment_evidence_org_builder_resolution_idx')
      .on(table.organizationId, table.builderIdentityId, table.resolution, table.observedAt),
    check('enrichment_evidence_confidence_check', sql`${table.confidenceBps} >= 0 and ${table.confidenceBps} <= 10000`),
    check('enrichment_evidence_resolution_check', sql`${table.resolution} in ('accepted', 'review', 'rejected')`),
  ],
)

/** Platform-scoped: one row per `builderIdentityId`. Never joined per-organization. */
export const builderProcessingRestrictions = pgTable(
  'builder_processing_restrictions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    builderIdentityId: text('builder_identity_id').notNull().references(() => builderIdentities.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('active'),
    actorUserId: text('actor_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    reference: text('reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('builder_processing_restrictions_active_unique')
      .on(table.builderIdentityId)
      .where(sql`${table.status} = 'active'`),
    check('builder_processing_restrictions_reason_check', sql`${table.reason} in ('subject_request', 'legal', 'safety')`),
    check('builder_processing_restrictions_status_check', sql`${table.status} in ('active', 'withdrawn')`),
  ],
)

// ---------------------------------------------------------------------------
// Stripe Billing Platform Tables (plans/phase-1/30-stripe-billing-platform/spec.md §Data model)
// ---------------------------------------------------------------------------

export const billingCustomers = pgTable(
  'billing_customers',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    livemode: boolean('livemode').notNull(),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_customers_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('billing_customers_org_livemode_unique').on(table.organizationId, table.livemode),
    uniqueIndex('billing_customers_stripe_customer_id_unique').on(table.stripeCustomerId),
  ],
)

export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    customerId: text('customer_id').notNull().references(() => billingCustomers.id, { onDelete: 'restrict' }),
    livemode: boolean('livemode').notNull(),
    catalogKey: text('catalog_key').notNull(),
    tier: text('tier').notNull(),
    interval: text('interval').notNull(),
    catalogVersion: integer('catalog_version').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    stripeStatus: text('stripe_status').notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    scheduledChange: jsonb('scheduled_change').$type<{ catalogKey: string; effectiveAt: string } | null>().default(null),
    gracePeriodEndsAt: timestamp('grace_period_ends_at', { withTimezone: true }),
    paymentBlockedAt: timestamp('payment_blocked_at', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    providerSyncedAt: timestamp('provider_synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_subscriptions_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('billing_subscriptions_stripe_subscription_id_unique').on(table.stripeSubscriptionId),
    // Only one non-canceled base subscription per org/livemode — the state machine schedules
    // cancellation at period end rather than deleting the row, so this excludes canceled rows only.
    uniqueIndex('billing_subscriptions_org_livemode_active_unique')
      .on(table.organizationId, table.livemode)
      .where(sql`${table.canceledAt} is null`),
    foreignKey({
      columns: [table.organizationId, table.customerId],
      foreignColumns: [billingCustomers.organizationId, billingCustomers.id],
      name: 'billing_subscriptions_organization_customer_fk',
    }),
    check('billing_subscriptions_tier_check', sql`${table.tier} in ('pro', 'pro_max', 'team')`),
    check('billing_subscriptions_interval_check', sql`${table.interval} in ('monthly', 'annual')`),
  ],
)

export const billingCheckoutAttempts = pgTable(
  'billing_checkout_attempts',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    livemode: boolean('livemode').notNull(),
    action: text('action').notNull(),
    catalogKey: text('catalog_key').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    consentVersions: jsonb('consent_versions').$type<{ terms: string; privacy: string }>().notNull(),
    stripeCheckoutSessionId: text('stripe_checkout_session_id'),
    status: text('status').notNull().default('open'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_checkout_attempts_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('billing_checkout_attempts_org_idempotency_unique').on(table.organizationId, table.idempotencyKey),
    check('billing_checkout_attempts_action_check', sql`${table.action} in ('subscription', 'credits')`),
    check('billing_checkout_attempts_status_check', sql`${table.status} in ('open', 'complete', 'expired', 'canceled')`),
  ],
)

/** System operational: platform/worker-only, no organization scope — one row per Stripe event. */
export const billingWebhookEvents = pgTable(
  'billing_webhook_events',
  {
    id: text('id').primaryKey(),
    livemode: boolean('livemode').notNull(),
    stripeEventId: text('stripe_event_id').notNull(),
    apiVersion: text('api_version').notNull(),
    objectType: text('object_type').notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    // Minimized, encrypted-at-rest raw payload (spec.md §Operations) — never the plain Stripe body.
    payloadEncrypted: text('payload_encrypted').notNull(),
    lastError: text('last_error'),
  },
  (table) => [
    uniqueIndex('billing_webhook_events_livemode_stripe_event_id_unique').on(table.livemode, table.stripeEventId),
    index('billing_webhook_events_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
    check('billing_webhook_events_status_check', sql`${table.status} in ('pending', 'processing', 'processed', 'failed', 'ignored')`),
    check('billing_webhook_events_attempts_check', sql`${table.attempts} >= 0`),
  ],
)

export const billingCreditGrants = pgTable(
  'billing_credit_grants',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceReference: text('source_reference'),
    stripePaymentReference: text('stripe_payment_reference'),
    // The Stripe PaymentIntent id backing this grant's charge — distinct from
    // stripePaymentReference (which is the Checkout Session id for manually-purchased packs,
    // `cs_...`, kept as-is so auto-recharge.ts's `pi_`/`cs_` prefix distinction still works).
    // Refunds (§8 task 4) need the actual PaymentIntent id regardless of purchase path — a
    // Checkout Session id cannot be passed to Stripe's refund API directly.
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    // Set only for subscription-window grants, e.g. `${subscriptionId}:2026-08` — unique when present.
    monthlyWindowKey: text('monthly_window_key'),
    originalUnits: integer('original_units').notNull(),
    remainingUnits: integer('remaining_units').notNull(),
    state: text('state').notNull().default('active'),
    activeAt: timestamp('active_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_credit_grants_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('billing_credit_grants_monthly_window_unique')
      .on(table.monthlyWindowKey)
      .where(sql`${table.monthlyWindowKey} is not null`),
    index('billing_credit_grants_org_state_expiry_idx').on(table.organizationId, table.state, table.expiresAt),
    check(
      'billing_credit_grants_source_check',
      sql`${table.source} in ('subscription_monthly', 'subscription_annual_window', 'subscription_upgrade_delta', 'pack', 'legacy_manual', 'promotional', 'operator_trial')`,
    ),
    check('billing_credit_grants_state_check', sql`${table.state} in ('active', 'frozen', 'expired', 'revoked')`),
    check(
      'billing_credit_grants_units_check',
      sql`${table.originalUnits} >= 0 and ${table.remainingUnits} >= 0 and ${table.remainingUnits} <= ${table.originalUnits}`,
    ),
  ],
)

export const billingCreditReservations = pgTable(
  'billing_credit_reservations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    rateCardVersion: integer('rate_card_version').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    maximumUnits: integer('maximum_units').notNull(),
    settledUnits: integer('settled_units'),
    state: text('state').notNull().default('reserved'),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).defaultNow().notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    settlementGraceEndsAt: timestamp('settlement_grace_ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_credit_reservations_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('billing_credit_reservations_org_idempotency_unique').on(table.organizationId, table.idempotencyKey),
    check('billing_credit_reservations_state_check', sql`${table.state} in ('reserved', 'settled', 'released', 'expired')`),
    check(
      'billing_credit_reservations_units_check',
      sql`${table.maximumUnits} >= 0 and (${table.settledUnits} is null or (${table.settledUnits} >= 0 and ${table.settledUnits} <= ${table.maximumUnits}))`,
    ),
  ],
)

export const billingCreditAllocations = pgTable(
  'billing_credit_allocations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    reservationId: text('reservation_id').notNull().references(() => billingCreditReservations.id, { onDelete: 'restrict' }),
    grantId: text('grant_id').notNull().references(() => billingCreditGrants.id, { onDelete: 'restrict' }),
    allocatedUnits: integer('allocated_units').notNull(),
    consumedUnits: integer('consumed_units').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_credit_allocations_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('billing_credit_allocations_reservation_grant_unique').on(table.reservationId, table.grantId),
    foreignKey({
      columns: [table.organizationId, table.reservationId],
      foreignColumns: [billingCreditReservations.organizationId, billingCreditReservations.id],
      name: 'billing_credit_allocations_organization_reservation_fk',
    }),
    foreignKey({
      columns: [table.organizationId, table.grantId],
      foreignColumns: [billingCreditGrants.organizationId, billingCreditGrants.id],
      name: 'billing_credit_allocations_organization_grant_fk',
    }),
    // Cross-row conservation (allocated <= grant.remaining, consumed <= reservation.settled) is an
    // application/transaction invariant — a single-row CHECK cannot see sibling rows.
    check(
      'billing_credit_allocations_units_check',
      sql`${table.allocatedUnits} >= 0 and ${table.consumedUnits} >= 0 and ${table.consumedUnits} <= ${table.allocatedUnits}`,
    ),
  ],
)

/** Append-only — entries are never updated or deleted; mistakes use compensating entries only. */
export const billingLedgerEntries = pgTable(
  'billing_ledger_entries',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    entryType: text('entry_type').notNull(),
    grantId: text('grant_id').references(() => billingCreditGrants.id, { onDelete: 'restrict' }),
    reservationId: text('reservation_id').references(() => billingCreditReservations.id, { onDelete: 'restrict' }),
    unitsDelta: integer('units_delta').notNull(),
    sourceIdempotencyKey: text('source_idempotency_key').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_ledger_entries_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('billing_ledger_entries_org_source_idempotency_unique').on(table.organizationId, table.sourceIdempotencyKey),
    index('billing_ledger_entries_org_created_idx').on(table.organizationId, table.createdAt),
    foreignKey({
      columns: [table.organizationId, table.grantId],
      foreignColumns: [billingCreditGrants.organizationId, billingCreditGrants.id],
      name: 'billing_ledger_entries_organization_grant_fk',
    }),
    foreignKey({
      columns: [table.organizationId, table.reservationId],
      foreignColumns: [billingCreditReservations.organizationId, billingCreditReservations.id],
      name: 'billing_ledger_entries_organization_reservation_fk',
    }),
    check(
      'billing_ledger_entries_entry_type_check',
      sql`${table.entryType} in ('grant', 'reserve', 'release', 'consume', 'expire', 'freeze', 'unfreeze', 'revoke', 'adjust')`,
    ),
  ],
)

export const billingProviderUsage = pgTable(
  'billing_provider_usage',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    reservationId: text('reservation_id').references(() => billingCreditReservations.id, { onDelete: 'set null' }),
    providerRequestId: text('provider_request_id'),
    units: integer('units').notNull(),
    estimatedCostCents: integer('estimated_cost_cents').notNull(),
    actualCostCents: integer('actual_cost_cents'),
    currency: text('currency').notNull().default('usd'),
    reconciliationState: text('reconciliation_state').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_provider_usage_organization_id_id_unique').on(table.organizationId, table.id),
    index('billing_provider_usage_org_created_idx').on(table.organizationId, table.createdAt),
    check('billing_provider_usage_units_check', sql`${table.units} >= 0`),
    check('billing_provider_usage_reconciliation_check', sql`${table.reconciliationState} in ('pending', 'matched', 'mismatched')`),
  ],
)

/** One row per organization — owner-configured, disabled by default (spec.md §Packs and auto-recharge). */
export const billingAutoRechargeRules = pgTable(
  'billing_auto_recharge_rules',
  {
    organizationId: text('organization_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
    enabled: boolean('enabled').notNull().default(false),
    packCatalogKey: text('pack_catalog_key'),
    balanceThresholdUnits: integer('balance_threshold_units'),
    monthlyCapCents: integer('monthly_cap_cents'),
    state: text('state').notNull().default('inactive'),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastFailureReason: text('last_failure_reason'),
    consentVersion: text('consent_version'),
    // Set the moment an off-session recharge PaymentIntent is created, cleared once its outcome
    // (succeeded/failed/requires_action) is known — the in-flight guard that stops the worker from
    // triggering a second charge for the same balance-crossing event before the first one resolves.
    // A NOT NULL value here means "do not evaluate this rule for a new trigger."
    pendingPaymentIntentId: text('pending_payment_intent_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('billing_auto_recharge_rules_state_check', sql`${table.state} in ('inactive', 'active', 'paused_needs_auth', 'paused_failed')`),
    // $1,000 absolute monthly cap (spec.md §Packs and auto-recharge), in smallest currency units.
    check('billing_auto_recharge_rules_cap_check', sql`${table.monthlyCapCents} is null or ${table.monthlyCapCents} <= 100000`),
  ],
)

export const billingRefunds = pgTable(
  'billing_refunds',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    subscriptionId: text('subscription_id').references(() => billingSubscriptions.id, { onDelete: 'restrict' }),
    grantId: text('grant_id').references(() => billingCreditGrants.id, { onDelete: 'restrict' }),
    requestedByUserId: text('requested_by_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
    operatorUserId: text('operator_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    idempotencyKey: text('idempotency_key').notNull(),
    policyDecision: text('policy_decision').notNull(),
    amountCents: integer('amount_cents').notNull(),
    stripeRefundId: text('stripe_refund_id'),
    revisedServiceEndAt: timestamp('revised_service_end_at', { withTimezone: true }),
    creditRevocationUnits: integer('credit_revocation_units'),
    state: text('state').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_refunds_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('billing_refunds_org_idempotency_unique').on(table.organizationId, table.idempotencyKey),
    foreignKey({
      columns: [table.organizationId, table.subscriptionId],
      foreignColumns: [billingSubscriptions.organizationId, billingSubscriptions.id],
      name: 'billing_refunds_organization_subscription_fk',
    }),
    foreignKey({
      columns: [table.organizationId, table.grantId],
      foreignColumns: [billingCreditGrants.organizationId, billingCreditGrants.id],
      name: 'billing_refunds_organization_grant_fk',
    }),
    check(
      'billing_refunds_policy_check',
      sql`${table.policyDecision} in ('full_unused_pack', 'partial_pack_operator', 'full_subscription_invoice', 'partial_subscription_operator')`,
    ),
    check('billing_refunds_state_check', sql`${table.state} in ('pending', 'succeeded', 'failed', 'repair_needed')`),
    check('billing_refunds_amount_check', sql`${table.amountCents} >= 0`),
  ],
)

/**
 * Chargeback tracking (plans/phase-1/30-stripe-billing-platform/tasks.md §8 "Implement dispute freeze,
 * outcome, and alerts"). Pack disputes only (see `billing/disputes.ts`'s module comment for why
 * subscription disputes are a documented, separate gap) — `grantId` is therefore always set for a
 * row this app itself created.
 */
export const billingDisputes = pgTable(
  'billing_disputes',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    grantId: text('grant_id').references(() => billingCreditGrants.id, { onDelete: 'restrict' }),
    stripeDisputeId: text('stripe_dispute_id').notNull(),
    stripePaymentIntentId: text('stripe_payment_intent_id').notNull(),
    amountCents: integer('amount_cents').notNull(),
    reason: text('reason'),
    stripeStatus: text('stripe_status').notNull(),
    outcome: text('outcome').notNull().default('open'),
    evidenceDueBy: timestamp('evidence_due_by', { withTimezone: true }),
    fundsReinstatedAt: timestamp('funds_reinstated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_disputes_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('billing_disputes_org_stripe_dispute_unique').on(table.organizationId, table.stripeDisputeId),
    foreignKey({
      columns: [table.organizationId, table.grantId],
      foreignColumns: [billingCreditGrants.organizationId, billingCreditGrants.id],
      name: 'billing_disputes_organization_grant_fk',
    }),
    check('billing_disputes_outcome_check', sql`${table.outcome} in ('open', 'won', 'lost')`),
    check('billing_disputes_amount_check', sql`${table.amountCents} >= 0`),
  ],
)

/**
 * Verified billing contact (plans/phase-1/30-stripe-billing-platform/tasks.md §9 "Add verified billing contact
 * management") — one current contact email per organization, owner-set and self-verified (mirrors
 * `billing_auto_recharge_rules`' shape: PK'd directly on `organization_id`, no surrogate id, since
 * this is mutable current state, not an append-only ledger). Setting a NEW email while a PREVIOUS one
 * is `verified` overwrites it outright (`billing/billing-contact.ts`'s own module comment) — this is
 * "set and verify a separate email," not a permanent history of every past contact.
 */
export const billingContacts = pgTable(
  'billing_contacts',
  {
    organizationId: text('organization_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    status: text('status').notNull().default('pending'),
    /** SHA-256 of the emailed verification token — the raw token is never stored, mirroring `builder_claims.verification_secret_hash`. */
    verificationSecretHash: text('verification_secret_hash'),
    verificationExpiresAt: timestamp('verification_expires_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    setByUserId: text('set_by_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('billing_contacts_status_check', sql`${table.status} in ('pending', 'verified')`),
  ],
)

/**
 * Durable compliance snapshot written just before an organization row (and its full cascade —
 * members, resources, `billing_customers`/`billing_subscriptions`/etc.) is hard-deleted, whether via
 * the 30-day scheduled path or the owner-initiated immediate path (plans/phase-1/30-stripe-billing-platform/
 * tasks.md §9 "Integrate subscription-safe organization deletion" — "retains only approved financial
 * records"). Deliberately NOT a foreign key to `organizations`: by the time this row is read back,
 * the organization it describes no longer exists. No RLS tenant-scoping either, for the same
 * reason — there is no live `app.organization_id` to scope by; access is role-gated only (worker
 * writes it, platform reads it), never exposed to the app/tenant role at all.
 */
export const organizationDeletionFinancialRecords = pgTable(
  'organization_deletion_financial_records',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    organizationName: text('organization_name').notNull(),
    deletionType: text('deletion_type').notNull(),
    livemode: boolean('livemode').notNull(),
    stripeCustomerId: text('stripe_customer_id'),
    lastSubscriptionTier: text('last_subscription_tier'),
    lastSubscriptionInterval: text('last_subscription_interval'),
    subscriptionCanceledAt: timestamp('subscription_canceled_at', { withTimezone: true }),
    retainedAt: timestamp('retained_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('organization_deletion_financial_records_deletion_type_check', sql`${table.deletionType} in ('scheduled', 'immediate')`),
  ],
)

/**
 * Append-only velocity signal for fraud/high-volume exception controls (plans/phase-1/30-stripe-billing-platform/
 * tasks.md §8 "Add fraud and high-volume exception controls"). Every known payment failure is
 * recorded here by its own call site (`packs.ts`'s Checkout decline, `auto-recharge.ts`'s off-session
 * decline) — `risk.ts` only ever reads this table, never writes it directly, mirroring
 * `billing_ledger_entries`' own append-only, single-writer-per-event-type convention.
 */
export const billingRiskEvents = pgTable(
  'billing_risk_events',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_risk_events_organization_id_id_unique').on(table.organizationId, table.id),
    index('billing_risk_events_org_type_created_idx').on(table.organizationId, table.eventType, table.createdAt),
    check('billing_risk_events_type_check', sql`${table.eventType} in ('payment_failure', 'card_rotation', 'dispute_opened')`),
  ],
)

/**
 * Platform-operator-issued, time-bounded, reasoned exceptions that lift `risk.ts`'s velocity block
 * for one organization — never a substitute for a successful payment or a bypass of any ledger rule
 * (the exception only unblocks attempting a NEW purchase; the purchase itself must still succeed
 * through the normal Checkout/PaymentIntent path to grant anything).
 */
export const billingRiskExceptions = pgTable(
  'billing_risk_exceptions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    issuedByUserId: text('issued_by_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('billing_risk_exceptions_organization_id_id_unique').on(table.organizationId, table.id),
    index('billing_risk_exceptions_org_expires_idx').on(table.organizationId, table.expiresAt),
  ],
)

/** System operational: platform-only, no organization scope. */
export const billingReconciliationRuns = pgTable(
  'billing_reconciliation_runs',
  {
    id: text('id').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    countsChecked: jsonb('counts_checked').$type<Record<string, number>>().notNull(),
    mismatches: jsonb('mismatches').$type<Array<{ type: string; reference: string; detail: string }>>().notNull().default([]),
    repairs: jsonb('repairs').$type<Array<{ type: string; reference: string; action: string }>>().notNull().default([]),
    result: text('result').notNull().default('clean'),
    actorUserId: text('actor_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('billing_reconciliation_runs_window_idx').on(table.windowStart, table.windowEnd),
    check('billing_reconciliation_runs_result_check', sql`${table.result} in ('clean', 'mismatches_found', 'repairs_applied')`),
  ],
)

/**
 * Deduplication ledger for financial notifications (plans/phase-1/30-stripe-billing-platform/tasks.md §10 "Add
 * financial notifications, metrics, and alerts") — the general "have we already sent notification X
 * for entity Y in policy window W" answer every message type in that task needs. `organizationId` has
 * no FK (mirrors `organization_deletion_financial_records`): the `'platform'` sentinel value is used
 * for cross-organization notification types (e.g. a reconciliation-mismatch alert isn't about a single
 * tenant), which a real FK to `organizations.id` could never satisfy. The unique index is the actual
 * dedup mechanism — `notifications.ts`'s `recordNotificationIfDue` does an `ON CONFLICT DO NOTHING
 * RETURNING`, and only sends the real notification if a row was actually inserted.
 */
export const billingNotificationLog = pgTable(
  'billing_notification_log',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    notificationType: text('notification_type').notNull(),
    windowKey: text('window_key').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_notification_log_org_type_window_unique').on(table.organizationId, table.notificationType, table.windowKey),
    check(
      'billing_notification_log_type_check',
      sql`${table.notificationType} in ('credit_expiry_30', 'credit_expiry_7', 'credit_expiry_1', 'subscription_renewal', 'grace_period', 'action_required', 'refund_decision', 'dispute_opened', 'reconciliation_mismatch')`,
    ),
  ],
)

/** Platform-private: versioned seller configuration, no CPR/card/bank data (spec.md §Seller, country, currency, and tax configuration). */
export const billingSellerProfiles = pgTable(
  'billing_seller_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    version: integer('version').notNull(),
    legalName: text('legal_name').notNull(),
    publicBusinessAddress: text('public_business_address').notNull(),
    establishmentCountry: text('establishment_country').notNull(),
    approvedTaxIds: jsonb('approved_tax_ids').$type<string[]>().notNull().default([]),
    supportEmail: text('support_email').notNull(),
    statementDescriptor: text('statement_descriptor').notNull(),
    countryAllowlist: jsonb('country_allowlist').$type<string[]>().notNull().default([]),
    taxRegistrations: jsonb('tax_registrations')
      .$type<Array<{ country: string; registrationId: string; effectiveAt: string }>>()
      .notNull()
      .default([]),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    createdByUserId: text('created_by_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_seller_profiles_version_unique').on(table.version),
    check('billing_seller_profiles_version_check', sql`${table.version} >= 1`),
  ],
)

export const billingTermsAcceptances = pgTable(
  'billing_terms_acceptances',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    termsVersion: text('terms_version').notNull(),
    privacyVersion: text('privacy_version').notNull(),
    commercialAction: text('commercial_action').notNull(),
    referenceId: text('reference_id'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('billing_terms_acceptances_organization_id_id_unique').on(table.organizationId, table.id),
    index('billing_terms_acceptances_org_action_idx').on(table.organizationId, table.commercialAction, table.acceptedAt),
    check('billing_terms_acceptances_action_check', sql`${table.commercialAction} in ('checkout_subscription', 'checkout_credits', 'auto_recharge')`),
  ],
)

// ---------------------------------------------------------------------------
// Abuse and Usage Integrity (Plan: abuse-and-usage-integrity)
// ---------------------------------------------------------------------------

/**
 * Account-subject (`user_id`): one row per (user, device fingerprint hash). The fingerprint is a
 * salted hash of a first-party device cookie + UA client-hint family — never a raw fingerprint or
 * any PII — computed by `src/shared/lib/abuse/device.ts`. RLS filters on `app.user_id`, the same
 * session variable `tenant-context.ts`'s `withTenantContext` already sets on every request
 * alongside `app.organization_id` (see `0011_builder_claim_policies.sql` for the original
 * `subject_user_id` precedent this reuses).
 */
export const userDevices = pgTable(
  'user_devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    deviceHash: text('device_hash').notNull(),
    uaFamily: text('ua_family'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastIpAsn: text('last_ip_asn'),
    lastCountry: text('last_country'),
    trustState: text('trust_state').notNull().default('new'),
  },
  (table) => [
    uniqueIndex('user_devices_user_id_device_hash_unique').on(table.userId, table.deviceHash),
    index('user_devices_user_id_last_seen_idx').on(table.userId, table.lastSeenAt),
    check('user_devices_trust_state_check', sql`${table.trustState} in ('new', 'trusted', 'flagged')`),
  ],
)

/**
 * System operational: no `organization_id`/`user_id` column, no RLS possible or needed — access is
 * controlled entirely by GRANT to `builderhunt_worker`/`builderhunt_platform`. Correlates to a
 * session only via a salted session-id hash (OWASP logging guidance: never store the raw session
 * token anywhere outside the session store itself), and to a device via `deviceId` — both are
 * one-way lookups an operator can join on, never a way to reconstruct the original token.
 */
export const sessionSignals = pgTable(
  'session_signals',
  {
    id: text('id').primaryKey(),
    sessionIdHash: text('session_id_hash').notNull(),
    deviceId: text('device_id').references(() => userDevices.id, { onDelete: 'set null' }),
    ipAsn: text('ip_asn'),
    country: text('country'),
    newDevice: boolean('new_device').notNull().default(false),
    concurrentDistinctIp: boolean('concurrent_distinct_ip').notNull().default(false),
    impossibleTravel: boolean('impossible_travel').notNull().default(false),
    midSessionUaChange: boolean('mid_session_ua_change').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('session_signals_session_id_hash_idx').on(table.sessionIdHash),
    index('session_signals_created_at_idx').on(table.createdAt),
  ],
)

/**
 * System operational, append-only — never updated or deleted (matches `billing_ledger_entries`'
 * append-only convention: no `updatedAt` column at all). `userId`/`organizationId` are correlation
 * columns only, deliberately with NO foreign key — an abuse signal must outlive the account or
 * organization it names (compliance/investigation trail), the same reasoning
 * `deletion_requests.user_id` already documents for the same reason.
 */
export const abuseSignals = pgTable(
  'abuse_signals',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    severity: text('severity').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>(),
    userId: text('user_id'),
    organizationId: text('organization_id'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('abuse_signals_user_id_created_idx').on(table.userId, table.createdAt),
    index('abuse_signals_organization_id_created_idx').on(table.organizationId, table.createdAt),
    index('abuse_signals_type_created_idx').on(table.type, table.createdAt),
    check(
      'abuse_signals_type_check',
      sql`${table.type} in (
        'concurrent_sessions', 'impossible_travel', 'ua_change', 'seat_overuse',
        'signup_velocity', 'linked_account', 'export_burst', 'cross_tenant_denied',
        'credit_farming', 'pool_drain', 'refund_farming', 'margin_drift', 'reserve_leak'
      )`,
    ),
    check('abuse_signals_severity_check', sql`${table.severity} in ('low', 'medium', 'high')`),
  ],
)

/**
 * Account-subject (`user_id`): one row per user, rolling risk score + current enforcement stage.
 * RLS filters on `app.user_id`, same as `user_devices` above.
 */
export const accountRisk = pgTable(
  'account_risk',
  {
    userId: text('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
    riskScore: integer('risk_score').notNull().default(0),
    stage: text('stage').notNull().default('observe'),
    reason: text('reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('account_risk_stage_check', sql`${table.stage} in ('observe', 'warned', 'stepup', 'throttled', 'blocked')`),
    check('account_risk_score_check', sql`${table.riskScore} >= 0`),
  ],
)

/**
 * Tenant-private (`organization_id`): per-(organization, seat/user, UTC day) counters for the
 * scarce core actions that were never metered at all before this plan (unlike AI credits, which
 * `billing_credit_grants`/`billing_ledger_entries` already govern). Enforces a per-seat ceiling so
 * sharing one seat hits a wall quickly — the unique index below is the enforcement primitive every
 * increment upserts against.
 */
export const seatUsageDaily = pgTable(
  'seat_usage_daily',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    day: text('day').notNull(), // UTC calendar day, 'YYYY-MM-DD' — a plain date column would silently apply the DB session's timezone
    action: text('action').notNull(),
    count: integer('count').notNull().default(0),
    // Each seat's share of the pooled monthly credit budget (G2 — pool_drain via seat sharing).
    creditUnits: integer('credit_units').notNull().default(0),
  },
  (table) => [
    uniqueIndex('seat_usage_daily_org_user_day_action_unique').on(table.organizationId, table.userId, table.day, table.action),
    index('seat_usage_daily_organization_id_day_idx').on(table.organizationId, table.day),
    check('seat_usage_daily_action_check', sql`${table.action} in ('searches', 'reveals', 'exports', 'messages')`),
    check('seat_usage_daily_count_check', sql`${table.count} >= 0`),
  ],
)

/**
 * Plan: work-sample. The recruiter's own artifact, never the builder's — see
 * the plan's spec header for the privacy rationale. Deliberately keyed by
 * `user_id`, not `organization_id` (org-shared visibility arrives with
 * `team-accounts`); RLS below mirrors `builder_claims`'s `app.user_id`
 * policies rather than the usual `app.organization_id` ones.
 * `builderIdentityId` links back to the profile the analysis was launched
 * from — `set null` on delete keeps the artifact even if that identity row
 * is later removed.
 */
export const workSampleAnalyses = pgTable(
  'work_sample_analyses',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    builderIdentityId: text('builder_identity_id').references(() => builderIdentities.id, { onDelete: 'set null' }),
    sampleUrl: text('sample_url').notNull(),
    sampleType: text('sample_type').notNull(), // 'repo' | 'pr' | 'file'
    analysis: jsonb('analysis').$type<WorkSampleAnalysis>().notNull(), // versioned envelope, see synergy.ts's schema
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('work_sample_user_url_unique').on(table.userId, table.sampleUrl),
    index('work_sample_analyses_user_id_idx').on(table.userId),
    index('work_sample_analyses_builder_identity_id_idx').on(table.builderIdentityId),
    check('work_sample_analyses_sample_type_check', sql`${table.sampleType} in ('repo', 'pr', 'file')`),
  ],
)

/**
 * Plan: audit-conversion. Append-only, privacy-minimized landing-funnel
 * events — no user id, email, IP, query text, referrer, or user agent, only
 * what `conversion-events.ts`'s closed schema allows. `serverDay` is the
 * server-computed UTC calendar day (not the client's `occurredAt`), used for
 * date-range aggregate queries without re-parsing every row's timestamp.
 * `(sessionId, name, surface, variant)` is unique so a retried client
 * request is a no-op rather than double-counting a funnel step.
 */
export const conversionEvents = pgTable(
  'conversion_events',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    surface: text('surface').notNull(),
    sessionId: text('session_id').notNull(),
    variant: text('variant').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    serverDay: text('server_day').notNull(), // 'YYYY-MM-DD', UTC
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('conversion_events_identity_unique').on(table.sessionId, table.name, table.surface, table.variant),
    // Note (2026-07-29): the single-column `conversion_events_server_day_idx`
    // was removed. PG18's planner answers `WHERE server_day BETWEEN $1 AND $2`
    // via a skip scan on the composite `(name, server_day)` index with the
    // same Index Searches count (8) and the same row count, so the single
    // column is redundant. See `scripts/db/pg18/explain-skip-scan.mjs` and
    // `plans/phase-1/03-postgres-18-upgrade/tasks.md` Phase 5 tasks 5+6.
    index('conversion_events_name_server_day_idx').on(table.name, table.serverDay),
    index('conversion_events_created_at_idx').on(table.createdAt),
    check(
      'conversion_events_name_check',
      sql`${table.name} in (
        'landing_view', 'hero_signup_click', 'hero_explore_click',
        'explore_search_complete', 'explore_signup_click', 'signup_submit', 'signup_complete'
      )`,
    ),
    check('conversion_events_surface_check', sql`${table.surface} in ('hero', 'final_cta', 'explore', 'signup')`),
    check('conversion_events_variant_check', sql`${table.variant} in ('baseline', 'treatment')`),
  ],
)

/**
 * Plan: audit-trust. A pending request to prove ownership of a public
 * profile in order to suppress it from BuilderHunt (opt-out removal — a
 * different concern from `builder_claims`, which proves ownership *to claim
 * and enrich* a profile). No plaintext email/challenge is ever persisted —
 * both are keyed-HMAC hashes (`profile-removal.ts`), and the challenge hash
 * itself is only used transiently during verification, never re-read after.
 */
export const profileRemovalRequests = pgTable(
  'profile_removal_requests',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    normalizedProfileUrl: text('normalized_profile_url').notNull(),
    requesterEmailHash: text('requester_email_hash'),
    challengeHash: text('challenge_hash').notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('profile_removal_requests_status_expires_idx').on(table.status, table.expiresAt),
    index('profile_removal_requests_source_source_id_idx').on(table.source, table.sourceId),
    check('profile_removal_requests_status_check', sql`${table.status} in ('pending', 'verified', 'rejected', 'expired')`),
  ],
)

/**
 * A verified (or legal/abuse-driven) global suppression — enforced by
 * `profile-suppression.ts` across every consumer surface (search, cache,
 * tracking, public routes, exports, feeds, alerts). Retains only the
 * minimum stable identifier needed to keep filtering the identity out;
 * `normalizedProfileUrlHash` is unkeyed-but-hashed purely to avoid storing a
 * literal URL, not a secret. Revoking a suppression is a deliberate audited
 * admin/legal action (`revokedAt`), never automatic expiry.
 */
export const profileSuppressions = pgTable(
  'profile_suppressions',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    normalizedProfileUrlHash: text('normalized_profile_url_hash').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('profile_suppressions_active_source_source_id_unique')
      .on(table.source, table.sourceId)
      .where(sql`${table.revokedAt} is null`),
    index('profile_suppressions_source_source_id_idx').on(table.source, table.sourceId),
    check('profile_suppressions_reason_check', sql`${table.reason} in ('verified-removal', 'legal', 'abuse')`),
  ],
)

// ---------------------------------------------------------------------------
// Calendar, Scheduling, and Interview Intelligence
// (plans/phase-1/44-calendar-scheduling-interview-intelligence/spec.md §Data model)
//
// Conventions from that spec's "Normative persistence contract": uuid PK with
// `gen_random_uuid()`, `organization_id text not null`, created/updated timestamptz, every
// tenant parent exposing `unique (organization_id,id)` and every tenant child referencing that
// pair via a composite FK. State/type values are `text` plus named checks, never PG enums.
// Durations and counters are non-negative integers. Authorization never lives in JSONB.
// ---------------------------------------------------------------------------

export const userCalendars = pgTable(
  'user_calendars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    color: text('color'),
    defaultReminderOffsets: integer('default_reminder_offsets').array().notNull().default(sql`'{}'::integer[]`),
    defaultReminderChannels: text('default_reminder_channels').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('user_calendars_organization_id_id_unique').on(table.organizationId, table.id),
    // "unique default per (organization_id, owner_user_id)" — partial, so a user may keep many
    // non-default calendars but never two defaults.
    uniqueIndex('user_calendars_default_unique')
      .on(table.organizationId, table.ownerUserId)
      .where(sql`${table.isDefault}`),
    index('user_calendars_owner_idx').on(table.organizationId, table.ownerUserId),
  ],
)

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id').notNull(),
    ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: text('status').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    meetingUrl: text('meeting_url'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull(),
    allDay: boolean('all_day').notNull().default(false),
    busy: boolean('busy').notNull().default(true),
    visibility: text('visibility').notNull().default('private'),
    rrule: text('rrule'),
    recurrenceUntil: timestamp('recurrence_until', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calendar_events_organization_id_id_unique').on(table.organizationId, table.id),
    // Referenced by `event_participants`'s FK-guaranteed denormalized owner column — see the
    // comment on that table for why the owner is copied down rather than joined at policy time.
    uniqueIndex('calendar_events_organization_id_owner_unique').on(table.organizationId, table.id, table.ownerUserId),
    foreignKey({
      columns: [table.organizationId, table.calendarId],
      foreignColumns: [userCalendars.organizationId, userCalendars.id],
      name: 'calendar_events_organization_calendar_fk',
    }).onDelete('cascade'),
    index('calendar_events_owner_range_idx').on(table.organizationId, table.ownerUserId, table.startsAt, table.endsAt),
    index('calendar_events_status_idx').on(table.organizationId, table.status),
    check('calendar_events_range_check', sql`${table.endsAt} > ${table.startsAt}`),
    check('calendar_events_visibility_check', sql`${table.visibility} = 'private'`),
    check('calendar_events_type_check', sql`${table.type} in ('personal', 'interview')`),
    check('calendar_events_status_check', sql`${table.status} in ('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'rescheduled', 'no_show')`),
    check('calendar_events_version_check', sql`${table.version} >= 1`),
    check('calendar_events_source_pair_check', sql`(${table.sourceType} is null) = (${table.sourceId} is null)`),
  ],
)

export const calendarEventOccurrences = pgTable(
  'calendar_event_occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    recurrenceId: text('recurrence_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('active'),
    materializationVersion: integer('materialization_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calendar_event_occurrences_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('calendar_event_occurrences_identity_unique').on(table.organizationId, table.eventId, table.recurrenceId),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [calendarEvents.organizationId, calendarEvents.id],
      name: 'calendar_event_occurrences_organization_event_fk',
    }).onDelete('cascade'),
    index('calendar_event_occurrences_range_idx').on(table.organizationId, table.startsAt, table.endsAt),
    check('calendar_event_occurrences_range_check', sql`${table.endsAt} > ${table.startsAt}`),
    check('calendar_event_occurrences_status_check', sql`${table.status} in ('active', 'cancelled')`),
    check('calendar_event_occurrences_materialization_check', sql`${table.materializationVersion} >= 1`),
  ],
)

/**
 * The durable record that one occurrence of a series was removed (spec.md: "`this` creates an
 * exception/override").
 *
 * ## Why this cannot live in `calendar_event_occurrences`
 *
 * Marking the occurrence row `status = 'cancelled'` looks like the obvious answer and does not
 * survive the next worker pass: `upsertOccurrences` writes `status: 'active'` on conflict, so the
 * cancellation is overwritten within minutes. Materialized rows are a *cache* of a pure expansion —
 * anything that must outlive a rematerialization belongs outside them. The expander already accepts
 * `exceptionInstants`; this table is what finally supplies them, instead of the hardcoded `[]` the
 * worker shipped with.
 *
 * `recurrenceId` is the occurrence's identity in the expansion (its UTC instant), the same value the
 * occurrences table keys on, so an exception and the row it suppresses are joinable without storing
 * a second timestamp that could disagree.
 */
export const calendarEventExceptions = pgTable(
  'calendar_event_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    recurrenceId: text('recurrence_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calendar_event_exceptions_organization_id_id_unique').on(table.organizationId, table.id),
    // Removing the same occurrence twice is the same fact, not a second one — an idempotent retry
    // must not accumulate rows the worker then has to deduplicate.
    uniqueIndex('calendar_event_exceptions_identity_unique').on(table.organizationId, table.eventId, table.recurrenceId),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [calendarEvents.organizationId, calendarEvents.id],
      name: 'calendar_event_exceptions_organization_event_fk',
    }).onDelete('cascade'),
  ],
)

/**
 * `eventOwnerUserId` is a deliberate denormalization of `calendar_events.owner_user_id`, kept
 * honest by a composite FK against `(organization_id, id, owner_user_id)` so it can never drift.
 * It exists for RLS: the calendar_events participant-read policy has to consult this table, so if
 * this table's own owner policy joined back to calendar_events, Postgres would reject every query
 * with "infinite recursion detected in policy". Copying the owner down breaks that cycle — this
 * table's policies read only its own columns.
 */
export const eventParticipants = pgTable(
  'event_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    eventOwnerUserId: text('event_owner_user_id').notNull(),
    userId: text('user_id').references(() => authUsers.id, { onDelete: 'cascade' }),
    externalEmail: text('external_email'),
    displayName: text('display_name'),
    role: text('role').notNull(),
    response: text('response').notNull().default('needs_action'),
    /** Calendar visibility: this attendee may see the event. `service.ts` grants it to any internal user. */
    accessGranted: boolean('access_granted').notNull().default(false),
    /**
     * Interview material: this attendee was handed the brief, report, suggestions and transcript.
     * A separate act from being on the attendee list, and never granted implicitly — the event owner
     * grants it per participant, enforced by a trigger in the migration that added this column.
     */
    materialAccessGranted: boolean('material_access_granted').notNull().default(false),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('event_participants_organization_id_id_unique').on(table.organizationId, table.id),
    // Carries `eventOwnerUserId` so the FK itself guarantees the denormalized owner matches the
    // real event owner — an inconsistent copy is not representable.
    foreignKey({
      columns: [table.organizationId, table.eventId, table.eventOwnerUserId],
      foreignColumns: [calendarEvents.organizationId, calendarEvents.id, calendarEvents.ownerUserId],
      name: 'event_participants_organization_event_fk',
    }).onDelete('cascade'),
    // "unique participant identity per event" — one row per internal user and per external email.
    uniqueIndex('event_participants_internal_identity_unique')
      .on(table.organizationId, table.eventId, table.userId)
      .where(sql`${table.userId} is not null`),
    uniqueIndex('event_participants_external_identity_unique')
      .on(table.organizationId, table.eventId, table.externalEmail)
      .where(sql`${table.externalEmail} is not null`),
    index('event_participants_user_idx').on(table.organizationId, table.userId),
    check('event_participants_identity_check', sql`(${table.userId} is null) != (${table.externalEmail} is null)`),
    check('event_participants_role_check', sql`${table.role} in ('organizer', 'attendee')`),
    check('event_participants_response_check', sql`${table.response} in ('needs_action', 'accepted', 'declined', 'tentative')`),
  ],
)

export const calendarEventReminders = pgTable(
  'calendar_event_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    participantId: uuid('participant_id'),
    channel: text('channel').notNull(),
    offsetMinutes: integer('offset_minutes').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    nextFireAt: timestamp('next_fire_at', { withTimezone: true }),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calendar_event_reminders_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [calendarEvents.organizationId, calendarEvents.id],
      name: 'calendar_event_reminders_organization_event_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.organizationId, table.participantId],
      foreignColumns: [eventParticipants.organizationId, eventParticipants.id],
      name: 'calendar_event_reminders_organization_participant_fk',
    }).onDelete('cascade'),
    // NULL participantId means "the event owner" — two NULLs never collide in a plain unique
    // index, so this pair of partial indexes is what actually enforces the spec's
    // "unique event/participant/channel/offset".
    uniqueIndex('calendar_event_reminders_participant_delivery_unique')
      .on(table.organizationId, table.eventId, table.participantId, table.channel, table.offsetMinutes)
      .where(sql`${table.participantId} is not null`),
    uniqueIndex('calendar_event_reminders_owner_delivery_unique')
      .on(table.organizationId, table.eventId, table.channel, table.offsetMinutes)
      .where(sql`${table.participantId} is null`),
    index('calendar_event_reminders_next_fire_idx').on(table.state, table.nextFireAt),
    check('calendar_event_reminders_channel_check', sql`${table.channel} in ('email', 'in_app')`),
    check('calendar_event_reminders_offset_check', sql`${table.offsetMinutes} in (0, 5, 10, 15, 30, 60, 1440, 10080)`),
    check('calendar_event_reminders_state_check', sql`${table.state} in ('pending', 'sent', 'failed', 'cancelled')`),
    check('calendar_event_reminders_attempts_check', sql`${table.attempts} >= 0`),
  ],
)

export const calendarNotificationDeliveries = pgTable(
  'calendar_notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    /**
     * Nullable, because not every delivery is about an event. The `kind` check has always allowed
     * `'invitation'`, but an invitation email is sent before anything is booked and the event is
     * created at booking — so requiring an event here made the one kind the column list already
     * named impossible to store. Exactly one anchor is required by the check below.
     */
    eventId: uuid('event_id'),
    invitationId: uuid('invitation_id'),
    reminderId: uuid('reminder_id'),
    kind: text('kind').notNull(),
    recipientUserId: text('recipient_user_id').references(() => authUsers.id, { onDelete: 'cascade' }),
    externalRecipientHash: text('external_recipient_hash'),
    idempotencyKey: text('idempotency_key').notNull(),
    providerReference: text('provider_reference'),
    state: text('state').notNull().default('pending'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calendar_notification_deliveries_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('calendar_notification_deliveries_idempotency_key_unique').on(table.idempotencyKey),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [calendarEvents.organizationId, calendarEvents.id],
      name: 'calendar_notification_deliveries_organization_event_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.organizationId, table.reminderId],
      foreignColumns: [calendarEventReminders.organizationId, calendarEventReminders.id],
      name: 'calendar_notification_deliveries_organization_reminder_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.organizationId, table.invitationId],
      foreignColumns: [schedulingInvitations.organizationId, schedulingInvitations.id],
      name: 'calendar_notification_deliveries_organization_invitation_fk',
    }).onDelete('cascade'),
    // A delivery has to be about something. Deliberately "at least one" rather than "exactly one":
    // a booking confirmation belongs to both the event it created and the invitation it came from,
    // and forcing a choice there would lose a link worth keeping.
    check(
      'calendar_notification_deliveries_anchor_check',
      sql`${table.eventId} is not null or ${table.invitationId} is not null`,
    ),
    index('calendar_notification_deliveries_recipient_idx').on(table.organizationId, table.recipientUserId, table.readAt),
    check('calendar_notification_deliveries_kind_check', sql`${table.kind} in ('reminder', 'invitation', 'reschedule', 'cancellation')`),
    check('calendar_notification_deliveries_state_check', sql`${table.state} in ('pending', 'sent', 'failed')`),
    check('calendar_notification_deliveries_recipient_check', sql`(${table.recipientUserId} is null) != (${table.externalRecipientHash} is null)`),
  ],
)

export const availabilityRules = pgTable(
  'availability_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    timezone: text('timezone').notNull(),
    weekdays: integer('weekdays').array().notNull(),
    localStart: time('local_start').notNull(),
    localEnd: time('local_end').notNull(),
    effectiveFrom: date('effective_from'),
    effectiveUntil: date('effective_until'),
    slotMinutes: integer('slot_minutes').notNull(),
    bufferBeforeMinutes: integer('buffer_before_minutes').notNull().default(0),
    bufferAfterMinutes: integer('buffer_after_minutes').notNull().default(0),
    minNoticeMinutes: integer('min_notice_minutes').notNull().default(0),
    horizonDays: integer('horizon_days').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('availability_rules_organization_id_id_unique').on(table.organizationId, table.id),
    index('availability_rules_owner_idx').on(table.organizationId, table.ownerUserId, table.enabled),
    // "no overnight rule" — a rule must open and close on the same local day.
    check('availability_rules_local_range_check', sql`${table.localEnd} > ${table.localStart}`),
    check('availability_rules_bounds_check', sql`${table.slotMinutes} > 0 and ${table.bufferBeforeMinutes} >= 0 and ${table.bufferAfterMinutes} >= 0 and ${table.minNoticeMinutes} >= 0 and ${table.horizonDays} > 0`),
    check('availability_rules_effective_range_check', sql`${table.effectiveUntil} is null or ${table.effectiveFrom} is null or ${table.effectiveUntil} >= ${table.effectiveFrom}`),
  ],
)

/**
 * Per-owner availability policy header (plan: calendar-scheduling-interview-intelligence,
 * Phase 3 "Add availability APIs").
 *
 * `availability_rules` and `availability_overrides` hold the *contents* of a policy but have
 * nowhere to record a version or the owner's default reminder preferences, both of which
 * `putAvailabilityRequestSchema` requires. Deriving a version from the contents would not work:
 * two clients that both delete rule A and add rule B produce the same content and would both
 * think they won. A monotonic counter on a single row per owner is what makes a concurrent
 * overwrite detectable.
 */
export const availabilityPolicies = pgTable(
  'availability_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    defaultReminderOffsets: integer('default_reminder_offsets').array().notNull().default([]),
    defaultReminderChannels: text('default_reminder_channels').array().notNull().default([]),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('availability_policies_organization_id_id_unique').on(table.organizationId, table.id),
    // One policy per owner per organization — the row IS the owner's policy identity.
    uniqueIndex('availability_policies_owner_unique').on(table.organizationId, table.ownerUserId),
    check('availability_policies_version_check', sql`${table.version} >= 1`),
  ],
)

export const availabilityOverrides = pgTable(
  'availability_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    localDate: date('local_date').notNull(),
    localStart: time('local_start'),
    localEnd: time('local_end'),
    kind: text('kind').notNull(),
    timezone: text('timezone').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('availability_overrides_organization_id_id_unique').on(table.organizationId, table.id),
    index('availability_overrides_owner_date_idx').on(table.organizationId, table.ownerUserId, table.localDate),
    check('availability_overrides_kind_check', sql`${table.kind} in ('available', 'blocked')`),
    // "blocked-day rows have null times, available rows require valid times"
    check(
      'availability_overrides_times_check',
      sql`(${table.kind} = 'blocked' and ${table.localStart} is null and ${table.localEnd} is null) or (${table.kind} = 'available' and ${table.localStart} is not null and ${table.localEnd} is not null and ${table.localEnd} > ${table.localStart})`,
    ),
  ],
)

export const schedulingInvitations = pgTable(
  'scheduling_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    organizationBuilderId: text('organization_builder_id'),
    /**
     * Where the invitation is sent. Not in spec.md's column list for this table, but the API
     * contract requires it: `POST /api/scheduling/invitations` accepts a candidate email and
     * `POST .../send` carries only a version and an idempotency key, so the address has to survive
     * between the two calls and the invitation is the only row that exists in that window.
     *
     * Nullable, because an invitation for a tracked builder resolves its recipient from
     * `organization_builders` instead, and duplicating the address there would give the same person
     * two records that can disagree.
     */
    candidateEmailNormalized: text('candidate_email_normalized'),
    roleTitle: text('role_title').notNull(),
    roleContext: text('role_context').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    timezone: text('timezone').notNull(),
    modality: text('modality').notNull(),
    meetingUrl: text('meeting_url'),
    location: text('location'),
    status: text('status').notNull().default('draft'),
    /**
     * SHA-256 of the candidate's link secret, or NULL while the invitation is still a draft.
     *
     * Nullable on purpose: the secret is minted at send, not at create, so that it exists only
     * while the invitation email is being composed and nothing can reproduce it afterwards. A
     * draft has no candidate-facing link, so it has no hash either — see the header of
     * lib/scheduling/invitation-service.ts.
     */
    capabilityHash: text('capability_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    bookedAt: timestamp('booked_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    bookedEventId: uuid('booked_event_id'),
    rescheduleCount: integer('reschedule_count').notNull().default(0),
    policyVersion: text('policy_version').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('scheduling_invitations_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('scheduling_invitations_capability_hash_unique').on(table.capabilityHash),
    // A row a candidate could have acted on must carry a capability. Only a draft, or a terminal
    // state a draft reached without ever being sent, may have none — so this cannot be expressed as
    // "draft xor hash".
    check(
      'scheduling_invitations_capability_presence_check',
      sql`${table.capabilityHash} is not null or ${table.status} in ('draft', 'revoked', 'expired')`,
    ),
    foreignKey({
      columns: [table.organizationId, table.organizationBuilderId],
      foreignColumns: [organizationBuilders.organizationId, organizationBuilders.id],
      name: 'scheduling_invitations_organization_builder_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.organizationId, table.bookedEventId],
      foreignColumns: [calendarEvents.organizationId, calendarEvents.id],
      name: 'scheduling_invitations_organization_booked_event_fk',
    }).onDelete('set null'),
    index('scheduling_invitations_owner_status_idx').on(table.organizationId, table.ownerUserId, table.status),
    index('scheduling_invitations_expiry_idx').on(table.status, table.expiresAt),
    check('scheduling_invitations_status_check', sql`${table.status} in ('draft', 'sent', 'opened', 'booked', 'declined', 'expired', 'revoked')`),
    check('scheduling_invitations_modality_check', sql`${table.modality} in ('in_person', 'remote_call')`),
    check('scheduling_invitations_duration_check', sql`${table.durationMinutes} > 0 and ${table.durationMinutes} <= 480`),
    check('scheduling_invitations_counters_check', sql`${table.rescheduleCount} >= 0 and ${table.version} >= 1`),
  ],
)

export const candidateSubmissions = pgTable(
  'candidate_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    invitationId: uuid('invitation_id').notNull(),
    displayName: text('display_name').notNull(),
    emailNormalized: text('email_normalized').notNull(),
    notes: text('notes'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('candidate_submissions_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('candidate_submissions_invitation_id_unique').on(table.invitationId),
    foreignKey({
      columns: [table.organizationId, table.invitationId],
      foreignColumns: [schedulingInvitations.organizationId, schedulingInvitations.id],
      name: 'candidate_submissions_organization_invitation_fk',
    }).onDelete('cascade'),
    index('candidate_submissions_retention_idx').on(table.retentionExpiresAt),
  ],
)

export const candidateLinks = pgTable(
  'candidate_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id').notNull(),
    url: text('url').notNull(),
    normalizedUrl: text('normalized_url').notNull(),
    sourceType: text('source_type').notNull(),
    acquisitionMode: text('acquisition_mode').notNull(),
    authorizationNoticeVersion: text('authorization_notice_version'),
    authorizationAttestedAt: timestamp('authorization_attested_at', { withTimezone: true }),
    policyDecision: text('policy_decision').notNull().default('not_importable'),
    importState: text('import_state').notNull().default('not_requested'),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('candidate_links_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('candidate_links_submission_normalized_url_unique').on(table.organizationId, table.submissionId, table.normalizedUrl),
    foreignKey({
      columns: [table.organizationId, table.submissionId],
      foreignColumns: [candidateSubmissions.organizationId, candidateSubmissions.id],
      name: 'candidate_links_organization_submission_fk',
    }).onDelete('cascade'),
    index('candidate_links_import_state_idx').on(table.organizationId, table.importState),
    check('candidate_links_acquisition_mode_check', sql`${table.acquisitionMode} in ('official_api', 'authorized_crawl', 'user_submitted')`),
    check('candidate_links_policy_decision_check', sql`${table.policyDecision} in ('official_api', 'authorized_crawl', 'user_submitted', 'not_importable')`),
    check('candidate_links_import_state_check', sql`${table.importState} in ('not_requested', 'queued', 'running', 'succeeded', 'failed', 'not_importable')`),
    // An `authorized_crawl` decision requires the candidate's versioned attestation on file.
    check(
      'candidate_links_attestation_check',
      sql`${table.policyDecision} != 'authorized_crawl' or (${table.authorizationNoticeVersion} is not null and ${table.authorizationAttestedAt} is not null)`,
    ),
  ],
)

/**
 * Candidate-uploaded documents (spec.md §Data model `candidate_documents`).
 *
 * `objectKey` is generated server-side and is the ONLY handle to the bytes: there is deliberately
 * no public URL column, because a URL that exists is a URL that leaks. Storage is private MinIO
 * (see docs/operations/interview-provider-register.md), reached through a signed, short-lived
 * request minted per download.
 *
 * `declaredMediaType` is what the browser claimed and `detectedMediaType` is what sniffing found;
 * both are kept because a mismatch is itself a signal, and only the detected one may be trusted.
 * Audio types are rejected outright — this table is for CVs and portfolios, and accepting audio
 * here would route recordings around the consent gate that governs interview capture.
 */
export const candidateDocuments = pgTable(
  'candidate_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id').notNull(),
    objectKey: text('object_key').notNull(),
    originalName: text('original_name').notNull(),
    declaredMediaType: text('declared_media_type').notNull(),
    detectedMediaType: text('detected_media_type'),
    /**
     * Null only while `scan_status = 'awaiting_upload'`. The candidate computes the hash from the
     * bytes they actually sent, which does not exist when the row is created to reserve the upload
     * slot and the quota. `candidate_documents_sha256_present_check` makes the window exact rather
     * than leaving the column loosely nullable forever.
     */
    sha256: text('sha256'),
    bytes: integer('bytes').notNull(),
    scanStatus: text('scan_status').notNull().default('awaiting_upload'),
    extractionStatus: text('extraction_status').notNull().default('pending'),
    /**
     * How many times the worker has leased this document for each stage.
     *
     * Persisted rather than held in the worker, because the retry cap is the
     * only thing separating "try again later" from an infinite loop: a
     * transient failure returns the row to `pending`, and without a durable
     * count an object the scanner can never read would be re-leased and
     * re-scanned forever, at real cost, with nothing to show it.
     */
    scanAttempts: integer('scan_attempts').notNull().default(0),
    extractionAttempts: integer('extraction_attempts').notNull().default(0),
    rejectionCode: text('rejection_code'),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('candidate_documents_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('candidate_documents_object_key_unique').on(table.objectKey),
    foreignKey({
      columns: [table.organizationId, table.submissionId],
      foreignColumns: [candidateSubmissions.organizationId, candidateSubmissions.id],
      name: 'candidate_documents_organization_submission_fk',
    }).onDelete('cascade'),
    index('candidate_documents_submission_idx').on(table.organizationId, table.submissionId),
    index('candidate_documents_scan_status_idx').on(table.scanStatus),
    index('candidate_documents_retention_idx').on(table.retentionExpiresAt),
    // `awaiting_upload` is the state a row is created in: the slot and the quota are reserved before
    // any bytes exist. The worker only ever leases `pending`, so a row cannot be scanned before the
    // completion call has confirmed what was actually written.
    check('candidate_documents_scan_status_check', sql`${table.scanStatus} in ('awaiting_upload', 'pending', 'scanning', 'clean', 'infected', 'failed')`),
    check('candidate_documents_extraction_status_check', sql`${table.extractionStatus} in ('pending', 'running', 'succeeded', 'failed', 'skipped')`),
    check('candidate_documents_bytes_check', sql`${table.bytes} > 0`),
    check('candidate_documents_sha256_check', sql`${table.sha256} is null or ${table.sha256} ~ '^[a-f0-9]{64}$'`),
    // The nullable window is exactly one state wide. Without this the column would be loosely
    // nullable forever and a scanned document could carry no hash at all.
    check('candidate_documents_sha256_present_check', sql`${table.scanStatus} = 'awaiting_upload' or ${table.sha256} is not null`),
    // No audio: recordings belong to the consent-gated interview capture path, never to an upload.
    check('candidate_documents_no_audio_check', sql`${table.declaredMediaType} not like 'audio/%' and (${table.detectedMediaType} is null or ${table.detectedMediaType} not like 'audio/%')`),
    // A rejection needs a reason, and a clean document must not carry one.
    check('candidate_documents_rejection_check', sql`(${table.scanStatus} in ('infected', 'failed')) = (${table.rejectionCode} is not null)`),
  ],
)

/**
 * Parsed text extracted from a document (spec.md §Data model `document_extractions`).
 *
 * Keyed by (document, parser version, content hash) so re-running a newer parser over the same
 * bytes adds a row rather than overwriting the text a brief may already cite. `evidenceMap` is the
 * section/page index every generated claim has to point back at — without it a brief can assert
 * something the document never said and nobody can tell.
 */
export const documentExtractions = pgTable(
  'document_extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').notNull(),
    parser: text('parser').notNull(),
    parserVersion: text('parser_version').notNull(),
    contentSha256: text('content_sha256').notNull(),
    plainText: text('plain_text'),
    evidenceMap: jsonb('evidence_map').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('pending'),
    errorCode: text('error_code'),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('document_extractions_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('document_extractions_document_parser_content_unique')
      .on(table.organizationId, table.documentId, table.parserVersion, table.contentSha256),
    foreignKey({
      columns: [table.organizationId, table.documentId],
      foreignColumns: [candidateDocuments.organizationId, candidateDocuments.id],
      name: 'document_extractions_organization_document_fk',
    }).onDelete('cascade'),
    index('document_extractions_status_idx').on(table.status),
    index('document_extractions_retention_idx').on(table.retentionExpiresAt),
    check('document_extractions_status_check', sql`${table.status} in ('pending', 'running', 'succeeded', 'failed')`),
    check('document_extractions_content_sha256_check', sql`${table.contentSha256} ~ '^[a-f0-9]{64}$'`),
    // A failure carries a code and no text; a success carries text and no code.
    check('document_extractions_outcome_check', sql`(${table.status} = 'failed') = (${table.errorCode} is not null)`),
  ],
)

/**
 * A fetched candidate link (spec.md §Data model `candidate_web_imports`).
 *
 * The response HTML is transient by design and has no column here: it is never rendered and never
 * retained, so only the hashes, the bounded extracted text and the evidence map survive the fetch.
 * `robotsResult` is stored rather than inferred because "we were allowed to fetch this" is a claim
 * that has to be auditable after the fact, when robots.txt has since changed.
 */
/**
 * Versioned interview briefs (plan: calendar-scheduling-interview-intelligence, Phase 8).
 *
 * ## No model envelope, ever
 *
 * There is no `prompt`, no `raw_response`, no `messages` column, and that absence is the design. The
 * prompt contains the candidate's CV and the response contains an assessment of a named person; a
 * stored envelope would be a second copy of both, in a table with different access rules from the
 * documents it was assembled from, outliving the retention the candidate was told about. What is kept
 * is the *validated* content, the manifest of what was cited, and enough provenance
 * (`provider`/`model`/`promptVersion`) to answer "which model wrote this, under which prompt".
 *
 * ## Versions accumulate; they do not overwrite
 *
 * A regenerated brief is a new row at the next version, and the previous one becomes `superseded`.
 * Overwriting would silently change text an organizer may already have read, quoted in a decision, or
 * cited to a colleague — and would make `edited_by_user_id` a lie, because the row would no longer be
 * the thing that person edited.
 */
export const interviewBriefs = pgTable(
  'interview_briefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    /** The organizer the brief belongs to. Copied rather than joined so RLS can decide without a hop. */
    ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('draft'),
    /** Validated against `interviewBriefContentSchema` before it is written — never raw model output. */
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    /** Every source the brief was allowed to cite, with the ids its claims reference. */
    evidenceManifest: jsonb('evidence_manifest').$type<unknown[]>().notNull().default([]),
    /** Null on a deterministic fallback brief, which is assembled without a model at all. */
    provider: text('provider'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    /** Set when a human edited this version's content. Null on a freshly generated one. */
    editedByUserId: text('edited_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('interview_briefs_organization_id_id_unique').on(table.organizationId, table.id),
    // One row per version per event. This is what makes "regenerate" an insert rather than a race:
    // two concurrent generations cannot both claim version 3.
    uniqueIndex('interview_briefs_event_version_unique').on(table.organizationId, table.eventId, table.version),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [calendarEvents.organizationId, calendarEvents.id],
      name: 'interview_briefs_organization_event_fk',
    }).onDelete('cascade'),
    index('interview_briefs_event_idx').on(table.organizationId, table.eventId),
    index('interview_briefs_retention_idx').on(table.retentionExpiresAt),
    check('interview_briefs_status_check', sql`${table.status} in ('draft', 'active', 'superseded')`),
    check('interview_briefs_version_check', sql`${table.version} > 0`),
    // Provenance is all-or-nothing: a brief either came from a model — in which case we can say which
    // one, under which prompt — or it is the deterministic fallback and says so by carrying none. A
    // half-filled provenance would leave "which model wrote this" unanswerable for that row.
    check(
      'interview_briefs_provenance_check',
      sql`(${table.provider} is null and ${table.model} is null and ${table.promptVersion} is null)
          or (${table.provider} is not null and ${table.model} is not null and ${table.promptVersion} is not null)`,
    ),
  ],
)

/**
 * Live interview persistence (plan: calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## There is no audio column, in any of these four tables
 *
 * No blob, no storage key, no object reference, no duration-of-a-file. Transcription is streamed to the
 * provider and only the resulting *text* is persisted — spec.md calls the audio "transient", and the
 * consent a candidate gives is for transient live transcription, not for a recording. A column here that
 * could hold or point at audio would make that consent inaccurate the moment someone used it, so
 * `scripts/db/audit-schema.ts` asserts none of these tables gains an audio-like column.
 *
 * `provider_billed_seconds` is a *usage* figure for settlement, not a pointer to anything.
 */
export const interviewSessions = pgTable(
  'interview_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('not_started'),
    captureMode: text('capture_mode').notNull(),
    language: text('language').notNull(),
    provider: text('provider').notNull(),
    /** Which notice the organizer's verbal reminder was given against. Not the candidate's consent row. */
    consentNoticeVersion: text('consent_notice_version').notNull(),
    browserName: text('browser_name'),
    browserMajor: text('browser_major'),
    captureCapability: text('capture_capability').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Last sign of life from the live client. A stale one is how an abandoned session is reclaimed. */
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    providerRequestId: text('provider_request_id'),
    providerBilledSeconds: integer('provider_billed_seconds').notNull().default(0),
    /** Optimistic concurrency for the transition API: two tabs must not both move the session. */
    version: integer('version').notNull().default(1),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('interview_sessions_organization_id_id_unique').on(table.organizationId, table.id),
    // One session per event. A second live session on the same interview would produce two transcripts
    // nobody could reconcile, and two provider bills for one conversation.
    uniqueIndex('interview_sessions_event_unique').on(table.organizationId, table.eventId),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [calendarEvents.organizationId, calendarEvents.id],
      name: 'interview_sessions_organization_event_fk',
    }).onDelete('cascade'),
    index('interview_sessions_state_idx').on(table.organizationId, table.state),
    index('interview_sessions_heartbeat_idx').on(table.heartbeatAt),
    index('interview_sessions_retention_idx').on(table.retentionExpiresAt),
    check('interview_sessions_state_check', sql`${table.state} in ('not_started', 'consent_pending', 'ready', 'live', 'processing', 'review', 'finalized', 'paused', 'failed', 'abandoned')`),
    check('interview_sessions_capture_mode_check', sql`${table.captureMode} in ('in_person', 'remote_call')`),
    check('interview_sessions_language_check', sql`${table.language} in ('en', 'da')`),
    check('interview_sessions_capability_check', sql`${table.captureCapability} in ('microphone_and_shared_audio_available', 'microphone_only', 'audio_capture_unsupported')`),
    check('interview_sessions_billed_seconds_check', sql`${table.providerBilledSeconds} >= 0`),
    check('interview_sessions_version_check', sql`${table.version} > 0`),
    // `finished_at` only on a terminal state, and every terminal state has one. Without this a
    // "finalized" session with no finish time would settle against an unbounded duration.
    check(
      'interview_sessions_finished_check',
      sql`(${table.state} in ('finalized', 'failed', 'abandoned')) = (${table.finishedAt} is not null)`,
    ),
  ],
)

/**
 * One final transcript segment. Interim text is never persisted — it is replaced within seconds and
 * storing it would multiply a candidate's words several times over for no benefit.
 */
export const transcriptSegments = pgTable(
  'transcript_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    /** The provider's own id for this segment. What makes re-delivery idempotent. */
    providerSegmentId: text('provider_segment_id').notNull(),
    sequence: integer('sequence').notNull(),
    speakerEstimate: text('speaker_estimate').notNull(),
    /** Null until an organizer confirms or corrects who the estimate refers to. */
    speakerMapping: text('speaker_mapping'),
    text: text('text').notNull(),
    startsMs: integer('starts_ms').notNull(),
    endsMs: integer('ends_ms').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    correctedByUserId: text('corrected_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('transcript_segments_organization_id_id_unique').on(table.organizationId, table.id),
    // Exactly-once persistence under a retrying client: the outbox resends unacknowledged segments, and
    // this is what makes a resend a no-op rather than a duplicate line in the transcript.
    uniqueIndex('transcript_segments_provider_unique').on(table.organizationId, table.sessionId, table.providerSegmentId),
    uniqueIndex('transcript_segments_sequence_unique').on(table.organizationId, table.sessionId, table.sequence),
    foreignKey({
      columns: [table.organizationId, table.sessionId],
      foreignColumns: [interviewSessions.organizationId, interviewSessions.id],
      name: 'transcript_segments_organization_session_fk',
    }).onDelete('cascade'),
    index('transcript_segments_session_idx').on(table.organizationId, table.sessionId, table.sequence),
    index('transcript_segments_retention_idx').on(table.retentionExpiresAt),
    check('transcript_segments_speaker_estimate_check', sql`${table.speakerEstimate} in ('speaker_a', 'speaker_b', 'unknown')`),
    check('transcript_segments_speaker_mapping_check', sql`${table.speakerMapping} is null or ${table.speakerMapping} in ('organizer', 'candidate_or_remote')`),
    check('transcript_segments_sequence_check', sql`${table.sequence} >= 0`),
    check('transcript_segments_timing_check', sql`${table.startsMs} >= 0 and ${table.endsMs} > ${table.startsMs}`),
    check('transcript_segments_confidence_check', sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`),
    // A correction without an author is unattributable, and an author without a time is unorderable.
    // The pair is the audit trail for "a human changed what the machine heard".
    check(
      'transcript_segments_correction_check',
      sql`(${table.correctedByUserId} is null) = (${table.correctedAt} is null)`,
    ),
  ],
)

/**
 * Contextual follow-up questions produced during a live interview.
 *
 * Ephemeral by default — spec.md: "the result is ephemeral unless explicitly saved or used" — so a row
 * exists here only once the organizer acted on it. `evidence_segment_ids` points at the segments that
 * prompted it, so a question can always be traced back to what was actually said.
 */
export const interviewSuggestions = pgTable(
  'interview_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    sequence: integer('sequence').notNull(),
    question: text('question').notNull(),
    rationale: text('rationale').notNull(),
    evidenceSegmentIds: jsonb('evidence_segment_ids').$type<string[]>().notNull().default([]),
    state: text('state').notNull().default('proposed'),
    promptVersion: text('prompt_version').notNull(),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('interview_suggestions_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('interview_suggestions_sequence_unique').on(table.organizationId, table.sessionId, table.sequence),
    foreignKey({
      columns: [table.organizationId, table.sessionId],
      foreignColumns: [interviewSessions.organizationId, interviewSessions.id],
      name: 'interview_suggestions_organization_session_fk',
    }).onDelete('cascade'),
    index('interview_suggestions_session_idx').on(table.organizationId, table.sessionId),
    index('interview_suggestions_retention_idx').on(table.retentionExpiresAt),
    check('interview_suggestions_state_check', sql`${table.state} in ('proposed', 'used', 'saved', 'dismissed')`),
    check('interview_suggestions_sequence_check', sql`${table.sequence} >= 0`),
  ],
)

/**
 * The post-interview report. Keyed to the event rather than the session: a report survives its session
 * being reclaimed, and an interview conducted manually has a report with no session at all.
 */
export const interviewReports = pgTable(
  'interview_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    ownerUserId: text('owner_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('draft'),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    /** The segments the report's statements cite. Null-safe default so a manual report can carry none. */
    evidenceSegmentIds: jsonb('evidence_segment_ids').$type<string[]>().notNull().default([]),
    provider: text('provider'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    editedByUserId: text('edited_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('interview_reports_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('interview_reports_event_version_unique').on(table.organizationId, table.eventId, table.version),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [calendarEvents.organizationId, calendarEvents.id],
      name: 'interview_reports_organization_event_fk',
    }).onDelete('cascade'),
    index('interview_reports_event_idx').on(table.organizationId, table.eventId),
    index('interview_reports_retention_idx').on(table.retentionExpiresAt),
    check('interview_reports_status_check', sql`${table.status} in ('draft', 'final')`),
    check('interview_reports_version_check', sql`${table.version} > 0`),
    // Same all-or-nothing provenance as `interview_briefs`: either a model wrote it and we can say
    // which, or it is manual and carries none.
    check(
      'interview_reports_provenance_check',
      sql`(${table.provider} is null and ${table.model} is null and ${table.promptVersion} is null)
          or (${table.provider} is not null and ${table.model} is not null and ${table.promptVersion} is not null)`,
    ),
    // `final` and `finalized_at` move together, mirroring `interviewReportSchema`'s own refinement.
    check('interview_reports_finalized_check', sql`(${table.status} = 'final') = (${table.finalizedAt} is not null)`),
  ],
)

export const candidateWebImports = pgTable(
  'candidate_web_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    candidateLinkId: uuid('candidate_link_id').notNull(),
    finalUrl: text('final_url').notNull(),
    sourcePolicyVersion: text('source_policy_version').notNull(),
    robotsResult: text('robots_result').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    httpEtag: text('http_etag'),
    httpLastModified: text('http_last_modified'),
    responseSha256: text('response_sha256'),
    contentSha256: text('content_sha256'),
    mediaType: text('media_type'),
    bytes: integer('bytes'),
    extractionVersion: text('extraction_version'),
    extractedText: text('extracted_text'),
    evidenceMap: jsonb('evidence_map').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('pending'),
    errorCode: text('error_code'),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('candidate_web_imports_organization_id_id_unique').on(table.organizationId, table.id),
    // One active import per link and content hash: a re-fetch that returns identical bytes must not
    // create a second row a brief could cite twice.
    uniqueIndex('candidate_web_imports_link_content_unique')
      .on(table.organizationId, table.candidateLinkId, table.contentSha256),
    foreignKey({
      columns: [table.organizationId, table.candidateLinkId],
      foreignColumns: [candidateLinks.organizationId, candidateLinks.id],
      name: 'candidate_web_imports_organization_link_fk',
    }).onDelete('cascade'),
    index('candidate_web_imports_status_idx').on(table.status),
    index('candidate_web_imports_retention_idx').on(table.retentionExpiresAt),
    check('candidate_web_imports_status_check', sql`${table.status} in ('pending', 'running', 'succeeded', 'failed', 'blocked')`),
    check('candidate_web_imports_robots_result_check', sql`${table.robotsResult} in ('allowed', 'disallowed', 'unavailable')`),
    check('candidate_web_imports_outcome_check', sql`(${table.status} in ('failed', 'blocked')) = (${table.errorCode} is not null)`),
    check('candidate_web_imports_bytes_check', sql`${table.bytes} is null or ${table.bytes} >= 0`),
  ],
)

/**
 * Append-only consent ledger (spec.md §Data model `privacy_consents`, §"Consent, privacy, and
 * retention").
 *
 * Brought forward from Phase 6 because atomic booking cannot be built without it: booking must
 * "verify current individual consent receipts for every required purpose" and return
 * `422 consent_required` otherwise, so the receipts have to exist first. Only this table is pulled
 * forward — the candidate-document tables stay in Phase 6 where they belong.
 *
 * Append-only is the whole point. A withdrawal does not delete or rewrite the grant it revokes: it
 * stamps `withdrawn_at` on the row, so the record of "this person did consent, on this notice
 * version, at this instant" survives. A changed decision inserts a new row pointing at the old one
 * through `supersedes_id`. Consent is the lawful basis for processing that already happened; a
 * ledger that can be edited is not evidence of anything.
 *
 * `subject_email_hash` rather than the address: the ledger is queried by subject, never used to
 * contact them, so it does not need to hold the identifier in the clear.
 */
export const privacyConsents = pgTable(
  'privacy_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    invitationId: uuid('invitation_id').notNull(),
    sessionId: uuid('session_id'),
    subjectEmailHash: text('subject_email_hash').notNull(),
    purpose: text('purpose').notNull(),
    noticeVersion: text('notice_version').notNull(),
    decision: text('decision').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    requestEvidenceHash: text('request_evidence_hash').notNull(),
    supersedesId: uuid('supersedes_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('privacy_consents_organization_id_id_unique').on(table.organizationId, table.id),
    /**
     * The idempotency key from spec.md. A double-submitted booking form must not append a second
     * identical grant: same subject, same purpose, same notice version, same decision is the same
     * act of consent, so the retry conflicts instead of inflating the ledger.
     */
    uniqueIndex('privacy_consents_subject_purpose_notice_decision_unique')
      .on(table.organizationId, table.invitationId, table.subjectEmailHash, table.purpose, table.noticeVersion, table.decision),
    foreignKey({
      columns: [table.organizationId, table.invitationId],
      foreignColumns: [schedulingInvitations.organizationId, schedulingInvitations.id],
      name: 'privacy_consents_organization_invitation_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.organizationId, table.supersedesId],
      foreignColumns: [table.organizationId, table.id],
      name: 'privacy_consents_organization_supersedes_fk',
    }).onDelete('set null'),
    index('privacy_consents_invitation_purpose_idx').on(table.organizationId, table.invitationId, table.purpose),
    index('privacy_consents_subject_idx').on(table.organizationId, table.subjectEmailHash),
    check('privacy_consents_purpose_check', sql`${table.purpose} in ('terms_and_privacy', 'candidate_document_processing', 'public_web_import', 'ai_interview_assistance', 'live_audio_transcription')`),
    check('privacy_consents_decision_check', sql`${table.decision} in ('accepted', 'declined')`),
    /**
     * A declined purpose was never granted, so there is nothing to withdraw. Without this check a
     * `declined` row could be stamped `withdrawn_at` and read back as "was accepted, then revoked",
     * which inverts the record.
     */
    check('privacy_consents_withdrawal_check', sql`${table.withdrawnAt} is null or ${table.decision} = 'accepted'`),
    check('privacy_consents_supersedes_self_check', sql`${table.supersedesId} is null or ${table.supersedesId} != ${table.id}`),
  ],
)

/**
 * System-operational scheduling and run history (spec.md §Data model → "Operations and usage").
 * These are NOT tenant tables: a job identity is stable and platform-owned, not owned by any one
 * organization, so they carry no `organization_id` and get no RLS — access is controlled entirely
 * by per-role GRANT (same reasoning as `status_checks`, `conversion_events`, and the
 * profile-removal tables). The calendar feed exposes them only as redacted, read-only
 * `job_projection`/`job_run` DTOs (spec.md §Calendar projection contract), never as editable rows.
 */
export const operationalSchedules = pgTable(
  'operational_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobKey: text('job_key').notNull(),
    cronExpression: text('cron_expression').notNull(),
    timezone: text('timezone').notNull(),
    scope: text('scope').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    // Optimistic concurrency for the admin pause/resume mutation (plans/UI/tasks.md Wave 5 "Add
    // allowlisted pause, resume, and manual-run APIs") — two admins toggling the same job from two
    // open tabs must not silently clobber one another.
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('operational_schedules_job_key_unique').on(table.jobKey),
    index('operational_schedules_next_run_idx').on(table.enabled, table.nextRunAt),
    check('operational_schedules_scope_check', sql`${table.scope} in ('platform', 'organization')`),
  ],
)

export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id').references(() => operationalSchedules.id, { onDelete: 'set null' }),
    jobKey: text('job_key').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    state: text('state').notNull().default('scheduled'),
    processedCount: integer('processed_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    durationMs: integer('duration_ms'),
    // Redacted: a stable short code only, never a provider message or stack trace — these rows
    // are projected into a user-visible calendar feed.
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('job_runs_job_key_scheduled_idx').on(table.jobKey, table.scheduledFor),
    index('job_runs_state_idx').on(table.state, table.scheduledFor),
    check('job_runs_state_check', sql`${table.state} in ('scheduled', 'running', 'succeeded', 'failed', 'skipped')`),
    check('job_runs_counters_check', sql`${table.processedCount} >= 0 and ${table.failedCount} >= 0 and (${table.durationMs} is null or ${table.durationMs} >= 0)`),
    check('job_runs_finished_check', sql`${table.finishedAt} is null or ${table.startedAt} is not null`),
  ],
)

/**
 * Plan 28 (shared-resources) task 9 — public feed capabilities.
 *
 * A capability is a row in this table that points at a saved query
 * inside the tenant. The id is the public surface (path param), the
 * `capability_hash` is the server-side HMAC of the token the user
 * carries in the URL. Without both, the feed endpoint returns 404.
 *
 * Revocation is soft (`revoked_at`); expiry is hard (`expires_at`,
 * checked at resolve time). The composite FK to saved_queries has
 * ON DELETE CASCADE, so deleting a query takes its capabilities
 * with it; a capability can never outlive its target.
 */
export const feedCapabilities = pgTable(
  'feed_capabilities',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    queryId: text('query_id').notNull().references(() => savedQueries.id, { onDelete: 'cascade' }),
    capabilityHash: text('capability_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: false }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: false }),
    revokedAt: timestamp('revoked_at', { withTimezone: false }),
  },
  (table) => [
    unique('feed_capabilities_id_unique').on(table.id),
    unique('feed_capabilities_capability_hash_unique').on(table.capabilityHash),
    index('feed_capabilities_org_idx').on(table.organizationId),
    index('feed_capabilities_query_idx').on(table.queryId),
  ],
)

/**
 * Plan 29 (activity-feed) task 2 — organization activity log.
 *
 * Denormalized event log, not the security audit. An event is a
 * row that says "actor X did Y to target Z at time T" — nothing
 * more, nothing less. Metadata is a versioned jsonb the contract
 * in `activity/contracts.ts` validates at emit time. The feed
 * paginates by (occurred_at desc, id desc); the composite index
 * is the only thing standing between 10k rows and a 5s query.
 */
export const organizationActivity = pgTable(
  'organization_activity',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    version: integer('version').notNull(),
    targetKey: text('target_key').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: false }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: false }),
  },
  (table) => [
    unique('organization_activity_idempotency_key_unique').on(table.idempotencyKey),
    index('organization_activity_org_id_desc_idx').on(sql`${table.organizationId}, ${table.occurredAt} DESC, ${table.id} DESC`),
    index('organization_activity_expires_idx').on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
    check('organization_activity_type_known', sql`${table.type} in (
      'saved_query_created','saved_query_visibility_changed','saved_query_deleted',
      'builder_list_created','builder_list_item_added','builder_list_item_removed','builder_list_deleted',
      'builder_list_updated',
      'alert_created','feed_capability_minted','feed_capability_revoked'
    )`),
  ],
)

/**
 * Plan 47 (status-and-trust) Phase 2: incident-email subscribers.
 *
 * System-operational, no owning subject. The row is keyed by the SHA-256
 * of a random 32-byte token; the raw token only ever appears in the
 * unsubscribe URL. Auto-confirmed on subscribe (the spec asked for
 * plain-text emails on subscribe); a future double-opt-in upgrade adds
 * a confirmation step that flips `confirmed_at` instead of inserting
 * with it set.
 */
export const statusSubscribers = pgTable(
  'status_subscribers',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    /** Lowercased copy of `email` for the UNIQUE index. The original casing is kept
     *  for display in admin tooling (a real subscriber's address is what they typed). */
    emailLower: text('email_lower').notNull(),
    /** SHA-256 of the random unsubscribe token. The raw token is never stored. */
    unsubscribeTokenHash: text('unsubscribe_token_hash').notNull(),
    /** NULL until the subscriber has confirmed (auto-confirmed at subscribe time today;
     *  reserved for the double-opt-in upgrade). Unconfirmed rows never receive email. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft-cancel: when set, the row is hidden from the send list. Never deleted —
     *  keeping the history helps answer "did we email this person?" audits. */
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
  },
  (table) => [
    unique('status_subscribers_email_unique').on(table.emailLower),
    index('status_subscribers_confirmed_idx')
      .on(table.confirmedAt)
      .where(sql`${table.unsubscribedAt} IS NULL`),
  ],
)

// ---------------------------------------------------------------------------
// Solutions catalog (plan 43 — solutions-intelligence Phase 4)
//
// What a Solutions route is composed *from*: real people, generic specialist roles, agents, models,
// endpoints, MCP servers, tools and services — plus the evidence behind every claim and the typed
// edges that say what can work with what.
//
// Two rules shape all of it, both from spec.md:
//
//   1. "Versioned component metadata and evidence are immutable observations; canonical projections
//      may change." So a component has a stable identity row and an append-only series of version
//      rows. Correcting a fact means a new version, never an UPDATE of the old one — otherwise a run
//      recorded last month cannot be reproduced from the versions it cited.
//   2. "Semantic similarity can propose an edge for review but cannot activate it." Enforced as a
//      CHECK, not a convention, for the same reason `human_source_links` does it: a future code path
//      must not be able to route around the reviewer.
//
// Global-public throughout — no `organization_id` anywhere. A catalog fact is not a tenant's
// property. An organization's private opinion about a component belongs in its own tables.
// App role reads; worker and reviewed platform actions write (see the migration's grants).
// ---------------------------------------------------------------------------

/** How a source's data reaches us. Drives what the ingestion layer is allowed to do. */
export const SOLUTION_SOURCE_KINDS = [
  'official_api',
  'feed',
  'licensed_dataset',
  'user_submission',
  /** Compliant public crawl. Requires a recorded terms/robots review before it may be enabled. */
  'public_scrape',
  /** Discovery only: we link out and store no fetched content. The fallback for sources whose terms
   * prohibit ingestion — spec.md: "Route prohibited sources to external-link-only records." */
  'external_link_only',
] as const

/**
 * Operator register for the people-search connectors, so a source can be switched off from Admin →
 * Sources instead of through a deploy.
 *
 * Separate from `solutionSources` on purpose. A solutions source contributes facts about tools and its
 * risk is a wrong capability claim; a search source contributes data about *people* and its risk is
 * processing personal data without a basis. The load-bearing columns differ, so one shared table would
 * mean half of every row is NULL.
 */
export const searchSources = pgTable(
  'search_sources',
  {
    /** Matches the `source` value each connector stamps on its results, e.g. `github`. */
    key: text('key').primaryKey(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    homepageUrl: text('homepage_url').notNull(),
    /** The kill switch, read on every search — flipping it takes effect on the next query. */
    enabled: boolean('enabled').notNull().default(false),
    /**
     * Whether code exists to query this source. Not an operator toggle: "does an adapter exist" is a
     * fact about the repository, so it changes in a migration alongside the connector that lands. It
     * is a column so the constraint below can use it, and so the UI can tell "switched off" apart from
     * "nothing to switch on" rather than rendering a dead control.
     *
     * `assertSearchConnectorRegistryMatchesDatabase` keeps it honest against the code registry.
     */
    connectorImplemented: boolean('connector_implemented').notNull().default(false),
    /** Hosts this connector may contact, so the register is auditable without reading the connector. */
    allowedHosts: jsonb('allowed_hosts').$type<string[]>().default([]).notNull(),
    /** False only for `external_link_only`, and the CHECK below holds us to that. */
    storesPersonalData: boolean('stores_personal_data').notNull().default(true),
    geography: text('geography'),
    rateLimitPerHour: integer('rate_limit_per_hour'),
    retentionDays: integer('retention_days'),
    termsReviewedAt: timestamp('terms_reviewed_at', { withTimezone: true }),
    termsReviewedBy: text('terms_reviewed_by').references(() => authUsers.id, { onDelete: 'set null' }),
    registerNotes: text('register_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('search_sources_kind_check', sql`${table.kind} in ('official_api', 'feed', 'licensed_dataset', 'user_submission', 'public_scrape', 'external_link_only')`),
    /** Same legal gate as `solution_sources_scrape_needs_review_check`. */
    check(
      'search_sources_scrape_needs_review_check',
      sql`${table.kind} <> 'public_scrape' or ${table.enabled} = false or ${table.termsReviewedAt} is not null`,
    ),
    check(
      'search_sources_link_only_stores_nothing_check',
      sql`${table.kind} <> 'external_link_only' or ${table.storesPersonalData} = false`,
    ),
    /**
     * An enabled source with no connector is a promise the product cannot keep: the UI offers it, the
     * search reports it healthy, and it contributes nothing. Refuse the state rather than explain it.
     */
    check(
      'search_sources_enabled_needs_connector_check',
      sql`${table.enabled} = false or ${table.connectorImplemented} = true`,
    ),
    /** NULL retention on personal data reads as "keep forever", which is not a retention policy. */
    check(
      'search_sources_retention_check',
      sql`${table.storesPersonalData} = false or (${table.retentionDays} is not null and ${table.retentionDays} > 0)`,
    ),
    index('search_sources_enabled_idx').on(table.enabled),
  ],
)

export const solutionSources = pgTable(
  'solution_sources',
  {
    /** Stable operator-facing key, e.g. `huggingface_models`. Referenced by every fact we ingest. */
    key: text('key').primaryKey(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    homepageUrl: text('homepage_url').notNull(),
    /**
     * THE KILL SWITCH. Ships `false` for every source, including official APIs: enabling one is an
     * explicit maintainer act through Admin → Solutions sources, never a deploy side effect.
     */
    enabled: boolean('enabled').notNull().default(false),
    /** Which fields this source is allowed to contribute. Empty means nothing may be stored. */
    allowedFields: jsonb('allowed_fields').$type<string[]>().default([]).notNull(),
    geography: text('geography'),
    ownerContact: text('owner_contact'),
    rateLimitPerHour: integer('rate_limit_per_hour'),
    refreshIntervalHours: integer('refresh_interval_hours'),
    retentionDays: integer('retention_days'),
    /** When a human reviewed this source's terms, robots policy and privacy posture, and who. The
     * legal gate lives in `plans/phase-5/01-production-readiness-audit`; these two columns are where
     * its outcome is recorded, and the CHECK below makes them load-bearing rather than decorative. */
    termsReviewedAt: timestamp('terms_reviewed_at', { withTimezone: true }),
    termsReviewedBy: text('terms_reviewed_by').references(() => authUsers.id, { onDelete: 'set null' }),
    registerNotes: text('register_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('solution_sources_kind_check', sql`${table.kind} in ('official_api', 'feed', 'licensed_dataset', 'user_submission', 'public_scrape', 'external_link_only')`),
    /**
     * A scraping source cannot be enabled until its review is recorded. This is the legal gate
     * expressed as a database constraint: the admin toggle physically cannot turn on a crawl whose
     * terms nobody signed off. Other source kinds are exempt because an official API's terms are
     * accepted by holding a key.
     */
    check(
      'solution_sources_scrape_needs_review_check',
      sql`${table.kind} <> 'public_scrape' or ${table.enabled} = false or ${table.termsReviewedAt} is not null`,
    ),
    /** External-link-only means exactly that: no fields may be stored from it. */
    check(
      'solution_sources_link_only_stores_nothing_check',
      sql`${table.kind} <> 'external_link_only' or jsonb_array_length(${table.allowedFields}) = 0`,
    ),
    index('solution_sources_enabled_idx').on(table.enabled),
  ],
)

/** The capability vocabulary a brief's requirements and a component's claims are both keyed by. */
export const solutionCapabilities = pgTable('solution_capabilities', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const SOLUTION_LIFECYCLE_STATES = ['draft', 'active', 'deprecated', 'withdrawn'] as const

/** A component's stable identity. Mutable projection; the facts live in its versions. */
export const solutionComponents = pgTable(
  'solution_components',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull().$type<ComponentKind>(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    lifecycleState: text('lifecycle_state').notNull().default('draft'),
    sourceKey: text('source_key').notNull().references(() => solutionSources.key, { onDelete: 'restrict' }),
    /** This component's id at its source, when it has one. Null for generic human roles, which we
     * author rather than ingest. */
    externalId: text('external_id'),
    homepageUrl: text('homepage_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('solution_components_kind_slug_unique').on(table.kind, table.slug),
    // One component per (source, external record) so a refresh updates rather than duplicates.
    uniqueIndex('solution_components_source_external_unique')
      .on(table.sourceKey, table.externalId)
      .where(sql`external_id is not null`),
    check('solution_components_kind_check', sql`${table.kind} in ('human_profile', 'human_role', 'agent', 'model', 'model_endpoint', 'mcp_server', 'tool', 'service')`),
    check('solution_components_lifecycle_check', sql`${table.lifecycleState} in ('draft', 'active', 'deprecated', 'withdrawn')`),
    index('solution_components_kind_lifecycle_idx').on(table.kind, table.lifecycleState),
  ],
)

/**
 * Immutable versioned metadata. A correction is a new version with a new validity window, never an
 * UPDATE — a `solution_run` cites `(component_id, version)` pairs, and rewriting one retroactively
 * changes what a past recommendation claimed.
 */
export const solutionComponentVersions = pgTable(
  'solution_component_versions',
  {
    componentId: text('component_id').notNull().references(() => solutionComponents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
    contentHash: text('content_hash').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.componentId, table.version], name: 'solution_component_versions_pkey' }),
    // An unchanged refresh must not mint a version. Same discipline as builder_source_snapshots.
    uniqueIndex('solution_component_versions_content_unique').on(table.componentId, table.contentHash),
    check('solution_component_versions_validity_order_check', sql`${table.validUntil} is null or ${table.validUntil} > ${table.validFrom}`),
    index('solution_component_versions_current_idx').on(table.componentId, table.validFrom),
  ],
)

/**
 * What a component claims it can do, and how well that claim is evidenced.
 *
 * `primaryEvidenceId` is `ON DELETE RESTRICT`: a claim may never outlive the observation behind it.
 * That is the "dangling evidence" the plan's verify line asks the schema to reject — a claim whose
 * evidence has been purged is indistinguishable from an unsupported assertion.
 */
export const solutionComponentCapabilities = pgTable(
  'solution_component_capabilities',
  {
    id: text('id').primaryKey(),
    componentId: text('component_id').notNull(),
    componentVersion: integer('component_version').notNull(),
    capabilityKey: text('capability_key').notNull().references(() => solutionCapabilities.key, { onDelete: 'restrict' }),
    evidenceLevel: text('evidence_level').notNull(),
    primaryEvidenceId: text('primary_evidence_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.componentId, table.componentVersion],
      foreignColumns: [solutionComponentVersions.componentId, solutionComponentVersions.version],
      name: 'solution_component_capabilities_version_fk',
    }).onDelete('cascade'),
    uniqueIndex('solution_component_capabilities_unique').on(table.componentId, table.componentVersion, table.capabilityKey),
    check('solution_component_capabilities_level_check', sql`${table.evidenceLevel} in ('claimed', 'observed', 'verified', 'production_evidence')`),
    index('solution_component_capabilities_capability_idx').on(table.capabilityKey, table.evidenceLevel),
  ],
)

/**
 * An immutable observation that supports a capability claim or a compatibility edge.
 *
 * Never a raw upstream response body — a minimized, allowlisted payload plus the URL a reviewer can
 * go and check. `expiresAt` exists because evidence goes stale: a benchmark from two years ago is not
 * the same claim as one from last week, and the composer weighs freshness.
 */
export const solutionEvidence = pgTable(
  'solution_evidence',
  {
    id: text('id').primaryKey(),
    sourceKey: text('source_key').notNull().references(() => solutionSources.key, { onDelete: 'restrict' }),
    componentId: text('component_id').references(() => solutionComponents.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    sourceUrl: text('source_url'),
    contentHash: text('content_hash').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('solution_evidence_source_hash_unique').on(table.sourceKey, table.contentHash),
    check('solution_evidence_kind_check', sql`${table.kind} in ('official_metadata', 'benchmark', 'documentation', 'production_report', 'manual_review')`),
    check('solution_evidence_expiry_order_check', sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.observedAt}`),
    index('solution_evidence_component_idx').on(table.componentId, table.observedAt),
  ],
)

/**
 * Retrieval projections: the lexical document and filter columns retrieval actually queries, derived
 * from a component version.
 *
 * Separate from the version it describes because a version is history that must never be rewritten,
 * while a projection is a cache that is rebuilt whenever the document builder changes. The vector lane
 * is deliberately not here — it lives in `builderEmbeddings`, whose `entityKind` column exists so
 * catalog components share one embedding dimension, one HNSW index and one re-embed script with
 * builder profiles.
 */
export const solutionComponentProjections = pgTable(
  'solution_component_projections',
  {
    componentId: text('component_id').notNull(),
    version: integer('version').notNull(),
    /** Copied from `solutionComponents` so a filtered retrieval needs no join. Safe: neither value
     * changes for a given (component, version). */
    kind: text('kind').notNull(),
    sourceKey: text('source_key').notNull(),
    /** Derived prose, not raw metadata — download counts and library names would only add lexical
     * noise. Indexed by a generated `search_vector` column that cannot drift from it. */
    searchDocument: text('search_document').notNull(),
    /** Exact structured filtering. A capability requirement is array containment against this, never a
     * substring match on the document. */
    capabilityKeys: text('capability_keys').array().$type<string[]>().default([]).notNull(),
    /** Strongest evidence among this version's claims, denormalized because scoring reads it for every
     * candidate and computing it needs an aggregate. */
    maxEvidenceLevel: text('max_evidence_level').notNull(),
    /** Hash of the projection's inputs, so an unchanged rebuild writes nothing. */
    contentHash: text('content_hash').notNull(),
    /** Bumped when the document builder changes shape. The upsert refuses to go backwards on it, which
     * is what stops a job that started before a rollout from overwriting newer work. */
    projectionVersion: integer('projection_version').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    projectedAt: timestamp('projected_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.componentId, table.version] }),
    check('solution_component_projections_kind_check', sql`${table.kind} in ('human_profile', 'human_role', 'agent', 'model', 'model_endpoint', 'mcp_server', 'tool', 'service')`),
    check('solution_component_projections_evidence_check', sql`${table.maxEvidenceLevel} in ('claimed', 'observed', 'verified', 'production_evidence')`),
    check('solution_component_projections_version_positive_check', sql`${table.projectionVersion} > 0`),
    index('solution_component_projections_kind_idx').on(table.kind, table.maxEvidenceLevel),
    index('solution_component_projections_stale_idx').on(table.projectionVersion),
  ],
)

export const SOLUTION_EDGE_DISCOVERY_METHODS = ['manual_review', 'official_metadata', 'semantic_similarity_reviewed'] as const
export const SOLUTION_EDGE_STATUSES = ['proposed', 'active', 'rejected', 'expired'] as const

/**
 * Typed directed compatibility. The composer may only traverse `active` edges, so what can become
 * active is the whole safety story.
 */
export const solutionCompatibilityEdges = pgTable(
  'solution_compatibility_edges',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull().default(1),
    edgeType: text('edge_type').notNull(),
    fromComponentId: text('from_component_id').notNull().references(() => solutionComponents.id, { onDelete: 'cascade' }),
    toComponentId: text('to_component_id').notNull().references(() => solutionComponents.id, { onDelete: 'cascade' }),
    constraints: jsonb('constraints').$type<Record<string, unknown>>().default({}).notNull(),
    confidenceBps: integer('confidence_bps').notNull().default(0),
    discoveryMethod: text('discovery_method').notNull(),
    status: text('status').notNull().default('proposed'),
    /** RESTRICT, like a capability claim: an edge may never outlive its evidence. */
    primaryEvidenceId: text('primary_evidence_id').notNull().references(() => solutionEvidence.id, { onDelete: 'restrict' }),
    reviewedByUserId: text('reviewed_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('solution_edges_type_check', sql`${table.edgeType} in ('can_perform', 'requires', 'accepts_output_from', 'integrates_with', 'hosted_by', 'reviewed_by', 'incompatible_with', 'substitutes_for')`),
    check('solution_edges_discovery_check', sql`${table.discoveryMethod} in ('manual_review', 'official_metadata', 'semantic_similarity_reviewed')`),
    check('solution_edges_status_check', sql`${table.status} in ('proposed', 'active', 'rejected', 'expired')`),
    check('solution_edges_confidence_range_check', sql`${table.confidenceBps} between 0 and 10000`),
    // No relationship type is meaningful pointing at itself.
    check('solution_edges_no_self_loop_check', sql`${table.fromComponentId} <> ${table.toComponentId}`),
    check('solution_edges_validity_order_check', sql`${table.validUntil} is null or ${table.validUntil} > ${table.validFrom}`),
    /**
     * spec.md: "Semantic similarity can propose an edge for review but cannot activate it." A
     * similarity-derived edge reaching `active` requires a named reviewer — the same shape as
     * `human_source_links_probabilistic_needs_review_check`, and for the same reason: the composer
     * builds real recommendations out of active edges, so an unreviewed guess becoming active means
     * advising someone to combine two things nobody checked work together.
     */
    check(
      'solution_edges_similarity_needs_review_check',
      sql`${table.discoveryMethod} <> 'semantic_similarity_reviewed' or ${table.status} <> 'active' or ${table.reviewedByUserId} is not null`,
    ),
    /** One live edge per (from, to, type). Partial, so withdrawn and rejected history never blocks a
     * later correct edge. */
    uniqueIndex('solution_edges_active_unique')
      .on(table.fromComponentId, table.toComponentId, table.edgeType)
      .where(sql`status = 'active' and valid_until is null`),
    index('solution_edges_traversal_idx').on(table.fromComponentId, table.edgeType, table.status),
    index('solution_edges_review_queue_idx').on(table.status, table.createdAt),
  ],
)
