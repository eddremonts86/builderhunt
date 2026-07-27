/**
 * Wave 1 Task 2 — builder fixtures.
 *
 * Builder identities normally arrive through discovery/sourcing pipelines
 * (external providers — faked in Wave 1 Task 4), so fixtures seed
 * `builder_identities` and org-scoped `organization_builders` rows directly
 * with deterministic ids. Organization scoping mirrors the schema: an
 * identity is global, tracking it is per-organization.
 */
import type { Sql } from 'postgres'
import { uniqueId } from '../ids'
import type { FixtureContext } from './principals'

export type OrganizationBuilderStatus = 'tracked' | 'shortlisted' | 'archived'
export type OrganizationBuilderVisibility = 'private' | 'organization'

export async function seedBuilderIdentity(
  sql: Sql,
  input: { scope?: string; source?: string; username?: string } = {},
): Promise<{ builderIdentityId: string }> {
  const builderIdentityId = uniqueId('builder-identity', input.scope)
  const source = input.source ?? 'github'
  const username = input.username ?? builderIdentityId
  await sql`
    insert into builder_identities (id, source, source_id, username, display_name, profile_url)
    values (${builderIdentityId}, ${source}, ${builderIdentityId}, ${username},
            ${`E2E Builder ${username.slice(-6)}`}, ${`https://e2e.test/${source}/${username}`})
  `
  return { builderIdentityId }
}

export async function seedOrganizationBuilder(
  sql: Sql,
  input: {
    organizationId: string
    builderIdentityId: string
    creatorUserId: string
    status?: OrganizationBuilderStatus
    visibility?: OrganizationBuilderVisibility
    scope?: string
  },
): Promise<{ organizationBuilderId: string }> {
  const organizationBuilderId = uniqueId('org-builder', input.scope)
  await sql`
    insert into organization_builders (id, organization_id, builder_identity_id, creator_user_id, visibility, status)
    values (${organizationBuilderId}, ${input.organizationId}, ${input.builderIdentityId},
            ${input.creatorUserId}, ${input.visibility ?? 'private'}, ${input.status ?? 'tracked'})
  `
  return { organizationBuilderId }
}

/** Convenience: a fresh identity already tracked by the given organization. */
export async function seedTrackedBuilder(
  ctx: FixtureContext,
  input: { organizationId: string; creatorUserId: string; status?: OrganizationBuilderStatus },
): Promise<{ builderIdentityId: string; organizationBuilderId: string }> {
  const { builderIdentityId } = await seedBuilderIdentity(ctx.sql, { scope: ctx.scope })
  const { organizationBuilderId } = await seedOrganizationBuilder(ctx.sql, {
    organizationId: input.organizationId,
    builderIdentityId,
    creatorUserId: input.creatorUserId,
    status: input.status,
    scope: ctx.scope,
  })
  return { builderIdentityId, organizationBuilderId }
}

/**
 * Delete one identity and everything hanging off it (tracking rows first —
 * `organization_builders.builder_identity_id` is ON DELETE RESTRICT).
 */
export async function cleanupBuilderIdentity(sql: Sql, builderIdentityId: string): Promise<void> {
  await sql`delete from enrichment_jobs where builder_identity_id = ${builderIdentityId}`
  await sql`delete from organization_builders where builder_identity_id = ${builderIdentityId}`
  await sql`delete from builder_identities where id = ${builderIdentityId}`
}
