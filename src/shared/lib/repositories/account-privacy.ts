import { and, desc, eq } from 'drizzle-orm'
import { accountDb } from '../db/client'
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  builderClaimRequests,
  builderClaims,
  builderProfileViews,
  dataExportRequests,
  deletionRequests,
  organizationMembers,
  organizations,
  planChanges,
  userConsents,
} from '../db/schema'

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
  const [user] = await accountDb.select({
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
    accountDb.select({
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
    accountDb.select({
      organizationId: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
    }).from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, userId)),
  ])
  return {
    user,
    auth: account[0] ? { providerId: account[0].providerId, hasPassword: Boolean(account[0].password), createdAt: account[0].createdAt } : null,
    consents,
    claimRequests,
    claims,
    profileViews,
    deletion: deletion[0] ?? null,
    organizationMemberships: memberships,
  }
}

export async function listOwnedOrganizations(userId: string) {
  return accountDb.select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.role, 'owner')))
}

export async function findDeletionRequest(userId: string) {
  const [row] = await accountDb.select().from(deletionRequests)
    .where(eq(deletionRequests.userId, userId)).limit(1)
  return row ?? null
}

export const insertDeletionRequest = (input: typeof deletionRequests.$inferInsert) => accountDb.insert(deletionRequests).values(input)
export const updateDeletionRequest = (id: string, input: Partial<typeof deletionRequests.$inferInsert>) => accountDb
  .update(deletionRequests).set(input).where(eq(deletionRequests.id, id))
export const cancelPendingDeletion = (userId: string) => accountDb.update(deletionRequests)
  .set({ status: 'cancelled' })
  .where(and(eq(deletionRequests.userId, userId), eq(deletionRequests.status, 'pending')))

export function hardDeleteAccountSubject(userId: string) {
  return accountDb.transaction(async (tx) => {
    await tx.delete(authVerifications).where(eq(authVerifications.identifier, userId))
    await tx.delete(authSessions).where(eq(authSessions.userId, userId))
    await tx.delete(authAccounts).where(eq(authAccounts.userId, userId))
    await tx.delete(authUsers).where(eq(authUsers.id, userId))
  })
}
