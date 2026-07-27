/**
 * Wave 1 Task 2 — organization fixtures.
 *
 * Organizations are created through the REAL Better Auth organization API
 * (`POST /api/auth/organization/create`) with the owner's authenticated
 * request context, so the creator-role assignment, slug uniqueness, and
 * active-organization switching all run the product code path.
 *
 * Every fixture organization then receives an EXPLICIT entitlement
 * (free/pro/team + seat limit) — the invariant the master plan demands —
 * seeded via `fixtures/billing.ts` because entitlement granting has no
 * self-serve product flow.
 *
 * Adding a member with a chosen role has no local product flow either: the
 * real invitation path requires outbound email delivery (Wave 1 Task 4's
 * fakes). `addMemberDirect` therefore writes `organization_members`
 * directly; role resolution is still proven against the real authorization
 * layer by the spec.
 */
import type { Sql } from 'postgres'
import { uniqueId } from '../ids'
import { createOrganizationViaApi } from '../auth'
import type { FixedClock } from '../clock'
import { assertSeatLimit, type EntitlementTier, type OrganizationRole } from '../roles'
import { activeEntitlement, readEntitlementRow, seedEntitlement, type EntitlementRow } from './billing'
import type { FixtureContext, Principal } from './principals'

export interface OrganizationFixture {
  organizationId: string
  slug: string
  name: string
  tier: EntitlementTier
  seatLimit: number
  ownerUserId: string
}

export interface CreateOrganizationOptions {
  tier: EntitlementTier
  seatLimit: number
  clock: FixedClock
  name?: string
  /** Keep the owner's current active organization instead of switching to the new one. */
  keepCurrentActiveOrganization?: boolean
}

export async function createOrganizationFixture(
  ctx: FixtureContext,
  owner: Principal,
  options: CreateOrganizationOptions,
): Promise<OrganizationFixture> {
  if (!owner.api || !owner.userId) {
    throw new Error(`Organization fixtures need an authenticated owner principal (got ${owner.kind})`)
  }
  assertSeatLimit(options.seatLimit)
  const slug = uniqueId('org', ctx.scope).replace(/_/g, '-')
  const name = options.name ?? `E2E ${options.tier} org ${slug.slice(-6)}`
  const created = await createOrganizationViaApi(owner.api, {
    name,
    slug,
    keepCurrentActiveOrganization: options.keepCurrentActiveOrganization,
  })
  await seedEntitlement(ctx.sql, activeEntitlement(created.organizationId, options.tier, options.seatLimit, options.clock))
  owner.ownedOrganizationIds.push(created.organizationId)
  return {
    organizationId: created.organizationId,
    slug: created.slug,
    name,
    tier: options.tier,
    seatLimit: options.seatLimit,
    ownerUserId: owner.userId,
  }
}

/**
 * Direct membership write — see module docstring for why no product flow
 * can do this locally. Never inserts `owner` (the one-owner-per-organization
 * partial unique index belongs to the real creation flow alone).
 */
export async function addMemberDirect(
  sql: Sql,
  input: { organizationId: string; userId: string; role: Exclude<OrganizationRole, 'owner'>; scope?: string },
): Promise<{ memberId: string }> {
  const memberId = uniqueId('member', input.scope)
  await sql`
    insert into organization_members (id, organization_id, user_id, role)
    values (${memberId}, ${input.organizationId}, ${input.userId}, ${input.role})
  `
  return { memberId }
}

export async function readEntitlement(sql: Sql, organizationId: string): Promise<EntitlementRow | null> {
  return readEntitlementRow(sql, organizationId)
}

/** Cascades members, invitations, and entitlements via the schema's FKs. */
export async function deleteOrganization(sql: Sql, organizationId: string): Promise<void> {
  await sql`delete from organizations where id = ${organizationId}`
}
