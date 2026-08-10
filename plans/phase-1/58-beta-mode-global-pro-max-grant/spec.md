# Beta Mode — Global Pro Max Access and Credits (spec)

> **Status**: `pending — implementation-ready`
> **Depends on**: [`01-security-and-multitenancy`](../01-security-and-multitenancy/spec.md),
> [`30-stripe-billing-platform`](../30-stripe-billing-platform/spec.md)
> **Implementation order note**: phase 1 plan 55 currently reserves migration `0163`; generate this
> plan's migration from the journal head that exists when implementation starts. Never edit or
> reuse an applied migration.
> **Reality check (verified at HEAD 2026-08-09)**: effective product access currently comes from
> direct callers of `getOrganizationEntitlement` plus `checkEntitlement` in
> `src/shared/lib/billing/feature-authorization.ts`. The latter requires an active Stripe
> subscription. Credits are real rows in `billing_credit_grants` and append-only
> `billing_ledger_entries`; changing a tier alone cannot create spendable credits. Pro Max grants
> 700 credits per monthly window, Pro grants 140, and Team grants 2,100. Team and Pro Max have the
> same feature rank in `rate-cards.ts`. The existing user menu is
> `src/modules/dashboard/components/UserMenu.tsx`; the existing platform billing page is
> `src/routes/_dashboard/admin/billing.tsx`.

## Problem

BuilderHunt needs one reversible platform-admin switch for a public beta. While it is enabled,
every authenticated tenant context must be able to use Pro Max product capabilities and receive a
usable 700-credit beta allowance without rewriting its purchased or operator-granted plan.

The current draft cannot be implemented safely because it assumes APIs that do not exist, treats a
tier projection as if it minted credit-ledger rows, assigns an already-applied migration number,
and applies the override only in one of several entitlement enforcement paths. That would produce
an inconsistent state: UI and non-metered limits could say Pro Max while provider-backed work still
fails with `no_subscription` or `insufficient_credits`.

## Product contract

### Scope

Entitlements are organization-scoped in BuilderHunt. Therefore “every signed-in user” means every
authenticated request in a valid organization context. A person belonging to multiple
organizations receives beta access independently in each selected organization. Anonymous
requests and requests without an active organization membership receive nothing.

### Effective access

When beta mode is enabled:

- `free` and `pro` organizations receive an effective product tier of `pro_max`.
- Existing `pro_max` and `team` organizations retain their stored tier. Team is not downgraded.
- The stored `organization_entitlements` row, Stripe subscription, status, billing period, seat
  limit, and operator-grant provenance remain unchanged.
- Beta mode does not increase seat limits or organization membership capacity.
- Existing payment/risk blocks remain authoritative. Beta mode is an entitlement overlay, not a
  bypass for `paymentBlocked`, abuse enforcement, tenant authorization, rate limits, or provider
  safety checks.
- Checkout, portal, refund, dunning, Stripe, and platform-admin provenance continue to use the raw
  entitlement. Tenant billing DTOs preserve raw `tier`/status/period/seat fields but expose
  `effectiveTier`, `betaModeActive`, effective product limits/capabilities, and effective spendable
  balance explicitly. Product feature and product-limit enforcement use the effective entitlement.

When beta mode is disabled, the next authoritative entitlement read uses the raw organization
entitlement again. No restoration migration or per-organization rewrite is required.

### Beta credit allowance

While beta mode is enabled, each organization can receive one **700-unit promotional beta grant per
UTC calendar month**. The grant is:

- stored through the existing `grantCredits` append-only ledger path with `source =
  'promotional'`;
- provisioned just in time before the first non-zero metered reservation in that month;
- idempotent and concurrency-safe for `(organization, UTC month)`;
- usable only while beta mode is enabled and only in its own UTC month;
- expired at the start of the next UTC month by the existing credit-expiry worker;
- not purchasable, refundable, transferable, or eligible as evidence of a paid subscription.

The 700 units are promotional and additive to paid included credits and purchased packs. This is
intentional: paid value must not be reduced or rewritten to make an artificial “exactly 700” total,
and the existing ledger cannot safely claw back already-consumed paid units. Pro Max remains the
feature ceiling; the beta allowance is a temporary credit promotion. Admin copy must say “700 beta
credits per month” rather than “your total balance is capped at 700.”

Disabling beta mode does not delete or mutate the grant. Instead, all spendable-balance and
reservation queries exclude beta grants unless the authoritative flag is enabled and the grant's
`source_reference` matches the current UTC month. This makes disable immediate and reversible:
re-enabling during the same month restores only the unused remainder, while a disabled grant
expires naturally and leaves an auditable ledger trail. Pack and subscription grants remain
eligible throughout.

## Architecture

### 1. Dedicated singleton setting

Create a dedicated global table rather than a generic JSON flag registry:

```sql
CREATE TABLE platform_beta_mode (
  id text PRIMARY KEY CHECK (id = 'global'),
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

INSERT INTO platform_beta_mode (id, enabled)
VALUES ('global', false)
ON CONFLICT (id) DO NOTHING;
```

The table contains no tenant data and has no RLS. Access is grant-controlled:

- `builderhunt_app`, `builderhunt_readonly`, and `builderhunt_worker`: `SELECT` only;
- `builderhunt_platform`: `SELECT`, `INSERT`, and `UPDATE`;
- no runtime role receives `DELETE`.

`updated_by` deliberately has no foreign key: operational history must survive user deletion. The
typed Drizzle definition is `platformBetaMode` in `src/shared/lib/db/schema.ts`.

### 2. Authoritative and display reads

`src/shared/lib/billing/beta-mode.ts` owns the setting contract:

```ts
export interface BetaModeState {
  enabled: boolean
  revision: number
  updatedAt: Date
  updatedBy: string | null
}

export async function getBetaModeState(
  transaction: TenantTransaction,
): Promise<BetaModeState>

export async function getPlatformBetaModeState(): Promise<BetaModeState>

export async function getCachedBetaModeStatus(): Promise<
  Pick<BetaModeState, 'enabled' | 'revision' | 'updatedAt'>
>

export async function setBetaModeState(input: {
  enabled: boolean
  expectedRevision: number
  updatedBy: string
}): Promise<BetaModeState>
```

Authorization and credit reservation always use `getBetaModeState(transaction)` so the setting is
read in the request transaction and never depends on Redis or a stale process cache. The read takes
a transaction-scoped shared advisory lock in a beta-mode-specific key namespace before selecting
the row. The admin write takes the matching exclusive advisory lock before its row lock. This avoids
granting UPDATE to the app role while ensuring disable waits for already-authorized work to finish;
once disable returns no old-state reservation can commit afterward. A missing row is disabled.
A database read error throws a typed availability error and the caller denies provider work; it
must not catch a PostgreSQL statement error and then continue using an aborted transaction.

The dashboard badge may use a five-second in-process cache through
`getCachedBetaModeStatus()` and degrades to disabled with a structured warning if its independent
display read fails. The admin API uses `getPlatformBetaModeState()` directly.
`setBetaModeState` invalidates the local cache. Cross-instance badge lag is therefore at most five
seconds; authorization lag is zero after the state-changing transaction commits.

The write is an explicit desired state, never a blind toggle. It locks the singleton row, compares
`expectedRevision`, returns `409 Conflict` on a stale admin screen, increments `revision` once on a
real transition, and treats a same-state request as an idempotent no-op.

### 3. Raw versus effective entitlement

`getOrganizationEntitlement` remains the raw billing/provenance read. Add:

```ts
export interface EffectiveEntitlementPolicy extends EntitlementPolicy {
  actualTier: EntitlementTier
  betaModeActive: boolean
}

export function applyBetaModeEntitlement(
  actual: EntitlementPolicy,
  beta: Pick<BetaModeState, 'enabled'>,
): EffectiveEntitlementPolicy

export async function getEffectiveOrganizationEntitlement(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<EffectiveEntitlementPolicy>
```

The pure resolver raises only `tier` and `paidActionsAllowed`; it preserves `actualTier`, `status`,
`active`, `seatLimit`, and `paymentBlocked`. `paidActionsAllowed` becomes true for beta access only
when `paymentBlocked` is false. Capability comparison must use the existing
`tierMeetsMinimum()` rank, where Team and Pro Max are equivalent for features; do not introduce a
second contradictory tier ordering.

All product enforcement call sites that currently read `getOrganizationEntitlement` must be
classified explicitly:

- switch product capability/allowance reads to `getEffectiveOrganizationEntitlement`: alerts,
  saved queries, tracked builders, semantic search, sourcing sprints, AI completion/enrichment,
  fingerprint/work-sample analysis. Solutions and interviews already consume
  `checkEntitlement`, so their tier behavior changes at that central boundary rather than through
  another direct entitlement read;
- retain raw reads for seats and organization lifecycle, checkout and raw billing provenance,
  Stripe projection/webhooks, dunning, refunds, operator grants, and admin reporting. Billing
  summary `tier` stays raw, while its product capability/limit projection uses the effective policy.

`feature-authorization.ts` must authorize from the effective entitlement instead of requiring an
active Stripe subscription when beta is on. With beta off, its current `no_subscription` and
`tier_too_low` behavior remains covered by regression tests.

### 4. Real, bounded credit accounting

`src/shared/lib/billing/beta-credits.ts` owns UTC-window derivation and just-in-time provisioning:

```ts
export interface BetaCreditWindow {
  key: string                 // YYYY-MM
  sourceReference: string     // beta-mode:YYYY-MM
  monthlyWindowKey: string    // beta-mode:<organizationId>:YYYY-MM
  expiresAt: Date             // first instant of the next UTC month
}

export function deriveBetaCreditWindow(now: Date, organizationId: string): BetaCreditWindow

export async function ensureBetaMonthlyCreditGrant(
  transaction: TenantTransaction,
  organizationId: string,
  state: Pick<BetaModeState, 'enabled'>,
  now: Date,
): Promise<void>

export async function getClaimableBetaCreditUnits(
  transaction: TenantTransaction,
  organizationId: string,
  state: Pick<BetaModeState, 'enabled'>,
  now: Date,
): Promise<0 | 700>
```

The helper takes a transaction-scoped advisory lock derived from organization id and UTC month,
then calls `grantCredits` with deterministic idempotency and monthly-window keys. Two concurrent
first reservations must create one 700-unit grant and one ledger grant entry, not one success and
one aborted transaction.

The grant remains lazy, but read-only action DTOs must not report “insufficient credits” before the
first reservation can provision it. `getClaimableBetaCreditUnits` returns 700 only when beta is on
and no grant exists for the organization/current monthly-window key; otherwise it returns zero.
The effective spendable balance is persisted eligible units plus this claimable amount. It does not
write from a GET. Reservation still provisions under the advisory lock, so the displayed allowance
cannot become a duplicate grant under concurrency.

Tenant billing summaries expose `betaCreditsClaimableUnits` separately and include it in
`creditBalanceUnits`; `activeCreditGrants` continues to list persisted rows only. This prevents a
virtual allowance from masquerading as a ledger record while keeping action affordability honest.

Credit selection receives an explicit `activeBetaSourceReference: string | null`. Repository SQL
always allows non-beta grants; it allows a `promotional` grant whose source reference starts with
`beta-mode:` only when it exactly matches the active reference. The same predicate is shared by:

- locked grant allocation in `reservations.ts`;
- spendable balance aggregation in `credits.ts`/`billing-ledger.ts`;
- the active-grant projection returned by tenant billing contracts;
- auto-recharge threshold evaluation and the Solutions billing-state adapter.

No product code may call `reservations.ts` directly. The existing
`feature-authorization.reserveCredits` facade reads beta state once, authorizes the effective tier,
provisions the monthly grant for non-zero operations, and passes the exact source reference into
the raw reservation. `feature-authorization.extendReservation` re-reads authoritative beta state
and passes the same eligibility scope before allocating more units; if beta ended, a long-running
provider task must stop when extension is refused. Settlement and release keep using the grants
already allocated to the reservation. Existing abuse limits, rate-card prices, settlement, refund,
release, and reservation idempotency remain unchanged.

### 5. Admin and member surfaces

Add `GET` and `PUT /api/admin/billing/beta-mode`:

- both require `requirePlatformAdminPrincipal`;
- `PUT` also requires `requireRecentPlatformAdminAuthentication`;
- body: `{ enabled: boolean, expectedRevision: number }`, validated with Zod and rejecting unknown
  fields;
- stale revision: `409` with the current state;
- successful transition: durable security audit action
  `admin.billing.beta-mode.enable` or `admin.billing.beta-mode.disable`, target
  `platform_beta_mode/global`, and redacted details `{ from, to, revision, organizationCount }`;
- unsupported methods: `405` with `Allow: GET, PUT`.

`BetaModeControl` is added to the existing `/admin/billing` page. It shows authoritative current
state, revision, last change time, actor id, and explicit enable/disable confirmation. It disables
submission while pending and reloads on `409`.

Add authenticated `GET /api/beta-mode` returning only `{ enabled, revision }`. The dashboard shell
fetches it and passes `betaModeEnabled` through `DashboardLayout` → `ContextTopbar` → `UserMenu`.
The menu displays a text badge “Beta · 700 credits/month” while enabled. No actor, timestamp, raw
entitlement, or billing state is exposed by this endpoint.

## Acceptance criteria

1. A free organization with beta off retains its current feature denials and receives no beta
   grant.
2. The same organization with beta on passes Pro and Pro Max rate-card checks, Pro Max direct
   limits, sees 700 claimable units before its first use, and its first non-zero metered reservation
   creates exactly one 700-unit promotional grant and succeeds when the rate-card cost fits.
3. Two concurrent first reservations create one monthly beta grant and do not overspend it.
4. Team remains Team; seat limits and raw billing tier/status/period fields remain unchanged.
   Tenant DTOs label the effective tier/capability separately, and the organization may use the
   additive promotional allowance without losing paid or pack credits.
5. Payment-blocked, unauthorized, rate-limited, or abuse-blocked requests remain blocked.
6. After disable commits, new balance and reservation queries exclude beta grants immediately.
   Paid and pack grants remain spendable. Re-enable in the same UTC month restores only the unused
   beta remainder.
7. At the next UTC month boundary, an old grant is ineligible even before the expiry worker runs;
   the first new reservation creates one new 700-unit grant with the new expiry.
8. A reservation extension uses the current beta state: it can allocate the current-month beta
   grant while enabled and fails without allocating beta units after disable.
9. The admin write rejects stale revisions, requires recent platform-admin authentication, emits
   the existing durable audit shape (with the established console fallback if persistence fails),
   and never mutates tenant entitlement rows.
10. The badge reflects state within five seconds and disappears on sign-out; anonymous callers of
   `/api/beta-mode` receive the existing tenant-auth error response.
11. Migration replay, migration integrity, RLS/grant probes, type checking, focused unit and
    integration tests, API method coverage, and the beta browser journey all pass.

## Non-goals

- Per-user, per-email, or per-organization beta cohorts.
- Rewriting `organization_entitlements`, Stripe subscriptions, prices, webhooks, checkout, or
  operator-grant provenance.
- Increasing seat limits or bypassing tenant authorization, payment blocks, abuse controls, rate
  limits, or provider safety policy.
- Eagerly scanning every organization when the flag changes. Credits are provisioned just in time.
- A generic feature-flag framework, Redis dependency, beta analytics pipeline, toast history, or
  product UI redesign.
- Deleting beta credit history on disable. Append-only ledger history is retained and grants expire
  through the existing worker.

## Rollout and rollback

Ship the schema and code with the seeded state disabled. Verify raw/effective parity while disabled,
then enable only from the admin control after the migration and worker are healthy. Observe
authorization denials, credit-grant idempotency conflicts, reservation failures, and provider cost
for the first hour.

Operational rollback is the same authenticated admin `PUT` with `enabled: false`; do not use ad-hoc
SQL as the normal runbook. If the UI is unavailable, a platform operator may update the singleton
row in a reviewed transaction and must add the equivalent audit event. Code rollback leaves the
additive table and ledger rows in place. Applied migrations and ledger entries are never edited or
deleted.
