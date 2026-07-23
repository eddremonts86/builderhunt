/**
 * Centralizes owner/admin/member billing authorization (plans/stripe-billing-platform/tasks.md §3)
 * on top of `can()` rather than reimplementing role comparisons — this file is deliberately NOT on
 * `scripts/check-tenant-boundaries.mjs`'s `roleLiteralCheckAllowlist`, so it must never compare a
 * principal's role against a string literal directly; every decision here is `can(principal, 'billing:...')`.
 *
 * Three tiers (spec.md §Permissions and UX):
 * - Owner: full read plus every mutation (subscribe, change/cancel, Portal, packs, auto-recharge,
 *   refund requests).
 * - Admin: read-only financial summary and usage data — the exact `organization:update`-style
 *   "elevated, member excluded" shape (`billing/dependency-contracts.test.ts`'s own comment: "the
 *   shape billing 'admin read' reuses").
 * - Member: feature availability only (no financial detail) plus an owner-contact affordance the UI
 *   builds itself — there is no mutation predicate here for members at all.
 *
 * Platform operators (`billing_seller_profiles` configuration) are a structurally separate
 * `PlatformAdminPrincipal` — never a `TenantPrincipal`, never `organization_members.role` — matching
 * `resolvePlatformAdminPrincipal`'s own separation.
 */
import { can, type PermissionAction, type TenantPrincipal } from '../authorization/permissions'
import type { PlatformAdminPrincipal } from '../auth/platform-admin'
import { RECENT_AUTH_MAX_AGE_SECONDS, STALE_SESSION_ERROR_MESSAGE } from '../auth/organization-lifecycle'

export class BillingAuthorizationError extends Error {
  constructor(message: string, readonly status: 401 | 403) {
    super(message)
    this.name = 'BillingAuthorizationError'
  }
}

export type BillingPermissionAction = Extract<PermissionAction, `billing:${string}`>

/** Read the pricing-page feature-availability view — every role, including a plain member. */
export function canViewBillingAvailability(principal: TenantPrincipal): boolean {
  return can(principal, 'billing:availability')
}

/** Read the full financial summary (invoices, payment state, credit balance, usage) — owner and admin, never a plain member. */
export function canReadBillingSummary(principal: TenantPrincipal): boolean {
  return can(principal, 'billing:read')
}

/** Change subscription tier/interval, buy a credit pack, or otherwise mutate paid state — owner only. */
export function canMutateBilling(principal: TenantPrincipal): boolean {
  return can(principal, 'billing:mutate')
}

/** Submit an eligible refund request — owner only; the request itself is further restricted to a pending, undecided state by drizzle/0028's RLS `WITH CHECK`. */
export function canRequestBillingRefund(principal: TenantPrincipal): boolean {
  return can(principal, 'billing:refund')
}

/** Open a Stripe Customer Portal session — owner only (spec.md: "Customer Portal is owner-only"). */
export function canOpenBillingPortal(principal: TenantPrincipal): boolean {
  return can(principal, 'billing:portal')
}

/** Configure or disable auto-recharge — owner only (spec.md: "Auto-recharge is off by default, owner-only"). */
export function canConfigureAutoRecharge(principal: TenantPrincipal): boolean {
  return can(principal, 'billing:auto-recharge')
}

/**
 * Actions sensitive enough that a hijacked long-lived session shouldn't be able to perform them
 * without a fresh sign-in — mirrors `organization-lifecycle.ts`'s `requireRecentAuthentication`
 * gate for ownership transfer/deletion, extended to the billing-specific mutations spec.md and this
 * task call out by name: payment method, billing contact, auto-recharge, and refund changes. (Plan
 * changes/checkout are deliberately excluded — spec.md never requires re-authentication to subscribe
 * or upgrade, only for actions that touch a saved payment method, contact identity, or move money out.)
 */
export const RECENT_AUTH_REQUIRED_BILLING_ACTIONS: ReadonlySet<BillingPermissionAction> = new Set([
  'billing:refund',
  'billing:portal',
  'billing:auto-recharge',
])

/** Structurally compatible with `organization-lifecycle.ts`'s `LifecycleSession` without importing its (unexported) type — the same duck-typed-interface pattern as `TenantTransactionLike` in `db/tenant-context.ts`. */
export interface RecentAuthSession {
  authenticatedAt: Date
}

export function requireRecentBillingAuthentication(session: RecentAuthSession, now: Date = new Date()): void {
  const ageSeconds = (now.getTime() - session.authenticatedAt.getTime()) / 1000
  if (ageSeconds > RECENT_AUTH_MAX_AGE_SECONDS) {
    throw new BillingAuthorizationError(STALE_SESSION_ERROR_MESSAGE, 401)
  }
}

/**
 * The one server guard every future billing route should call: checks the role-based permission
 * first (403 if the role itself is insufficient — a member can never reach a recent-auth check for
 * an action it was never allowed to attempt), then requires a fresh session for the actions listed
 * in `RECENT_AUTH_REQUIRED_BILLING_ACTIONS` (401 with `STALE_SESSION_ERROR_MESSAGE` if stale or
 * absent, matching `OrganizationDangerZone.tsx`'s "sign in again" CTA convention).
 */
export function requireBillingPermission(
  principal: TenantPrincipal,
  action: BillingPermissionAction,
  session?: RecentAuthSession,
): void {
  if (!can(principal, action)) throw new BillingAuthorizationError('Forbidden', 403)
  if (!RECENT_AUTH_REQUIRED_BILLING_ACTIONS.has(action)) return
  if (!session) throw new BillingAuthorizationError(STALE_SESSION_ERROR_MESSAGE, 401)
  requireRecentBillingAuthentication(session)
}

/**
 * Platform operator changes to seller/country/tax configuration (`billing_seller_profiles`) are
 * authorized entirely by `resolvePlatformAdminPrincipal`'s separate `ADMIN_USER_IDS` allow-list —
 * there is no `TenantPrincipal`/`OrganizationRole` involved at all, matching the structural
 * separation `dependency-contracts.test.ts` pins ("resolves from a distinct allow-list, never from
 * organization role"). This function exists to make that separation explicit at every billing
 * seller-configuration call site rather than letting callers reach for `requireBillingPermission` by
 * mistake.
 *
 * NOT YET recent-auth-gated: `PlatformAdminPrincipal` (`auth/platform-admin.ts`) carries only
 * `{ userId, requestId }` today — no session-recency timestamp exists to check. The "seller changes
 * require recent auth" requirement from this task's own `Do` line is real but not yet enforceable
 * until the platform-admin session surface gains an `authenticatedAt` field; the future "Build
 * private seller and country configuration" task must add that before this function can do more than
 * confirm the principal is a real platform admin (already guaranteed by whichever
 * `requirePlatformAdminPrincipal` call produced it).
 */
export function requirePlatformBillingConfigurationAccess(principal: PlatformAdminPrincipal): void {
  if (!principal.userId) throw new BillingAuthorizationError('Forbidden', 403)
}
