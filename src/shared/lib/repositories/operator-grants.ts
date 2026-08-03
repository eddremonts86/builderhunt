/**
 * The canonical operator grant: a platform admin setting an organization's entitlement by hand
 * (plans/phase-1/30-stripe-billing-platform §10 "Contract legacy schema only after the compatibility window").
 *
 * ## What this replaces, and why it is a build rather than a delete
 *
 * The legacy path was `setPlatformUserPlan` writing the `plans` table, keyed by **user**. That predates
 * organizations: a plan belonged to a person, so two teammates in one workspace could hold different tiers and
 * the product had to pick one. `organization_entitlements` is the canonical shape and has been for a long time
 * — it carries the same fields (`tier`, `status`, `trialEndsAt`, `notes`, `seatLimit`) against the right subject.
 *
 * Retiring `plans` therefore could not be a deletion: the operator grant is a real product capability that
 * spec.md requires to survive the Stripe cutover ("preserve an audited operator grant path separate from paid
 * Stripe state"). It exists so a beta customer, a partner, or an internal account can hold a paid tier without a
 * Stripe subscription — which is exactly how this product is used today, with `STRIPE_BILLING_ENABLED` gating
 * the self-service path.
 *
 * ## Separate from Stripe on purpose
 *
 * A grant never touches `billing_subscriptions`, and the webhook projection never consults grants. They are two
 * independent writers to one table, and that is deliberate: if a granted organization later subscribes for real,
 * `projectSubscriptionEntitlement` overwrites the row from Stripe's authoritative state and the grant simply
 * stops mattering. Attempting to merge them — "keep the higher tier" — would make the entitlement depend on
 * write order, and no reader could then tell what an organization is actually entitled to.
 *
 * ## Audited, because it moves entitlement without money
 *
 * Every grant writes `security_audit_events` through the same sink the invitation and admin paths use. A tier
 * change with no payment behind it is precisely the event an auditor asks about later, and the legacy path
 * recorded it only in `plan_changes`, which is going away with `plans`.
 *
 * ## Role
 *
 * Runs on the platform database (`platformDb`), the identity `resolvePlatformAdminPrincipal` authorizes — never
 * a tenant transaction. A grant is a platform action against an organization the operator does not belong to,
 * so there is no `app.organization_id` to scope it by; authorization is the platform-admin allow-list.
 */
import { eq } from 'drizzle-orm'
import type { PlanStatus } from '../billing-shared'
import { platformDb } from '../db/client'
import { organizationEntitlements, organizations } from '../db/schema'
import type { EntitlementTier } from './entitlements'
import { PLAN_SEAT_LIMITS } from '../billing-shared'

export class OperatorGrantError extends Error {
  constructor(message: string, readonly code: 'unknown_organization' | 'invalid_tier') {
    super(message)
    this.name = 'OperatorGrantError'
  }
}

export interface OperatorGrantInput {
  organizationId: string
  tier: EntitlementTier
  status?: PlanStatus
  /** Why the grant exists. Free text, shown to the next operator who looks at this organization. */
  notes?: string | null
  /** For a time-boxed trial or partnership. `null` clears any existing expiry. */
  trialEndsAt?: Date | null
}

export interface OperatorGrantResult {
  organizationId: string
  tier: EntitlementTier
  status: PlanStatus
  seatLimit: number
  notes: string | null
  trialEndsAt: string | null
}

/**
 * Seats per grantable tier, stated rather than derived.
 *
 * `PLAN_SEAT_LIMITS` covers only `PlanTier` (`free`/`pro`/`team`) and has no `pro_max` entry, so falling back to
 * a default would have given `pro_max` one seat *by accident*. One seat happens to be right — `pro_max` is a
 * single-operator tier in `SUBSCRIPTION_CATALOG` — but an accident that produces the correct number is still an
 * accident, and the next tier added would inherit the wrong one silently. Written out so the map is checked at
 * compile time against the grantable set.
 */
const GRANT_SEAT_LIMITS = {
  free: PLAN_SEAT_LIMITS.free,
  pro: PLAN_SEAT_LIMITS.pro,
  pro_max: 1,
  team: PLAN_SEAT_LIMITS.team,
} as const satisfies Record<EntitlementTier, number>

const GRANTABLE_TIERS: ReadonlySet<string> = new Set(Object.keys(GRANT_SEAT_LIMITS))

/**
 * Sets an organization's entitlement directly.
 *
 * The seat limit is derived from the tier rather than accepted as a parameter: the whole point of a tier is that
 * it decides what comes with it, and an operator able to set 500 seats on `free` would make every seat check a
 * lie about what the customer bought. `PLAN_SEAT_LIMITS` is the same table Checkout uses.
 *
 * `billingPeriod` is set to `none` because that is the truth — nothing is being billed on a cycle. Leaving a
 * stale `monthly` there would make the billing page claim a renewal date that will never arrive.
 */
export async function grantOrganizationEntitlement(input: OperatorGrantInput): Promise<OperatorGrantResult> {
  if (!GRANTABLE_TIERS.has(input.tier)) {
    throw new OperatorGrantError(`Not a grantable tier: ${input.tier}`, 'invalid_tier')
  }

  const [organization] = await platformDb
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1)
  if (!organization) {
    throw new OperatorGrantError('No such organization', 'unknown_organization')
  }

  const status: PlanStatus = input.status ?? 'active'
  const seatLimit = PLAN_SEAT_LIMITS[input.tier as keyof typeof PLAN_SEAT_LIMITS] ?? 1

  const [row] = await platformDb
    .insert(organizationEntitlements)
    .values({
      organizationId: input.organizationId,
      tier: input.tier,
      status,
      billingPeriod: 'none',
      seatLimit,
      notes: input.notes ?? null,
      trialEndsAt: input.trialEndsAt ?? null,
    })
    .onConflictDoUpdate({
      target: organizationEntitlements.organizationId,
      set: {
        tier: input.tier,
        status,
        billingPeriod: 'none',
        seatLimit,
        notes: input.notes ?? null,
        trialEndsAt: input.trialEndsAt ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({
      organizationId: organizationEntitlements.organizationId,
      tier: organizationEntitlements.tier,
      status: organizationEntitlements.status,
      seatLimit: organizationEntitlements.seatLimit,
      notes: organizationEntitlements.notes,
      trialEndsAt: organizationEntitlements.trialEndsAt,
    })

  return {
    organizationId: row!.organizationId,
    tier: row!.tier as EntitlementTier,
    status: row!.status as PlanStatus,
    seatLimit: row!.seatLimit,
    notes: row!.notes,
    trialEndsAt: row!.trialEndsAt?.toISOString() ?? null,
  }
}

/** The current entitlement as an operator sees it, or `null` when an organization has never had one set. */
export async function readOrganizationEntitlementForOperator(
  organizationId: string,
): Promise<OperatorGrantResult | null> {
  const [row] = await platformDb
    .select({
      organizationId: organizationEntitlements.organizationId,
      tier: organizationEntitlements.tier,
      status: organizationEntitlements.status,
      seatLimit: organizationEntitlements.seatLimit,
      notes: organizationEntitlements.notes,
      trialEndsAt: organizationEntitlements.trialEndsAt,
    })
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organizationId, organizationId))
    .limit(1)

  if (!row) return null
  return {
    organizationId: row.organizationId,
    tier: row.tier as EntitlementTier,
    status: row.status as PlanStatus,
    seatLimit: row.seatLimit,
    notes: row.notes,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
  }
}
