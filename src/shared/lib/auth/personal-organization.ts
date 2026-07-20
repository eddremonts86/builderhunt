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
