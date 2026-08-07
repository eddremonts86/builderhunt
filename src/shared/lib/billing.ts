/*
 * The per-user plan surface is gone (2026-08-03): `getUserPlan`, `setUserPlan`, `requestPlanUpgrade`,
 * `findPlanRequest`, `resolvePlanRequest`, `listPlanRequestsWithUsers` and `listAllUsersWithPlans` all read or
 * wrote the legacy `plans`/`plan_requests` tables, which are being dropped.
 *
 * Their replacements, by intent rather than by name:
 *
 * - granting a tier by hand → `repositories/operator-grants.ts`, against the *organization* that is actually
 *   entitled rather than a user who may belong to several;
 * - reading what an account is entitled to → `getPlatformUserBillingSummary`, which reports the canonical
 *   entitlement together with its provenance (Stripe-backed / manually granted / expired);
 * - self-service upgrade requests → Checkout. `LegacyPlanMutationDisabledError` already refused them whenever
 *   `STRIPE_BILLING_ENABLED` was true, so the request queue could not be fed and managing it was dead surface.
 *   That error class is itself gone now (2026-08-04) — with nothing left to refuse, it had no thrower.
 */

export {
  PLAN_LIMITS,
  PLAN_PRICING,
  type PlanStatus,
  type PlanTier,
  type UserPlan,
} from './billing-shared'
