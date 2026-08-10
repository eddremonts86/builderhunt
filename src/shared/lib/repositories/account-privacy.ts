import { and, asc, desc, eq, gt, lt, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { accountDb } from '../db/client'
// auth_users/auth_accounts are auth-broker-only tables (see
// drizzle/0007_auth_broker.sql) — builderhunt_app has no grant on them, so
// this account-subject export must read them through authDb, not accountDb.
import { authDb } from '../db/auth-db'
import { withAccountSubjectContext, withTenantContext } from '../db/tenant-context'
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
  publishedBuilderProfiles,
  savedQueries,
  sourcingSprints,
  userConsents,
} from '../db/schema'
import { loadInterviewExportSection, shortenInterviewRetentionForOwner } from './interview-privacy'
import { USER_SCOPED_LIMIT } from '../db/read-bounds'

// A permanent system row (drizzle/0026_deleted_user_sentinel.sql) that
// organization-owned resources' `creator_user_id` gets reassigned to on
// account deletion, instead of being deleted themselves — see
// hardDeleteAccountSubject below for why.
export const DELETED_USER_SENTINEL_ID = 'system-deleted-user'

// One row per version of each legal document this person accepted — `USER_SCOPED_LIMIT`'s
// deliberate-action argument, and the document set itself is a handful.
export const listAccountConsents = (userId: string) => accountDb.select().from(userConsents)
  .where(eq(userConsents.userId, userId)).orderBy(desc(userConsents.acceptedAt)).limit(USER_SCOPED_LIMIT)

export const insertAccountConsent = (input: typeof userConsents.$inferInsert) => accountDb.insert(userConsents).values(input)

// One row per export the person asked for, newest first. Rate-limited at the route, so the ceiling
// is a backstop rather than the real bound.
export const listAccountExportRequests = (userId: string) => accountDb.select().from(dataExportRequests)
  .where(eq(dataExportRequests.userId, userId)).orderBy(desc(dataExportRequests.createdAt)).limit(USER_SCOPED_LIMIT)

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

  const [account, consents, claimRequests, claims, profileViews, deletion, memberships] = await Promise.all([
    authDb.select({
      providerId: authAccounts.providerId,
      password: authAccounts.password,
      createdAt: authAccounts.createdAt,
    }).from(authAccounts).where(eq(authAccounts.userId, userId)).limit(1),
    listAccountConsents(userId),
    // unbounded-read-ok: a subject access request must be complete, and read-bounds.ts forbids a
    // ceiling here by name — "a ceiling on a deletion, an export or a sweep is silent data loss".
    // Scoped to one email address, so the set is one person's own claim attempts.
    accountDb.select({
      id: builderClaimRequests.id,
      builderId: builderClaimRequests.builderId,
      expiresAt: builderClaimRequests.expiresAt,
      usedAt: builderClaimRequests.usedAt,
      createdAt: builderClaimRequests.createdAt,
    }).from(builderClaimRequests).where(eq(builderClaimRequests.email, user.email)),
    /*
     * These two read through `withAccountSubjectContext`, not the bare `accountDb`, because their
     * tables' RLS keys on `app.user_id` and the bare connection never sets it.
     *
     * For `builder_claims` that was a live gap rather than a precaution. With no `app.user_id`,
     * `builder_claims_app_select` matches nothing; a second additive policy
     * (`builder_claims_public_portfolio_select`, `USING (status = 'verified')`) let the *verified*
     * ones through, so the export looked populated and the omission was invisible. Pending, rejected,
     * revoked and expired claims were dropped — a person whose claim was refused got an export saying
     * they had never filed one, from the endpoint whose entire purpose is telling them what is held
     * about them.
     *
     * For `builder_profile_views` it is a prerequisite: that table had no RLS at all until
     * `0154_builder_profile_views_rls.sql`, and once it has some, this read needs an identity.
     */
    // unbounded-read-ok: the export must disclose every claim, which is the defect described
    // directly above — a refused claim omitted from the export is the failure mode, and a ceiling
    // reintroduces it silently.
    withAccountSubjectContext(userId, (transaction) => transaction.select({
      id: builderClaims.id,
      builderIdentityId: builderClaims.builderIdentityId,
      evidenceSource: builderClaims.evidenceSource,
      status: builderClaims.status,
      expiresAt: builderClaims.expiresAt,
      verifiedAt: builderClaims.verifiedAt,
      revokedAt: builderClaims.revokedAt,
      createdAt: builderClaims.createdAt,
    }).from(builderClaims).where(eq(builderClaims.subjectUserId, userId))),
    // unbounded-read-ok: every view this person performed is data held about them, so the export
    // owes them all of it. De-duplicated one viewer per day by the table itself, so the row count is
    // days of activity rather than page loads.
    withAccountSubjectContext(userId, (transaction) => transaction.select({
      builderId: builderProfileViews.builderId,
      viewedAt: builderProfileViews.viewedAt,
    }).from(builderProfileViews).where(eq(builderProfileViews.viewerId, userId))),
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
    // unbounded-read-ok: this drives the per-organization loop below as well as the export, so a
    // ceiling would drop whole organizations out of the subject's tracked-builder disclosure rather
    // than merely truncating a list. Bounded in practice by the organizations one person joined.
    authDb.select({
      organizationId: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
    }).from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, userId)),
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
        // unbounded-read-ok: same export-completeness rule, once per membership.
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

  // Per organization, on that organization's tenant connection, so RLS decides what the subject may see.
  // An export must not become a way to read a colleague's interviews.
  const interviewSections = await Promise.all(
    memberships.map((membership) =>
      withTenantContext(
        {
          userId,
          organizationId: membership.organizationId,
          role: membership.role as OrganizationRole,
          requestId: crypto.randomUUID(),
        },
        async (tx) => ({
          organizationId: membership.organizationId,
          ...(await loadInterviewExportSection(tx, { organizationId: membership.organizationId, userId })),
        }),
      ),
    ),
  )

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
    /*
     * `plan`, `planChanges` and `planRequests` were part of this export until 2026-08-03, sourced from the
     * per-user `plans`/`plan_changes`/`plan_requests` tables. All three tables are gone, and none of them had a
     * single row — `plan_changes` had no writer at all, so this section always returned an empty array while
     * looking like it delivered something.
     *
     * A data subject's entitlement now lives on the organization they own, which the memberships above already
     * identify; and the trail of operator-granted changes lives in `security_audit_events`, readable by a
     * platform admin. Neither is reproduced here: that table deliberately grants no SELECT to the request path,
     * and building a SECURITY DEFINER reader to serve a section that has never held data would be
     * infrastructure for an empty array.
     */
    /**
     * Interviews this user ran, as *their* data.
     *
     * Counts and status for anything a candidate supplied, never content: a candidate's CV, the text of what
     * they said, and a model's assessment of them are a third party's personal data, and handing them to a
     * different data subject in the name of a subject access request would be a disclosure. See
     * `interview-privacy.ts`.
     */
    interviews: interviewSections,
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

/**
 * How many rows the two bounded reads in the deletion path take at a time.
 *
 * Both are **batches**, not pages, and both callers drain them. A deletion that covers the first
 * fifty of anything is worse than the unbounded read it replaced: the rows it missed are personal
 * data the subject asked to have erased, and nothing anywhere reports the shortfall.
 *
 * Overridable per call **only so a test can seed past it**. Proving the loop terminates needs a
 * batch smaller than the fixture, and the alternative — seeding fifty-one organizations to test a
 * boundary — tests the same property much more slowly.
 */
export const DELETION_BATCH = 50

/**
 * Deletion requests whose grace period has expired, one batch at a time.
 *
 * `processPendingDeletions` drains it. The queue is ordered by `gracePeriodEndsAt` so the subject
 * who has been waiting longest is erased first — a batch boundary should not decide who waits
 * another day.
 */
export const listExpiredPendingDeletionRequests = (
  after: { gracePeriodEndsAt: Date; id: string } | null = null,
  limit: number = DELETION_BATCH,
) => accountDb.select({
  id: deletionRequests.id,
  userId: deletionRequests.userId,
  gracePeriodEndsAt: deletionRequests.gracePeriodEndsAt,
}).from(deletionRequests)
  .where(and(
    eq(deletionRequests.status, 'pending'),
    lt(deletionRequests.gracePeriodEndsAt, new Date()),
    // `id` trails the timestamp because two requests can share a grace-period end — the flow sets it
    // from a fixed offset, so two accounts closed in the same minute do — and a batch boundary
    // inside that tie would skip one of them entirely.
    ...(after
      ? [sql`(${deletionRequests.gracePeriodEndsAt}, ${deletionRequests.id}) > (${after.gracePeriodEndsAt}, ${after.id})`]
      : []),
  ))
  .orderBy(asc(deletionRequests.gracePeriodEndsAt), asc(deletionRequests.id))
  .limit(limit)

export async function hardDeleteAccountSubject(userId: string, batchSize: number = DELETION_BATCH) {
  // `builder_notes`/`alerts`/`saved_queries`/`builders` are tenant-private
  // with RLS forced on organization_id — a plain `accountDb.transaction()`
  // with no `app.organization_id` set silently deletes ZERO rows (RLS
  // denies, no error), same failure mode `loadAccountExportSource` above
  // was fixed for on the read side. The subject's rows can live in any
  // organization they belong to, so delete once per membership under that
  // organization's own tenant context — each iteration's delete only
  // touches that org's rows for this user, enforced by RLS, not by an
  // explicit organizationId filter in the query.
  /*
   * Memberships in batches, drained until none remain (plan 12).
   *
   * The loop's exit condition is "this batch came back short", never a page count. The rows this
   * function deletes are the subject's private data in each organization they belong to, so a
   * membership missed here is data that survives a completed erasure request — and the compliance row
   * would be marked `completed` regardless.
   *
   * `after` is the membership's own `(organization_id, user_id)` position rather than an offset,
   * which matters because this loop deletes as it goes: an offset would shift under its own writes.
   */
  let afterOrganizationId: string | null = null
  for (;;) {
    const memberships = await authDb.select({
      organizationId: organizationMembers.organizationId,
      role: organizationMembers.role,
    }).from(organizationMembers)
      .where(and(
        eq(organizationMembers.userId, userId),
        ...(afterOrganizationId ? [gt(organizationMembers.organizationId, afterOrganizationId)] : []),
      ))
      .orderBy(asc(organizationMembers.organizationId))
      .limit(batchSize)
    if (memberships.length === 0) break

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
          // Before the deletes below: the organizer's interview material is handed to the retention worker
          // rather than erased here. An interview that happened is a fact about a *candidate* too, and
          // deleting their transcript because the interviewer closed their account would erase a third
          // party's data on a request they never made — and with it the evidence trail that candidate's own
          // rights depend on. Shortening retention puts it on the ordinary clock instead.
          await shortenInterviewRetentionForOwner(tx, {
            organizationId: membership.organizationId,
            userId,
            now: new Date(),
          })
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
    afterOrganizationId = memberships[memberships.length - 1].organizationId
    if (memberships.length < batchSize) break
  }

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
