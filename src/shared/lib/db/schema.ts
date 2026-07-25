import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, boolean, integer, jsonb, unique, uniqueIndex, uuid, index, check, foreignKey, vector } from 'drizzle-orm/pg-core'
import { EMBEDDING_DIM } from '~/shared/lib/ai/embedding-dim'
import type { EmbeddedProfile } from '~/lib/semantic/embedding-doc'
import type { EnrichmentEvidencePayload } from '~/lib/enrichment/types'
import type { ExtractedCriteria, QueryVariant, SprintCursor, SprintProfileSnapshot } from '~/shared/lib/sprints-shared'

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

export const builderSourceSnapshots = pgTable(
  'builder_source_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
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

export const organizationBuilders = pgTable(
  'organization_builders',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    builderIdentityId: text('builder_identity_id').notNull().references(() => builderIdentities.id, { onDelete: 'restrict' }),
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
    organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
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
    organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => authUsers.id),
    name: text('name').notNull(),
    keywords: jsonb('keywords').$type<string[]>().notNull(),
    sources: jsonb('sources').$type<string[]>().default(['github']),
    language: text('language'),
    country: text('country'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    organizationIdIdUnique: uniqueIndex('saved_queries_organization_id_id_unique').on(table.organizationId, table.id),
  }),
)

export const alerts = pgTable('alerts', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => authUsers.id),
  queryId: text('query_id').references(() => savedQueries.id),
  name: text('name').notNull(),
  keywords: jsonb('keywords').$type<string[]>().notNull(),
  frequency: text('frequency').default('daily'), // hourly | daily | weekly
  enabled: boolean('enabled').default(true),
  lastTriggeredAt: timestamp('last_triggered_at'),
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
}))

export const alertTriggers = pgTable('alert_triggers', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
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
  organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => authUsers.id),
  builderId: text('builder_id').notNull().references(() => builders.id),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  organizationIdIdUnique: uniqueIndex('builder_notes_organization_id_id_unique').on(table.organizationId, table.id),
  organizationBuilderFk: foreignKey({
    columns: [table.organizationId, table.builderId],
    foreignColumns: [builders.organizationId, builders.id],
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
    id: uuid('id').primaryKey().defaultRandom(),
    builderId: text('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
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
    organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
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
    organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
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
    actorUserId: text('actor_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
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
    id: uuid('id').primaryKey().defaultRandom(),
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
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    contentHash: text('content_hash').notNull(),
    document: text('document').notNull(),
    profile: jsonb('profile').$type<EmbeddedProfile>().notNull(),
    // NULL = pending embed (picked up by the run-worker).
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('builder_embeddings_source_unique').on(table.source, table.sourceId),
    // Worker scan target: `WHERE embedding IS NULL` benefits from indexing
    // embeddedAt (NULL rows sort first); the HNSW vector index itself is
    // hand-written SQL appended to the generated migration (drizzle-kit
    // does not emit `USING hnsw`) — see drizzle/000X_*.sql.
    index('builder_embeddings_pending_idx').on(table.embeddedAt),
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
// Spec: plans/stealth-scraping/spec.md §7. Reuses the organization_builders
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
    id: uuid('id').primaryKey().defaultRandom(),
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
// Stripe Billing Platform Tables (plans/stripe-billing-platform/spec.md §Data model)
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
    actorUserId: text('actor_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
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
 * Chargeback tracking (plans/stripe-billing-platform/tasks.md §8 "Implement dispute freeze,
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
 * Verified billing contact (plans/stripe-billing-platform/tasks.md §9 "Add verified billing contact
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
 * the 30-day scheduled path or the owner-initiated immediate path (plans/stripe-billing-platform/
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
 * Append-only velocity signal for fraud/high-volume exception controls (plans/stripe-billing-platform/
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
 * Deduplication ledger for financial notifications (plans/stripe-billing-platform/tasks.md §10 "Add
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
    actorUserId: text('actor_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
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
