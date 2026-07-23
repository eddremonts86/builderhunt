# Stripe Billing Database Migration: Backup, Restore, and Rollback

Extends the general rules in `docs/operations/database-migrations.md` (migrations are immutable once
a shared environment applies them; forward recovery, not edited history) with the billing-specific
question those rules don't answer on their own: **when is it still safe to roll a billing migration
back, and when must a mistake instead be fixed forward?**

## The financial-write threshold

`0027_overconfident_angel.sql` (table creation) and `0028_billing_rls_grants.sql` (RLS/runtime-role
grants) are both purely additive — no existing table, column, or row is touched. That makes rollback
trivially safe **only while every one of the 14 `billing_*` tables is still empty**: dropping the
tables back out (or simply never applying the migration in a given environment) discards nothing,
because nothing real has been recorded yet.

The moment any of these tables holds a real row — a `billing_customers` row backed by an actual Stripe
Customer, a `billing_credit_grants`/`billing_ledger_entries` pair from a real granted or consumed
credit, a `billing_subscriptions` row mirroring a real Stripe subscription — **rollback stops being an
option**. Dropping `billing_ledger_entries` after even one real ledger entry exists would silently
destroy the only durable record of a credit grant or consumption, with no way to reconstruct it except
by re-deriving it from Stripe (which may itself have already moved on, e.g. a subsequent webhook
already consumed the row this rollback would have deleted). This is exactly the append-only invariant
`billing_ledger_entries` enforces at the schema level (no `updatedAt` column, no role — not even
`builderhunt_worker` — ever receives an UPDATE grant on it; see `docs/operations/database-roles.md`).

**Practical rule**: additive rollback is permitted only in an environment that has never processed a
real Stripe event or served a real Checkout session against these tables — i.e., before
`STRIPE_BILLING_ENABLED=true` is ever set to `true` against that environment's database. After that
point, any correction is a forward migration: a new additive migration that repairs, backfills, or
compensates, following the same `billing_ledger_entries` compensating-entry pattern the runtime itself
uses for user-facing corrections (spec.md: "mistakes use compensating entries only").

## Restore rehearsal and checksum evidence

`scripts/db/restore-test.ts` (`pnpm db:restore-test`) proves the dump/restore path preserves billing
state exactly, not just that the schema shape survives:

1. Seeds one organization's worth of billing state into the source database — a customer, a
   subscription, a credit grant, and the two ledger entries that grant and partially consume it (a
   `grant` entry and a `consume` entry, exercising the append-only, non-negative-remaining invariants).
2. Computes a sha256 checksum over those exact rows (kind, id, and a reference/units field) before the
   dump.
3. Runs a real `pg_dump --format=custom` / `pg_restore --clean --if-exists` round trip between two
   explicitly named `builderhunt_security_test_*` databases (never anything else —
   `assertRestoreTestTargets` in `src/shared/lib/db/restore-policy.ts` refuses any other pair, and
   further refuses a same-host mismatch or identical source/target).
4. After restore, re-asserts the migration count, re-checks that RLS is enabled and forced on every
   tenant-private table (including all 11 billing tenant tables — the 3 system-operational ones,
   `billing_webhook_events`/`billing_reconciliation_runs`/`billing_seller_profiles`, correctly have no
   RLS since they have no `organization_id`), and recomputes the same checksum against the restored
   target. A mismatch fails loudly — this is the "ledger/event/reference integrity" evidence, not a
   row-count proxy for it.

Run it locally against two disposable databases on the same Postgres server:

```sh
TEST_MIGRATION_URL=postgresql://.../builderhunt_security_test_source pnpm test:migrations:local
RESTORE_TEST_SOURCE_URL=postgresql://.../builderhunt_security_test_source \
RESTORE_TEST_TARGET_URL=postgresql://.../builderhunt_security_test_target \
pnpm db:restore-test
```

The migration count and RLS table list in `restore-test.ts` are hand-maintained, not derived from
`schema.ts` — update both whenever a migration is added or a new tenant-private table ships (this file
was already stale by nine migrations and every billing table before this pass; re-verify the count
matches `drizzle/meta/_journal.json` before trusting a run).

## Forward repair after financial writes exist

Once real financial rows exist, a schema mistake is fixed the same way every other migration in this
codebase is: a new, additive, forward migration. For billing specifically:

- **Wrong CHECK constraint or missing index**: add a new migration that alters the constraint/adds the
  index. Never edit `0027`/`0028` in place.
- **Wrong or corrupted ledger data**: never `UPDATE`/`DELETE` a `billing_ledger_entries` row, even via
  a migration — insert a compensating entry (`entry_type = 'adjust'`) referencing the row it corrects,
  exactly as the runtime's own `refundUsage`/dispute-handling paths do.
- **RLS/grant gap discovered late** (the pattern `drizzle/0024_sourcing_sprints_grants.sql` already
  established for `sourcing_sprints`): a new migration adding the missing `CREATE POLICY`/`GRANT`
  statements — never retroactively edit `0028`.
- **Reconciliation mismatch** (Stripe and internal state disagree): `billing_reconciliation_runs`
  records the mismatch and any repair action taken; the repair itself is always a normal application
  write through `builderhunt_worker`/`builderhunt_platform`, never a manual database edit.

Before any of these run against a database that has processed real Stripe events, take a fresh
encrypted backup and rehearse the restore (this script) first, per the general policy in
`docs/operations/database-migrations.md`.
