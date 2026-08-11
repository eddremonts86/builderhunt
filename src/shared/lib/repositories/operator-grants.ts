/**
 * The canonical operator grant: a platform admin setting an organization's entitlement by hand
 * (plans/implemented/30-stripe-billing-platform §10 "Contract legacy schema only after the compatibility window").
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
 * Stripe subscription — and `docs/operations/stripe-incident-response.md` names it as the support path while
 * Stripe is switched off, which is the one moment it must not be broken.
 *
 * ## Why every write goes through a database function
 *
 * `builderhunt_platform` — the role this runs as — has **no privilege at all** on `organizations`,
 * `organization_members` or `organization_entitlements`. Not INSERT, not UPDATE, not even SELECT. That is
 * deliberate (0022 and 0118 both explain it): the platform role can read every tenant, so giving it direct
 * access to the table every seat and feature check reads would make one compromised request path able to grant
 * itself anything.
 *
 * The first version of this file wrote the table directly through `platformDb`, which answers 42501 for that
 * role — the whole owner-facing grant was dead in production. It passed its unit tests because those connect as
 * the migration superuser, which sees no GRANTs and no RLS. An e2e test clicking Save on `/admin/users` is what
 * caught it. So: `drizzle/0141_platform_admin_grant_entitlement.sql` adds the narrow SECURITY DEFINER write
 * function, granted to `builderhunt_platform` alone, mirroring `platform_admin_user_billing_summary` on the read
 * side. The validation lives in the function too, so the rules hold even for a caller that forgets them.
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
 * The caller writes `security_audit_events` through the same sink the invitation and admin paths use
 * (`auditPlatformAdminAction`). A tier change with no payment behind it is precisely the event an auditor asks
 * about later, and the legacy path recorded it only in `plan_changes`, which went away with `plans`.
 */
import { sql } from 'drizzle-orm'
import type { PlanStatus } from '../billing-shared'
import { platformDb } from '../db/client'
import { PLAN_SEAT_LIMITS } from '../billing-shared'

export class OperatorGrantError extends Error {
  constructor(message: string, readonly code: 'unknown_organization' | 'invalid_tier') {
    super(message)
    this.name = 'OperatorGrantError'
  }
}

/**
 * The tiers a human can hand out.
 *
 * Narrower than `EntitlementTier`, which includes `pro_max`, and that is the point: a manual grant can never
 * mint `pro_max` — only a real Stripe subscription can. 30-stripe-billing-platform/tasks.md states it outright
 * ("belongs exclusively to the legacy manual-grant audit trail, which can never produce Pro Max"),
 * `organization_plan_changes`'s tier CHECK encodes it, the admin route has a named test forbidding it, and
 * `drizzle/0141`'s function refuses it. Typed here so a caller cannot even ask.
 */
export type GrantableTier = 'free' | 'pro' | 'team'

export interface OperatorGrantInput {
  organizationId: string
  tier: GrantableTier
  status?: PlanStatus
  /** Why the grant exists. Free text, shown to the next operator who looks at this organization. */
  notes?: string | null
  /** For a time-boxed trial or partnership. `null` clears any existing expiry. */
  trialEndsAt?: Date | null
}

export interface OperatorGrantResult {
  organizationId: string
  tier: GrantableTier
  status: PlanStatus
  seatLimit: number
  notes: string | null
  trialEndsAt: string | null
}

const GRANTABLE_TIERS: ReadonlySet<string> = new Set<GrantableTier>(['free', 'pro', 'team'])

/** `execute` requires an index signature, so this is a type alias rather than an interface. */
type GrantRow = {
  organization_id: string
  tier: string
  status: string
  seat_limit: number
  notes: string | null
  trial_ends_at: string | null
  [key: string]: unknown
}

/**
 * Sets an organization's entitlement directly.
 *
 * The seat limit is derived from the tier rather than accepted as a parameter: the whole point of a tier is that
 * it decides what comes with it, and an operator able to set 500 seats on `free` would make every seat check a
 * lie about what the customer bought. `PLAN_SEAT_LIMITS` is the same table Checkout uses.
 *
 * `billingPeriod` is set to `none` by the function because that is the truth — nothing is being billed on a
 * cycle. Leaving a stale `monthly` there would make the billing page claim a renewal date that will never
 * arrive.
 */
export async function grantOrganizationEntitlement(input: OperatorGrantInput): Promise<OperatorGrantResult> {
  // Checked here as well as in the function: a caller that reaches this with a bad tier deserves a typed
  // `OperatorGrantError` rather than a driver error carrying a SQLSTATE.
  if (!GRANTABLE_TIERS.has(input.tier)) {
    throw new OperatorGrantError(`Not a grantable tier: ${input.tier}`, 'invalid_tier')
  }

  const status: PlanStatus = input.status ?? 'active'
  const seatLimit = PLAN_SEAT_LIMITS[input.tier]
  const notes = input.notes ?? null
  // An ISO string with an explicit cast, never a `Date` binding. postgres.js refuses to bind a `Date` on any
  // client that has run drizzle's `migrate()` — every later `${Date}` throws `ERR_INVALID_ARG_TYPE` — which is
  // true of the disposable databases the tests use, and is a footgun waiting for whichever caller shares a
  // client with a migrator.
  const trialEndsAt = input.trialEndsAt?.toISOString() ?? null

  let rows: GrantRow[]
  try {
    rows = await platformDb.execute<GrantRow>(sql`
      select * from platform_admin_grant_organization_entitlement(
        ${input.organizationId}, ${input.tier}, ${status}, ${seatLimit}, ${notes}, ${trialEndsAt}::timestamptz
      )
    `)
  } catch (error) {
    // The function raises `23503` for an organization that does not exist and `22023` for a rejected argument.
    // Anything else — including 42501, which is what a missing EXECUTE grant looks like — must surface as
    // itself rather than be flattened into a business error the operator will misread as "bad input".
    //
    // The SQLSTATE is read from `cause` as well as the error itself: drizzle wraps driver errors in
    // `DrizzleQueryError`, which carries no `code` of its own, so checking only the top level would have let
    // every one of these fall through as an opaque 500.
    const code = (error as { code?: string }).code ?? ((error as { cause?: { code?: string } }).cause)?.code
    if (code === '23503') throw new OperatorGrantError('No such organization', 'unknown_organization')
    if (code === '22023') throw new OperatorGrantError((error as Error).message, 'invalid_tier')
    throw error
  }

  const row = rows[0]
  if (!row) {
    // Unreachable through the function, which either returns the upserted row or raises. Kept because silently
    // returning a fabricated result here would report a grant that did not happen.
    throw new Error(`grant returned no row for organization ${input.organizationId}`)
  }

  return {
    organizationId: row.organization_id,
    tier: row.tier as GrantableTier,
    status: row.status as PlanStatus,
    seatLimit: Number(row.seat_limit),
    // A raw `.execute(sql...)` bypasses drizzle's column-aware mapping, so timestamptz arrives as a string —
    // the same conversion `getPlatformUserBillingSummary` documents for its own function call.
    notes: row.notes,
    trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null,
  }
}

/*
 * `readOrganizationEntitlementForOperator` lived here and is gone (2026-08-04).
 *
 * It selected straight from `organization_entitlements` through `platformDb`, which that role has no SELECT on —
 * so it could only ever have thrown 42501 in production. It had no caller outside its own unit test, which
 * passed because that test connects as the migration superuser.
 *
 * Nothing replaced it because nothing needed it: `getPlatformUserBillingSummary` already answers "what is this
 * account entitled to, and where did that come from" through `platform_admin_user_billing_summary`, and it is
 * what both the admin Users list and this grant path read.
 */
