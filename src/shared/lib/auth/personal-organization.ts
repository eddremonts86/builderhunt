import { sql } from 'drizzle-orm'
import { personalOrganizationId, personalOrganizationSlug } from '../migration/backfill'
import { authDb } from '../db/auth-db'

export function buildPersonalOrganizationSeed(userId: string) {
  const organizationId = personalOrganizationId(userId)
  return {
    organization: {
      id: organizationId,
      name: 'Personal workspace',
      slug: personalOrganizationSlug(userId),
      metadata: JSON.stringify({ kind: 'personal', version: 1 }),
    },
    member: {
      id: `${organizationId}:owner`,
      organizationId,
      userId,
      role: 'owner' as const,
    },
    entitlement: {
      organizationId,
      tier: 'free' as const,
      status: 'active' as const,
      seatLimit: 1,
    },
  }
}

export async function ensurePersonalOrganization(userId: string): Promise<void> {
  const seed = buildPersonalOrganizationSeed(userId)
  await authDb.execute(sql`
    select bootstrap_personal_organization(
      ${userId},
      ${seed.organization.id},
      ${seed.organization.slug},
      ${seed.member.id}
    )
  `)
}

export interface DefaultActiveOrganizationDependencies {
  findFirstMembership(userId: string): Promise<{ organizationId: string } | null>
}

/**
 * Pure resolution logic for which organization a brand-new session should be
 * scoped to when the auth provider doesn't set one explicitly (better-auth's
 * organization plugin never auto-populates `activeOrganizationId` — see
 * `databaseHooks.session.create.before` in better-auth.ts). Picks the user's
 * earliest membership (their personal organization, created at signup)
 * unless they already belong to none (e.g. hook race, deleted org).
 */
export async function resolveDefaultActiveOrganizationId(
  userId: string,
  dependencies: DefaultActiveOrganizationDependencies,
): Promise<string | null> {
  const membership = await dependencies.findFirstMembership(userId)
  return membership?.organizationId ?? null
}

export async function pickDefaultActiveOrganizationId(userId: string): Promise<string | null> {
  const [{ asc, eq }, { organizationMembers }] = await Promise.all([
    import('drizzle-orm'),
    import('../db/schema'),
  ])

  return resolveDefaultActiveOrganizationId(userId, {
    findFirstMembership: async (currentUserId) => {
      const [membership] = await authDb
        .select({ organizationId: organizationMembers.organizationId })
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, currentUserId))
        .orderBy(asc(organizationMembers.createdAt))
        .limit(1)
      return membership ?? null
    },
  })
}
