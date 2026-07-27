/**
 * Wave 1 Task 2 — role and entitlement vocabulary for E2E fixtures.
 *
 * One authoritative list of every principal kind the suite can mint and
 * every organization role / entitlement tier the product recognizes.
 * These mirror the real authorization layer:
 *   - organization roles: `src/shared/lib/db/schema.ts`
 *     (`organization_members_role_check`: owner | admin | member) and
 *     `src/shared/lib/auth/tenant-principal.ts`.
 *   - entitlement tiers/statuses/periods and seat-limit bounds:
 *     `organization_entitlements` CHECK constraints in the same schema.
 *   - platform admin: `src/shared/lib/auth/platform-admin.ts` — an
 *     env-allow-listed principal, never an organization role.
 */

export const PRINCIPAL_KINDS = [
  'anonymous',
  'unverified',
  'verified',
  'member',
  'admin',
  'owner',
  'platform-admin',
] as const

export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number]

export const ORGANIZATION_ROLES = ['owner', 'admin', 'member'] as const
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number]

/**
 * Fixture tiers. The schema also allows `pro_max`, but the master plan's
 * fixture contract is explicit: organizations always receive free/pro/team.
 */
export const ENTITLEMENT_TIERS = ['free', 'pro', 'team'] as const
export type EntitlementTier = (typeof ENTITLEMENT_TIERS)[number]

export const ENTITLEMENT_STATUSES = ['active', 'trialing', 'past_due', 'canceled'] as const
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number]

export const BILLING_PERIODS = ['none', 'monthly', 'annual'] as const
export type BillingPeriod = (typeof BILLING_PERIODS)[number]

/** `organization_entitlements_seat_limit_check`: seat_limit between 1 and 10. */
export const SEAT_LIMIT_MIN = 1
export const SEAT_LIMIT_MAX = 10

export function assertSeatLimit(seatLimit: number): void {
  if (!Number.isInteger(seatLimit) || seatLimit < SEAT_LIMIT_MIN || seatLimit > SEAT_LIMIT_MAX) {
    throw new Error(
      `Seat limit ${seatLimit} is outside the schema bounds [${SEAT_LIMIT_MIN}, ${SEAT_LIMIT_MAX}] ` +
        '(organization_entitlements_seat_limit_check)',
    )
  }
}

export function isAuthenticatedKind(kind: PrincipalKind): boolean {
  return kind !== 'anonymous'
}

/**
 * The organization role a freshly minted principal of this kind holds in its
 * ACTIVE organization. Unverified/verified/platform-admin users are owners of
 * their own personal workspace (created by the real signup path); anonymous
 * has no organization at all.
 */
export function organizationRoleForKind(kind: PrincipalKind): OrganizationRole | null {
  switch (kind) {
    case 'anonymous':
      return null
    case 'member':
      return 'member'
    case 'admin':
      return 'admin'
    case 'owner':
    case 'unverified':
    case 'verified':
    case 'platform-admin':
      return 'owner'
  }
}
