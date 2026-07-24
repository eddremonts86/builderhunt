# Migrating Manual Entitlements Without Charging

## Scope decision — read this first

`src/shared/lib/billing/legacy-migration.ts`'s module comment documents the finding that governs
this whole task: `feature-authorization.ts`'s `checkEntitlement` gates every credit-consuming
feature (AI sourcing sprints, semantic search) on a REAL, active `billing_subscriptions` row —
`organization_entitlements.tier` and credit balance are never consulted for that gate. A manually
granted organization has no `billing_subscriptions` row and never will until it completes real Stripe
Checkout.

**This means importing a manual entitlement as a `legacy_manual` credit grant changes NO access
whatsoever.** A legacy organization's feature access continues exactly as it does today, gated by
whatever legacy code path already reads `organization_entitlements.tier`/`billing-shared.ts`'s
`PLAN_LIMITS`. The `legacy_manual` grant this migration creates is pure audit bookkeeping: a
structured, queryable record of "this organization has this much manually-granted allowance,
expiring on this date," in the same schema real Stripe grants live in — replacing what was
previously only a free-text `organization_entitlements.notes` value with no structure. This is why
`accounting-export.ts`'s unexpired-credit-liability figure and `operations-metrics.ts`'s ledger
invariant check now have visibility into legacy organizations too.

Creates no Stripe Customer, subscription, or charge — ever.

## What gets imported

`scripts/db/backfills/stripe-billing-legacy.ts` scans `organization_entitlements` for rows with
`tier != 'free'` and no active (`canceled_at is null`) `billing_subscriptions` row. For each:

- **Free tier** → `skipped_free_tier` (nothing to migrate).
- **Already has a real subscription** → `skipped_already_has_subscription` (manual authority was
  already superseded — see "Atomic cutover" below).
- **`pro`/`team` tier** → creates one `billing_credit_grants` row, `source: 'legacy_manual'`:
  - `units` = the equivalent monthly credit allotment from the immutable catalog
    (`pro_monthly`/`team_monthly`'s `monthlyCredits` — 140/2100 respectively).
  - `expiresAt` = the entitlement's `currentPeriodEnd`, or `trialEndsAt` if no period end, or **ten
    years out** if neither is set (a legacy grant with no defined end is a genuinely valid state in
    the old manual system — spec.md's "remain valid until their current end" doesn't distinguish
    that from a time-boxed grant, and `billing_credit_grants.expiresAt` is NOT NULL, so something
    must be written).
  - `monthlyWindowKey` = `legacy:${organizationId}` — globally unique, one-time, the actual dedup
    mechanism for reruns.
- **An unresolvable tier** (e.g. `pro_max` with no subscription — never manually grantable, a real
  data anomaly) → `conflict_unresolvable_tier`, quarantined in `migration_backfill_conflicts`.

## Atomic cutover — voluntary Checkout ends manual authority

`endOverlappingManualAuthority` (`legacy-migration.ts`) is called from
`webhook-handlers.ts`'s `handleSubscriptionUpsert`, in the exact same transaction as the FIRST
subscription ever created for an organization — the moment voluntary Checkout activation completes.
`projectSubscriptionEntitlement` (already existing, §7) atomically overwrites
`tier`/`status`/`billingPeriod`/period columns via its single-row upsert; `endOverlappingManualAuthority`
covers exactly what that call deliberately leaves untouched:

- Clears `organization_entitlements.trialEndsAt`/`notes` (stale manual-era values that would
  otherwise survive on a real subscriber forever).
- Expires any still-`active` `legacy_manual` credit grant, so it can never stack against the new
  subscription's own credits ("without duplicating access or credits", spec.md).

A no-op for an organization that never had manual authority.

## Running the backfill

```sh
pnpm db:backfill:stripe-billing-legacy -- --dry-run --batch-size=250
pnpm db:backfill:stripe-billing-legacy -- --batch-size=250
```

Mirrors every sibling script's exact conventions (`scripts/db/backfills/organizations.ts`):
resumable via a single `migration_backfill_runs` row (`for update` cursor read each batch),
`--confirm-production` required in production, conflicts quarantined in `migration_backfill_conflicts`.

**Dry-run is a genuine no-write path**, not a simulate-then-rollback one:
`importLegacyEntitlementAsCredits`'s `dryRun: true` mode runs every read-side check (subscription
lookup, tier resolution, existing-grant lookup) and reports `would_migrate` instead of `migrated`
without ever calling `grantCredits`. Verified live against this repo's own dev database: a dry run
against 17 real manually-tiered organizations left `billing_credit_grants` at 0 rows before and after;
the real run then created exactly 17 rows; a full rescan afterward reported all 17 as
`skipped_already_migrated` with zero new rows and the **identical** checksum as the original run.

### Checksum

`migration_backfill_runs.checksum` is a stable sha256 hash (`computeLegacyMigrationChecksum`) over
the sorted `(organizationId, tier, units, expiresAt)` tuples of every CURRENTLY migrated organization
— queried fresh from `billing_credit_grants`/`organization_entitlements` after the run completes, not
just what this particular invocation newly granted. This is what makes it genuinely stable across
reruns: a rerun that migrates zero new rows (everything already done) still recomputes the checksum
over the same persisted, unchanged data and gets the same value. (A dry run has nothing persisted to
query, so it checksums the simulated `would_migrate` set instead.)

## Data model

No schema change was needed — this task writes only to the pre-existing `billing_credit_grants`/
`billing_ledger_entries` (via the already-tested `grantCredits`) and `organization_entitlements`
(via `endOverlappingManualAuthority`'s targeted `trialEndsAt`/`notes` clear).
