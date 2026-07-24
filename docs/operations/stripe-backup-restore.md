# Stripe Billing Backup and Restore — Operator Runbook

> This is the OPERATOR "break glass, what do I actually run" quick-reference. For the full
> engineering rationale (why rollback stops being safe once real rows exist, the append-only ledger
> invariant, checksum evidence methodology), see `docs/operations/stripe-database-migration.md` — do
> not duplicate that reasoning here, just point at it.

## Before you touch anything

Confirm which situation you're actually in — the correct action is different for each:

| Situation | Correct action |
| --- | --- |
| A migration needs to be undone, and **no real Stripe event or Checkout has ever been processed** against this database | Additive rollback is genuinely safe — see `stripe-database-migration.md`'s "financial-write threshold". |
| A migration needs to be undone, and **real billing rows exist** | Rollback is NOT an option. Write a new forward-repair migration instead (compensating-entry pattern, same doc's "Forward repair" section). |
| The database itself is corrupted/lost and needs restoring from backup | Follow "Restoring from a real backup" below. |
| You just want to verify the restore path still works (routine drill, not an actual incident) | Run the rehearsal script — "Restore rehearsal" below — never against a real database. |

## Restore rehearsal (routine, safe to run anytime)

```sh
TEST_MIGRATION_URL=postgresql://.../builderhunt_security_test_source pnpm test:migrations:local
RESTORE_TEST_SOURCE_URL=postgresql://.../builderhunt_security_test_source \
RESTORE_TEST_TARGET_URL=postgresql://.../builderhunt_security_test_target \
pnpm db:restore-test
```

This ONLY ever targets `builderhunt_security_test_*` database names (`restore-policy.ts`'s
`assertRestoreTestTargets` refuses anything else) — there is no real-data risk from running this. It
seeds one organization's billing state, checksums it, does a real `pg_dump`/`pg_restore` round trip,
and re-verifies the checksum matches post-restore. A checksum mismatch here is the actual "does
backup/restore work" evidence — not a row-count proxy.

## Restoring from a real backup (an actual incident)

1. Confirm the actual backup file/snapshot you're restoring from — check its timestamp against when
   the corruption/loss happened; restoring a backup from BEFORE a known-good state loses real,
   already-processed billing activity.
2. Restore into a NEW, isolated database first — never directly over the live production database.
   Use the same `pg_restore --clean --if-exists` approach `restore-test.ts` exercises.
3. Verify RLS is enabled and forced on every tenant-private table post-restore (the restored dump
   preserves table structure, but confirm it explicitly — don't assume) — the same 11 billing tenant
   tables `restore-test.ts` checks, per `database-roles.md`.
4. Spot-check a sample of real `billing_credit_grants`/`billing_ledger_entries` rows against
   whatever independent record exists (Stripe Dashboard's own event/object history is the ultimate
   source of truth for anything Stripe-side) before cutting production traffic over.
5. Once verified, cut over (connection string swap + deploy, or a DB-level promote depending on your
   hosting setup — this repo doesn't prescribe the infrastructure mechanics, only the data-integrity
   verification steps above).
6. Immediately after cutover, run (or wait for) the next `runReconciliation` pass — a restore from
   even a few minutes before the incident WILL show drift against whatever Stripe processed in the
   gap; that drift is expected and is exactly what reconciliation's mismatch/repair reporting is for,
   not a sign the restore itself failed.
7. Record the incident in `stripe-incident-response.md`'s change log.

## Retention

Danish bookkeeping law requires invoice/accounting records for 5 years (flagged, still `_pending_`
confirmation of the exact schedule, in `stripe-launch-register.md`'s "Support and operations" table).
This governs how long backups/exports must be retrievable, not just how long the live database keeps
rows — confirm the actual retention schedule with whoever owns Danish compliance before finalizing a
backup-rotation policy that could delete anything within that window.
