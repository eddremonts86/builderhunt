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

export const builders = pgTable('builders', {
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
})

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
