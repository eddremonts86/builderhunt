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

## pgvector (semantic-search plan)

The `builder_embeddings` table requires the Postgres `vector` extension. Local dev's
`docker-compose.yml` already runs `pgvector/pgvector:pg16` (same Postgres 16 major as before —
the existing data volume is compatible, no export/import needed).

**Before applying this feature's migration in production**: the managed Postgres resource
(Coolify, on Hetzner) must also run a pgvector-enabled image or have the extension installed.
Steps:
1. Take a fresh encrypted backup and verify a restore rehearsal succeeds (standard gate above).
2. Switch the Coolify Postgres resource's image to `pgvector/pgvector:pg16`. The data volume
   persists across the image swap since the Postgres major version is unchanged.
3. Confirm `CREATE EXTENSION IF NOT EXISTS vector;` succeeds, then apply this plan's migration.

If the extension is missing, the app fails soft: `/api/search/semantic` returns
`503 { error: 'semantic_unavailable' }` and the UI falls back to keyword search — this is not an
outage, but semantic search stays disabled until the operator step above is done.


