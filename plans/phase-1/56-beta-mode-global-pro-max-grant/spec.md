# Beta Mode — Global Pro Max grant (spec)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/spec.md)
> (BetterAuth Organizations, tenant-scoped RLS, `requirePlatformAdminPrincipal`,
> `organization_entitlements` table — all shipped);
> [`stripe-billing-platform`](../30-stripe-billing-platform/spec.md) (`catalog.ts`
> catalog, `feature-authorization.ts` gating, `grantOrganizationEntitlement` operator-grant
> path with SECURITY DEFINER function — all shipped, `STRIPE_BILLING_ENABLED=false` everywhere).
> Reads [`app-reality`](../../_meta/app-reality.md) for the ground truth on entitlements and
> rate-cards today.
> **Blocks**: nothing. Pure operational mode. Beta testers are signed-in users from the
> public beta cohort; the plan author can enable/disable without code changes.
> **Reality check (verified at HEAD 2026-08-07)**: `organization_entitlements` exists
> (`src/shared/lib/db/schema.ts`); `grantOrganizationEntitlement` is the canonical
> operator-grant path (`src/shared/lib/repositories/operator-grants.ts:113`); it runs as
> `builderhunt_platform` via a SECURITY DEFINER function
> (`drizzle/0141_platform_admin_grant_entitlement.sql`) so the platform role never holds
> direct table privileges. The catalog has `pro_max` at $79/month with 700 credits/month
> (`src/shared/lib/billing/catalog.ts`). `/admin/users`
> (`src/routes/_dashboard/admin/users.tsx`) is the existing operator-grant UI; no
> separate admin surface exists for global tier flags. There is no
> `is_beta_tester` column on `auth_users` or
> `organization_entitlements` today, and no `global_tier_override` system-table entry.
> `STRIPE_BILLING_ENABLED=false` everywhere, so Stripe webhooks are off; operator grants
> are the only way to set a tier by hand today, and they are scoped per-organization.

## Problem

BuilderHunt needs a public beta cohort to validate the product without charging
beta-testers. The product today has only two ways to give a user a paid tier:

1. **Stripe Checkout** — disabled everywhere (`STRIPE_BILLING_ENABLED=false`).
2. **Operator grant per organization** — `grantOrganizationEntitlement` in
   `/admin/users`. Works, but each grant is one organization at a time. To give 50
   beta-testers Pro Max, the admin runs 50 grants. To give the next 200, another 200.

The user wants:

- **One toggle** (on / off) that gives every signed-in user Pro Max with the maximum
  credit budget, until the admin flips it off.
- **No per-user clicks** — toggle is global, not per-organization.
- **Reversible** — flipping off returns every user to their existing entitlement
  without data loss.

## Goal

A **global beta-mode flag** that, when on, makes every organization entitled at
`pro_max` with the catalog's `pro_max_monthly` credit grant (700 credits/month) and
the `pro_max` sprint cap (10 concurrent sprints). When off, every organization reverts
to its pre-beta entitlement.

Three concrete objectives:

1. **One toggle, one place.** A single boolean in a system-table row, set by a
   platform-admin action on `/admin/billing` (existing page). The flag is read on
   every `feature-authorization` call (today's `requireFeature`) and on every credit
   reservation. There is no per-user, per-organization code path.
2. **No regression on existing operator grants.** An organization the admin manually
   upgraded to `team` (e.g., a partner) keeps its `team` tier when the flag is on,
   because `team > pro_max` in the catalog. An organization the admin downgraded to
   `free` (e.g., a churn test) keeps `free` because `free` is enforced by the
   per-organization grant. The flag is a **floor**, not a ceiling.
3. **Reversible, audited, observable.** The toggle writes a `security_audit_events`
   row with `kind = 'admin.tier.beta-mode-on' | 'admin.tier.beta-mode-off'`,
   `actor = platform_admin_user_id`, and the affected-org count snapshot at toggle
   time. The `/admin/billing` page shows the current flag state, the timestamp of the
   last change, and the actor.

## Non-goals

- **Not a billing system.** This plan does not implement Stripe Checkout. The flag is
  the only thing that flips; the existing entitlement + credit paths run unchanged.
  When `stripe-billing-platform` ships for real, the flag turns off and real billing
  resumes.
- **Not a per-user toggle.** There is no "this user is a beta-tester, that one is
  not." The plan's spec is "every signed-in user gets Pro Max." Per-user targeting is
  future work; the catalog already supports it via `organization_entitlements.tier`.
- **Not a credit-pack top-up.** A beta-tester gets the catalog's `pro_max` monthly
  grant (700 credits). They do not get extra credit packs. Packs are a paid-flow
  concept (`catalog.ts` packs).
- **Not a Stripe webhook handler change.** The flag lives in a system table, not in
  Stripe. The Stripe webhook handler (`src/routes/api/webhooks/stripe.ts`) ignores
  the flag by design: real billing is off today and the flag is the only tier-change
  path.
- **Not a UI redesign.** The flag lives on the existing `/admin/billing` page. The
  badge in the user menu shows "Beta mode active" when on; no other UI changes.

## Architecture

### New system table: `system_flags`

```sql
CREATE TABLE system_flags (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES auth_users(id)
);
```

One row, one key: `tier.beta-mode`. The value is `{ "enabled": true, "tier":
"pro_max", "creditGrant": "pro_max_monthly", "sprintCap": 10,
"audit_event_id": "uuid" }`. New rows are not inserted; the row is upserted on
toggle.

### Read path

`requireFeature` and the credit-reservation helper check the flag first. When the
flag is on and the current organization tier is below `pro_max`, the helper answers
the higher tier. When the flag is off, the helper returns the existing entitlement.

```ts
// src/shared/lib/billing/feature-authorization.ts (sketch)
export async function requireFeature(orgId: string, feature: FeatureKey) {
  const beta = await getBetaModeFlag()
  const ent = await getOrganizationEntitlement(orgId)
  const effectiveTier = beta?.enabled && tierRank(ent.tier) < tierRank(beta.tier)
    ? beta.tier
    : ent.tier
  // ... existing logic, applied to effectiveTier ...
}
```

The `effectiveTier` is computed once per request, never stored, never persisted. The
existing `organization_entitlements` row is untouched. When the flag turns off,
the next request computes `effectiveTier = ent.tier` again.

### Write path

A platform admin clicks the toggle on `/admin/billing`. The handler:

1. Reads the current flag (if any).
2. Toggles `enabled`.
3. Computes a snapshot: count of affected organizations (all of them, since the
   floor applies to every signed-in user).
4. Writes a `security_audit_events` row with `kind =
   'admin.tier.beta-mode-on' | 'admin.tier.beta-mode-off'`, the actor, the snapshot, and
   a `from` / `to` pair of tier values.
5. Upserts the `system_flags` row in the same transaction.
6. Returns the new flag state.

The handler does **not** touch `organization_entitlements`. It does **not** touch
Stripe. It does **not** invalidate credit caches (the existing TTL handles that).

### Cache strategy

`system_flags` is read on every feature check. The table has one row, so the read is
cheap. A Redis cache (`src/shared/lib/redis.ts`, already used for `search` and
rate-limit) fronts the read with a 60-second TTL. The TTL is acceptable because the
flag is admin-set, not user-set; a 60-second lag between toggle and effect is fine.

The cache is invalidated on every toggle (the write path does a Redis
`DEL system_flags:tier.beta-mode`). The next feature check re-reads from Postgres.

### Credit accounting during beta

When the flag turns on:

- The credit grant for the next cycle is `pro_max_monthly` (700 credits). The grant
  happens automatically by the existing `annual-grants.ts` cycle when the entitlement
  is read.
- Existing credit balances carry over (this is what the catalog does today; the plan
  does not change carry-over semantics).
- A user who was at `free` and had 0 credits last month now reads 700 credits this
  month. The reservation flow (`src/shared/lib/billing/reservations.ts`) sees the
  higher grant and the user is unblocked.

When the flag turns off:

- The next feature check reads the existing `organization_entitlements.tier`. If the
  user was manually granted `team`, they keep `team`. If they were at `free`, they go
  back to `free` (0 credits / 0 sprints).
- The user keeps any **pack** credits they bought (packs are not beta-affected; they
  are stored in the credit ledger independently).
- A toast on the user menu: "Beta mode ended. Your account is on the Free plan. [See
  pricing](/pricing)."

## Verification

1. **Toggle on → entitlement rises.** A test org at `free` reads `requireFeature('smart-alerts')`
   and gets `ok` when the flag is on. The same call gets `FeatureBillingError` when
   the flag is off. **No** call to `grantOrganizationEntitlement` runs.
2. **Toggle off → entitlement falls back.** The same org reads
   `requireFeature('smart-alerts')` and gets `FeatureBillingError` after the flag
   turns off. The existing `organization_entitlements.tier` is unchanged
   (`free`).
3. **No regression on existing operator grants.** An org manually granted to
   `team` keeps `team` when the flag is on. The flag is a floor, not a ceiling.
4. **Audit row exists.** The toggle writes a `security_audit_events` row with the
   expected `kind`, actor, and snapshot. The audit page on `/admin/metrics` (existing)
   shows the row.
5. **Cache invalidation.** A `DEL` on the Redis key fires on every toggle. The next
   feature check reads the new value.
6. **Failure isolation.** A Postgres connection error during the read path returns
   the cached value (last-known-good) plus a WARN log. The system never 5xx's on a
   flag-read failure.

## Constraints this plan respects

1. `app-reality.md` — every claim cites a `src/` path or a `plans/` path.
2. `security-and-multitenancy` §2 — the flag is global, but it never weakens a
   per-organization tier. It can only **raise** entitlements (floor), not lower them.
3. `stripe-billing-platform` §10 — the operator-grant path is preserved. The flag is
   orthogonal to operator grants; an operator grant still wins over the flag when
   the operator grant tier is higher (e.g., a partner on `team` keeps `team`).
4. `ai-policy.md` — the flag does not change AI credit costs. The credit grant rises
   (because the tier rises), but the per-request cost of each AI task is unchanged.
5. `conventions.md` rule 8 — no hand-edits to `.env`; the flag is a system-table row,
   not an env var.

## Out of scope

- **Per-user beta flag** (a column on `auth_users` or `organization_entitlements`).
  Future work; not in this plan.
- **Tier override per organization** (a free user manually upgraded by the beta
  toggle). This is the operator-grant path and exists today via
  `grantOrganizationEntitlement`; not new in this plan.
- **Stripe Checkout for the beta cohort.** When `STRIPE_BILLING_ENABLED=true` ships,
  the toggle turns off and beta-testers convert (or churn) on the real billing path.
  This plan does not touch Stripe.
- **UI redesign.** The toggle is one row on the existing `/admin/billing` page. The
  badge is one icon in the existing user menu.
