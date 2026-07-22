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
    check('organization_entitlements_tier_check', sql`${table.tier} in ('free', 'pro', 'team')`),
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
