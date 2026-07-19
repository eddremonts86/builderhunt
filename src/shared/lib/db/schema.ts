import { pgTable, text, timestamp, boolean, integer, jsonb, unique, uuid, index } from 'drizzle-orm/pg-core'

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

export const authSessions = pgTable('auth_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

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

// ---------------------------------------------------------------------------
// App Tables
// ---------------------------------------------------------------------------

export const builders = pgTable(
  'builders',
  {
    id: text('id').primaryKey(),
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
  }),
)

export const savedQueries = pgTable('saved_queries', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id),
  name: text('name').notNull(),
  keywords: jsonb('keywords').$type<string[]>().notNull(),
  sources: jsonb('sources').$type<string[]>().default(['github']),
  language: text('language'),
  country: text('country'),
  createdAt: timestamp('created_at').defaultNow(),
})

export const alerts = pgTable('alerts', {
  id: text('id').primaryKey(),
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
})

export const alertTriggers = pgTable('alert_triggers', {
  id: text('id').primaryKey(),
  alertId: text('alert_id').notNull().references(() => alerts.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  builderId: text('builder_id').references(() => builders.id, { onDelete: 'set null' }),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
})

export const builderNotes = pgTable('builder_notes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id),
  builderId: text('builder_id').notNull().references(() => builders.id),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})
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

export const onboardingProgress = pgTable('onboarding_progress', {
  userId: text('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  step: integer('step').notNull().default(0), // 0..3
  completed: boolean('completed').notNull().default(false),
  skipped: boolean('skipped').notNull().default(false),
  skippedCount: integer('skipped_count').notNull().default(0),
  firstQueryId: text('first_query_id'),
  firstBuilderIds: jsonb('first_builder_ids').$type<string[]>().default([]).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

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
  userId: text('user_id').notNull().unique().references(() => authUsers.id, { onDelete: 'cascade' }),
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
