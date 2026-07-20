# Database Migration Operations

Migration files are immutable after any shared environment applies them. Use forward recovery; do
not edit history or run schema push in production. The rollout sequence is expand, resumable
backfill, dual write, shadow read, RLS rehearsal, canonical cutover, constraint validation, one full
compatibility release, then contract.

Use `DATABASE_MIGRATION_URL` only in the migration job. A backfill refuses production unless
`--confirm-production` is present; that flag records operator intent but does not replace change
approval. Always begin with `--dry-run`, a fresh encrypted backup, a successful restore rehearsal,
row counts, batch/lock/statement budgets, and a conflict policy.

Local verification uses a disposable database named `builderhunt_security_test_*`:

```sh
TEST_MIGRATION_URL=... pnpm test:migrations:local
RLS_TEST_APP_URL=... RLS_TEST_AUTH_URL=... pnpm test:rls:local
```

Both scripts refuse any other database name. Backfills use stable cursors, small transactions,
checkpoint counters, retryable forward execution, and non-sensitive conflict checksums. A rerun of a
completed backfill must write nothing.

