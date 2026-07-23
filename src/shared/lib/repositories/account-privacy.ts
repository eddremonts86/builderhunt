import { and, desc, eq, lt, ne } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { accountDb } from '../db/client'
// auth_users/auth_accounts are auth-broker-only tables (see
// drizzle/0007_auth_broker.sql) — builderhunt_app has no grant on them, so
// this account-subject export must read them through authDb, not accountDb.
import { authDb } from '../db/auth-db'
import { withTenantContext } from '../db/tenant-context'
import type { OrganizationRole } from '../authorization/permissions'
import {
  alerts,
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  builderClaimRequests,
  builderClaims,
  builderNotes,
  builderProfileViews,
  builders,
  dataExportRequests,
  deletionRequests,
  organizationBuilders,
  organizationMembers,
  organizations,
  planChanges,
  planRequests,
  plans,
  publishedBuilderProfiles,
  savedQueries,
  sourcingSprints,
  userConsents,
} from '../db/schema'

// A permanent system row (drizzle/0026_deleted_user_sentinel.sql) that
// organization-owned resources' `creator_user_id` gets reassigned to on
// account deletion, instead of being deleted themselves — see
// hardDeleteAccountSubject below for why.
export const DELETED_USER_SENTINEL_ID = 'system-deleted-user'

export const listAccountConsents = (userId: string) => accountDb.select().from(userConsents)
  .where(eq(userConsents.userId, userId)).orderBy(desc(userConsents.acceptedAt))

export const insertAccountConsent = (input: typeof userConsents.$inferInsert) => accountDb.insert(userConsents).values(input)

export const listAccountExportRequests = (userId: string) => accountDb.select().from(dataExportRequests)
  .where(eq(dataExportRequests.userId, userId)).orderBy(desc(dataExportRequests.createdAt))

export async function findAccountExportRequest(userId: string, id: string) {
  const [row] = await accountDb.select().from(dataExportRequests)
    .where(and(eq(dataExportRequests.id, id), eq(dataExportRequests.userId, userId))).limit(1)
  return row ?? null
}

export const createAccountExportRequest = (id: string, userId: string) => accountDb.insert(dataExportRequests)
  .values({ id, userId, status: 'pending' })

export const updateAccountExportRequest = (
  id: string,
  input: Partial<typeof dataExportRequests.$inferInsert>,
) => accountDb.update(dataExportRequests).set(input).where(eq(dataExportRequests.id, id))

export const listAccountPlanChanges = (userId: string) => accountDb.select({
  id: planChanges.id,
  fromPlan: planChanges.fromPlan,
  toPlan: planChanges.toPlan,
  changedBy: planChanges.changedBy,
  reason: planChanges.reason,
  createdAt: planChanges.createdAt,
}).from(planChanges).where(eq(planChanges.userId, userId)).orderBy(desc(planChanges.createdAt)).limit(20)

export async function loadAccountExportSource(userId: string) {
  const [user] = await authDb.select({
    id: authUsers.id,
    name: authUsers.name,
    email: authUsers.email,
    emailVerified: authUsers.emailVerified,
    image: authUsers.image,
    createdAt: authUsers.createdAt,
    updatedAt: authUsers.updatedAt,
  }).from(authUsers).where(eq(authUsers.id, userId)).limit(1)
  if (!user) return null

  const [account, consents, claimRequests, claims, profileViews, deletion, memberships, plan, requests, changes] = await Promise.all([
    authDb.select({
      providerId: authAccounts.providerId,
      password: authAccounts.password,
      createdAt: authAccounts.createdAt,
    }).from(authAccounts).where(eq(authAccounts.userId, userId)).limit(1),
    listAccountConsents(userId),
    accountDb.select({
      id: builderClaimRequests.id,
      builderId: builderClaimRequests.builderId,
      expiresAt: builderClaimRequests.expiresAt,
      usedAt: builderClaimRequests.usedAt,
      createdAt: builderClaimRequests.createdAt,
    }).from(builderClaimRequests).where(eq(builderClaimRequests.email, user.email)),
    accountDb.select({
      id: builderClaims.id,
      builderIdentityId: builderClaims.builderIdentityId,
      evidenceSource: builderClaims.evidenceSource,
      status: builderClaims.status,
      expiresAt: builderClaims.expiresAt,
      verifiedAt: builderClaims.verifiedAt,
      revokedAt: builderClaims.revokedAt,
      createdAt: builderClaims.createdAt,
    }).from(builderClaims).where(eq(builderClaims.subjectUserId, userId)),
    accountDb.select({
      builderId: builderProfileViews.builderId,
      viewedAt: builderProfileViews.viewedAt,
    }).from(builderProfileViews).where(eq(builderProfileViews.viewerId, userId)),
    accountDb.select({
      id: deletionRequests.id,
      status: deletionRequests.status,
      createdAt: deletionRequests.createdAt,
      gracePeriodEndsAt: deletionRequests.gracePeriodEndsAt,
      completedAt: deletionRequests.completedAt,
    }).from(deletionRequests).where(eq(deletionRequests.userId, userId)).limit(1),
    // organizations/organization_members are tenant-private with RLS forced
    // on organization_id — but better-auth's own auth-broker policy
    // (drizzle/0008_tenant_rls.sql) grants builderhunt_auth unrestricted
    // access to both (it needs to list every org a user can switch into), so
    // read this specific "which orgs am I in" query through authDb instead
    // of accountDb rather than trying to invent a per-org tenant context for
    // a query whose whole purpose is discovering those org ids.
    authDb.select({
      organizationId: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
    }).from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, userId)),
    accountDb.select({
      plan: plans.plan,
      status: plans.status,
      planEndsAt: plans.planEndsAt,
      trialEndsAt: plans.trialEndsAt,
      createdAt: plans.createdAt,
      updatedAt: plans.updatedAt,
    }).from(plans).where(eq(plans.userId, userId)).limit(1),
    accountDb.select({
      id: planRequests.id,
      requestedPlan: planRequests.requestedPlan,
      status: planRequests.status,
      message: planRequests.message,
      createdAt: planRequests.createdAt,
    }).from(planRequests).where(eq(planRequests.userId, userId)),
    listAccountPlanChanges(userId),
  ])

  // `builders` is tenant-private with RLS forced on organization_id — a plain
  // accountDb query (no transaction-local app.organization_id) silently
  // returns zero rows instead of erroring. The subject's tracked builders can
  // live in any organization they belong to, so read once per membership
  // under that organization's own tenant context and flatten the results.
  const trackedBuildersByOrganization = await Promise.all(
    memberships.map((membership) =>
      withTenantContext(
        {
          userId,
          organizationId: membership.organizationId,
          role: membership.role as OrganizationRole,
          requestId: crypto.randomUUID(),
        },
        (tx) => tx.select({
          id: builders.id,
          source: builders.source,
          username: builders.username,
          displayName: builders.displayName,
          profileUrl: builders.profileUrl,
          organizationId: builders.organizationId,
          createdAt: builders.createdAt,
        }).from(builders).where(eq(builders.userId, userId)),
      ),
    ),
  )
  const trackedBuilders = trackedBuildersByOrganization.flat()

  return {
    user,
    auth: account[0] ? { providerId: account[0].providerId, hasPassword: Boolean(account[0].password), createdAt: account[0].createdAt } : null,
    consents,
    claimRequests,
    claims,
    profileViews,
    deletion: deletion[0] ?? null,
    organizationMemberships: memberships,
    trackedBuilders,
    plan: plan[0] ?? null,
    planChanges: changes,
    planRequests: requests,
  }
}

/**
 * Organizations this user owns AND that have at least one other member —
 * every account has its own solo personal organization (seatLimit 1,
 * `buildPersonalOrganizationSeed`), so "owns an organization" alone is not
 * the right block: that would refuse every account deletion, always. The
 * real risk this guards against is orphaning OTHER people's access, which
 * only exists once someone besides the deleting user is a member — inner
 * joining against a second reference to organization_members for "a
 * different user in the same org" naturally excludes solo ownership,
 * personal or not (an upgraded personal org can carry real teammates, see
 * team-accounts task 3's correction — this still needs to block on those).
 */
export async function listOwnedOrganizationsWithOtherMembers(userId: string) {
  const otherMembers = alias(organizationMembers, 'other_members')
  // Same RLS shape as the memberships query in loadAccountExportSource above —
  // read through authDb, which has unrestricted access via the auth-broker
  // policy, not accountDb (which would silently return zero rows and let
  // the ownership guard wrongly conclude the user owns nothing).
  return authDb
    .selectDistinct({
      organizationId: organizationMembers.organizationId,
      organizationName: organizations.name,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .innerJoin(
      otherMembers,
      and(eq(otherMembers.organizationId, organizationMembers.organizationId), ne(otherMembers.userId, userId)),
    )
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.role, 'owner')))
}

export async function findDeletionRequest(userId: string) {
  const [row] = await accountDb.select().from(deletionRequests)
    .where(eq(deletionRequests.userId, userId)).limit(1)
  return row ?? null
}

/**
 * Looks up the subject's email before a hard delete removes the auth_users row.
 * Used by legal.ts's processPendingDeletions to send the deletion-completed email
 * after the row (and its email column) are already gone.
 */
export async function findAccountEmail(userId: string): Promise<string | null> {
  const [row] = await authDb.select({ email: authUsers.email }).from(authUsers)
    .where(eq(authUsers.id, userId)).limit(1)
  return row?.email ?? null
}

/** Used where a notification needs both the recipient address and a display name (e.g. ownership-transfer emails) — `findAccountEmail` alone is enough for every other existing caller, so that one is left untouched. */
export async function findAccountEmailAndName(userId: string): Promise<{ email: string; name: string } | null> {
  const [row] = await authDb.select({ email: authUsers.email, name: authUsers.name }).from(authUsers)
    .where(eq(authUsers.id, userId)).limit(1)
  return row ?? null
}

export async function findOrganizationName(organizationId: string): Promise<string | null> {
  const [row] = await authDb.select({ name: organizations.name }).from(organizations)
    .where(eq(organizations.id, organizationId)).limit(1)
  return row?.name ?? null
}

export const insertDeletionRequest = (input: typeof deletionRequests.$inferInsert) => accountDb.insert(deletionRequests).values(input)
export const updateDeletionRequest = (id: string, input: Partial<typeof deletionRequests.$inferInsert>) => accountDb
  .update(deletionRequests).set(input).where(eq(deletionRequests.id, id))
export const cancelPendingDeletion = (userId: string) => accountDb.update(deletionRequests)
  .set({ status: 'cancelled' })
  .where(and(eq(deletionRequests.userId, userId), eq(deletionRequests.status, 'pending')))
  .returning({ id: deletionRequests.id })

export const listExpiredPendingDeletionRequests = () => accountDb.select({
  id: deletionRequests.id,
  userId: deletionRequests.userId,
}).from(deletionRequests)
  .where(and(eq(deletionRequests.status, 'pending'), lt(deletionRequests.gracePeriodEndsAt, new Date())))

export async function hardDeleteAccountSubject(userId: string) {
  // `builder_notes`/`alerts`/`saved_queries`/`builders` are tenant-private
  // with RLS forced on organization_id — a plain `accountDb.transaction()`
  // with no `app.organization_id` set silently deletes ZERO rows (RLS
  // denies, no error), same failure mode `loadAccountExportSource` above
  // was fixed for on the read side. The subject's rows can live in any
  // organization they belong to, so delete once per membership under that
  // organization's own tenant context — each iteration's delete only
  // touches that org's rows for this user, enforced by RLS, not by an
  // explicit organizationId filter in the query.
  const memberships = await authDb.select({
    organizationId: organizationMembers.organizationId,
    role: organizationMembers.role,
  }).from(organizationMembers).where(eq(organizationMembers.userId, userId))

  await Promise.all(
    memberships.map((membership) =>
      withTenantContext(
        {
          userId,
          organizationId: membership.organizationId,
          role: membership.role as OrganizationRole,
          requestId: crypto.randomUUID(),
        },
        // FK-safe order: `builder_notes.builder_id` and `alerts.query_id`
        // have no ON DELETE action, so their referenced rows must go
        // first or Postgres blocks the delete.
        async (tx) => {
          await tx.delete(builderNotes).where(eq(builderNotes.userId, userId))
          await tx.delete(alerts).where(eq(alerts.userId, userId))
          await tx.delete(savedQueries).where(eq(savedQueries.userId, userId))
          await tx.delete(builders).where(eq(builders.userId, userId))
          // `organization_builders`/`sourcing_sprints` are organization-owned,
          // not this user's private data — reassign the creator reference
          // to the permanent sentinel instead of deleting them, or `onDelete:
          // 'restrict'` on creator_user_id blocks the auth_users delete below
          // forever, for any user who ever tracked a builder or ran a sprint.
          await tx.update(organizationBuilders).set({ creatorUserId: DELETED_USER_SENTINEL_ID })
            .where(eq(organizationBuilders.creatorUserId, userId))
          await tx.update(sourcingSprints).set({ creatorUserId: DELETED_USER_SENTINEL_ID })
            .where(eq(sourcingSprints.creatorUserId, userId))
          // Unlike the two tables above, this genuinely IS the user's own
          // data (their self-published claimed profile) — delete it, not
          // reassign it. Its RLS policy is scoped by `app.user_id`, not
          // organization, so any membership's tenant context clears it;
          // safe to repeat across iterations (a second delete matches 0 rows).
          await tx.delete(publishedBuilderProfiles).where(eq(publishedBuilderProfiles.publishedByUserId, userId))
        },
      ),
    ),
  )

  // Two transactions, not one: auth_users/auth_sessions/auth_accounts/auth_verifications
  // are auth-broker-only tables (drizzle/0007_auth_broker.sql revokes builderhunt_app's
  // access to them), so they must be deleted through authDb's separate connection —
  // there is no single Postgres transaction that spans both roles.
  await authDb.transaction(async (tx) => {
    // `plans`/`plan_changes`/`plan_requests`/`user_consents`/`data_export_requests`/
    // `onboarding_progress`/`roadmap_votes` already cascade from `auth_users` (see
    // schema.ts) and need no explicit delete here; `alert_triggers` cascades from `alerts`.
    await tx.delete(authVerifications).where(eq(authVerifications.identifier, userId))
    await tx.delete(authSessions).where(eq(authSessions.userId, userId))
    await tx.delete(authAccounts).where(eq(authAccounts.userId, userId))
    await tx.delete(authUsers).where(eq(authUsers.id, userId))
  })
}
