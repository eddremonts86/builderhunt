# PostgreSQL 18 Upgrade (tasks)

> **Status**: `pending`
> **Depends on**: nothing — but see [`spec.md`](./spec.md) §1: tasks in Phase 5 and 6 must not be executed before Phase 4 is complete and observed.
> **Blocks**: nothing today; Phase 4 is the gate for any other plan's use of PG18-only SQL.
> **Reality check**: `docker-compose.yml:8`, `.github/workflows/quality.yml:16` and `docs/operations/deploy-runbook.md:68` all pin `pgvector/pgvector:pg16`. `pnpm deploy:db` (`scripts/deploy/orchestrate.mjs`) is the only sanctioned provisioning path and has no version check. Restore rehearsal exists (`pnpm db:restore-test`); the daily backup (`scripts/db/backup.ts`) dumps with `--no-owner --no-acl` and is not usable as an upgrade vehicle.

Every task below is executable top-to-bottom. Migration indices are written as `NNNN` — the next
free index at execution time (`drizzle/` currently ends at `0064_profile_removal_grants.sql`,
itself uncommitted). Never hardcode an index; let `drizzle-kit generate` allocate it.

## Phase 0 — Rehearsal on a throwaway PG18 cluster

- [ ] **Stand up a scratch PG18 cluster and provision it from migrations**
  - Files: none (throwaway compose override or a bare `docker run`)
  - Do: run `pgvector/pgvector:0.8.5-pg18` on a scratch volume and port (e.g. 5433), then point
    `DATABASE_MIGRATION_URL` + the four role URLs at it and run `pnpm deploy:db`. Do **not** reuse
    `builderhunt_postgres_data`.
  - Verify: all 7 orchestrator steps pass, including step 3 (`CREATE EXTENSION vector`) and step 6
    (every runtime role authenticates). `SELECT extversion FROM pg_extension WHERE extname='vector'`
    returns `0.8.5`; `SHOW server_version` reports 18.x.

- [ ] **Confirm the migration role is a superuser (the RLS-restore precondition)**
  - Files: none
  - Do: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;` on the
    `DATABASE_MIGRATION_URL` connection.
  - Verify: `rolsuper` is `t`. If it is not, stop — a data-only restore cannot proceed
    (`drizzle/0008_tenant_rls.sql` forces RLS and `builderhunt_owner` is `NOBYPASSRLS NOLOGIN`).

- [ ] **Prove the RLS failure mode deliberately, so the mitigation is evidence-backed**
  - Files: none
  - Do: attempt `pg_restore --data-only` of one tenant table (e.g. `saved_queries`) as
    `builderhunt_app` instead of the superuser.
  - Verify: the insert is rejected or lands zero rows, and record the exact error in the runbook
    task below. This is spec.md §5 blocker 2; it must be observed, not assumed.

- [ ] **Assert collation parity between source and target cluster**
  - Files: `scripts/db/pg18/row-counts.mjs` (new — add a second mode, or a sibling `locale-check` output)
  - Do: compare `SELECT datcollate, datctype, datlocprovider, daticulocale FROM pg_database WHERE
    datname = current_database()` on the pg16 source and the pg18 target, plus
    `SHOW lc_collate` / `SHOW server_encoding`. `initdb` runs inside the image with whatever locale
    the image defaults to, and the target cluster is created fresh rather than upgraded in place —
    so nothing structurally guarantees they match.
  - Verify: all fields identical. **If they differ, stop.** A different collation changes text
    `ORDER BY` results and the equality semantics behind every unique index on a text column
    (`builder_identities_source_source_id_unique`, `builders_user_source_unique`,
    `conversion_events_identity_unique`, …) — meaning a restore can either fail on a duplicate that
    was not a duplicate before, or silently start sorting differently in the UI. Fix by creating the
    target database with an explicit `LC_COLLATE`/`LC_CTYPE`/locale provider matching the source,
    then re-run `pnpm deploy:db` on it.

- [ ] **Add a row-count parity script**
  - Files: `scripts/db/pg18/row-counts.mjs` (new)
  - Do: connect with a URL from `argv[2]`, `SELECT` an exact `count(*)` per table in schema
    `public` (enumerate from `information_schema.tables`, `BASE TABLE` only), print sorted
    `table<TAB>count` to stdout. No writes, no env-var magic — it must be diffable.
  - Verify: `node scripts/db/pg18/row-counts.mjs "$PG16_URL" > /tmp/before.tsv` produces one line
    per table and `wc -l` matches the table count reported by `pnpm db:audit-schema`.

- [ ] **Run the full dump/restore pipeline once, end to end**
  - Files: none (commands go into the runbook in Phase 2)
  - Do: from a one-shot `pgvector/pgvector:0.8.5-pg18` container:
    (1) `DROP INDEX builder_embeddings_hnsw_idx` on the target;
    (2) `pg_dump -Fc --data-only --schema=public "$SOURCE_URL" -f /tmp/data.dump`;
    (3) `pg_restore --data-only --disable-triggers --single-transaction -d "$TARGET_SUPERUSER_URL" /tmp/data.dump`;
    (4) `CREATE INDEX builder_embeddings_hnsw_idx ON builder_embeddings USING hnsw (embedding vector_cosine_ops)` with `SET maintenance_work_mem` raised;
    (5) `ANALYZE`.
  - Verify: `pg_restore` exits 0 with no ignored errors; `row-counts.mjs` output for source and
    target diffs empty; record dump size and total wall time — that number is the write-freeze
    budget Phase 3 refines and Phase 4 spends.

- [ ] **Confirm the journal-collision mitigation is required, not superstition**
  - Files: none
  - Do: repeat step 2 of the pipeline **without** `--schema=public` on a second scratch target and
    observe the outcome for `drizzle.__drizzle_migrations`.
  - Verify: the restore aborts on a duplicate-key conflict (spec.md §5 blocker 3). Record the
    error text; if it does *not* abort, correct the spec instead of keeping an unearned claim.

## Phase 1 — Dev + CI onto PG18 (no PG18-only SQL)

- [ ] **Bump the local Postgres image and pin pgvector**
  - Files: `docker-compose.yml`
  - Do: `image: pgvector/pgvector:pg16` → `pgvector/pgvector:0.8.5-pg18`. Leave the
    `max_connections=200` command, the healthcheck and the volume name unchanged; add a short
    comment that the pgvector version is pinned because `plans/phase-2/README.md` reasons about
    0.8.5-specific HNSW behaviour.
  - Verify: `docker compose --profile standalone down -v && pnpm db:up && pnpm deploy:db` succeeds
    on a fresh volume; `psql -c 'SHOW server_version'` reports 18.x.

- [ ] **Move CI to a two-version DB matrix**
  - Files: `.github/workflows/quality.yml`
  - Do: parameterise the `postgres` service image over
    `[pgvector/pgvector:0.8.5-pg16, pgvector/pgvector:0.8.5-pg18]` (both pinned) so every DB job
    runs twice. Keep every `DATABASE_*` env value unchanged.
  - Verify: a pushed branch shows two green DB jobs; the pg16 leg keeps proving the code runs on
    production's current version, which is the whole point until Phase 4.

- [ ] **Document the local reset (the PG16 volume is not readable by PG18)**
  - Files: `docs/operations/deploy-runbook.md`, `docs/operations/database-migrations.md`
  - Do: add the reset recipe — `docker compose --profile standalone down -v` → `pnpm db:up` →
    `pnpm deploy:db` → `pnpm db:seed:admin` — and a warning that `pnpm db:up` silently no-ops when
    a `workspace-postgres` container is running (`package.json:22`), so that cluster's major
    version is outside this repo's control.
  - Verify: a developer following only the runbook gets from a PG16 volume to a working PG18 dev
    database without reading this plan.

- [ ] **Run the whole gate on PG18**
  - Files: none
  - Do: `pnpm test && pnpm type-check && pnpm lint && pnpm test:migration-integrity` and, against
    the PG18 dev cluster, `pnpm test:migrations:local`, `pnpm test:rls:local`,
    `pnpm test:api-isolation:local`.
  - Verify: all green; `test:api-isolation:local` still reports 86/86; no new warnings from
    `drizzle-kit migrate` or from postgres.js on 18.

- [ ] **Re-verify the HNSW plan-shape regression test on PG18**
  - Files: `src/shared/lib/repositories/public-builder-embeddings.test.ts` (read; edit only if PG18
    changes the plan text it matches)
  - Do: run the file against the PG18 cluster. PG18 adds an `Index Searches: N` line to index-scan
    plans; confirm the existing `toContain('Index Scan using builder_embeddings_hnsw_idx')` /
    `not.toContain('Sort Key:')` assertions are unaffected.
  - Verify: the file passes unmodified. If a string assertion breaks, fix the assertion — never the
    query shape, which is load-bearing (see the doc comment at
    `public-builder-embeddings.ts:85-100`).

- [ ] **Rehearse the restore harness against a PG18 target**
  - Files: none
  - Do: `RESTORE_TEST_SOURCE_URL=<pg16> RESTORE_TEST_TARGET_URL=<pg18 scratch> pnpm db:restore-test`.
  - Verify: exits 0. If it fails, the failure belongs in Phase 2's runbook as a known constraint
    of the harness — do not proceed to Phase 2 with an unexplained red rehearsal.

## Phase 2 — Production runbook + standing PG18 resource (no cutover)

- [ ] **Correct the two stale claims in the migration doc**
  - Files: `docs/operations/database-migrations.md`
  - Do: in the pgvector section, keep the 16→16 image-swap history but state plainly that a
    16→18 swap is **not** volume-compatible and requires the cutover procedure below. Add: the
    daily `scripts/db/backup.ts` dump (`--no-owner --no-acl`, no `pg_dumpall --globals-only`) is a
    disaster-recovery artifact for the *same* cluster and must never be used as the upgrade
    vehicle, because roles are cluster-global and grants are stripped.
  - Verify: grep the file for `pg16` and confirm no remaining sentence implies an image bump alone
    is sufficient.

- [ ] **Write the cutover runbook**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: new section "PostgreSQL 16 → 18 cutover" containing: create the second Coolify Postgres
    resource on `pgvector/pgvector:0.8.5-pg18` with its own persistent volume; run `pnpm deploy:db`
    against it; the `rolsuper` assertion; the exact five-command pipeline from Phase 0 with the
    `--schema=public` / `--disable-triggers` / `--single-transaction` flags and *why each one is
    there*; `ANALYZE`; HNSW recreate; `row-counts.mjs` parity; the five `DATABASE_*_URL` vars to
    repoint; the point-of-no-return acknowledgement; and the rollback path. Update the "Image
    **must** be `pgvector/pgvector:pg16`" line at `:68` to the pinned pg18 tag once Phase 4 lands
    (flag it as pending until then).
  - Verify: an operator who has never read this plan can execute the section unaided; every flag in
    the pipeline has a one-line reason next to it.

- [ ] **Create and provision the standing production PG18 resource**
  - Files: none (Coolify operator work)
  - Do: create the resource on `pgvector/pgvector:0.8.5-pg18` with a named persistent volume,
    confirm redeploying the app does not recreate it, then run `pnpm deploy:db` against it with the
    production role passwords from Coolify env.
  - Verify: 7/7 orchestrator steps pass in the real environment — which is also the honest proof
    that migrations 0000–NNNN apply cleanly on 18 in production conditions. `rolsuper` is `t` for
    the migration role. The resource holds the full schema and zero application rows.

- [ ] **Announce the window and pre-stage the freeze**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: document exactly which VPS cron entries to pause (the HTTP-cron worker triggers) and that
    stopping the app resource is the write freeze, since all background work is HTTP-triggered and
    idempotent. Note that Stripe webhooks will retry (`billing_webhook_events` has status +
    `next_attempt_at` retry state) and that no tenant is billed today.
  - Verify: the list of cron entries in the runbook matches the actual crontab on the VPS.

## Phase 3 — Full-fidelity rehearsal against production data

- [ ] **Rehearse on a scratch copy of real production data**
  - Files: none
  - Do: take a fresh production backup, provision a *third* scratch PG18 database (never the
    standing cutover target), and run the pipeline end to end — **starting with the collation
    parity assertion against real production**, since Phase 0 only proved it for a local cluster.
    Capture dump size, dump time, restore time, HNSW rebuild time, `ANALYZE` time.
  - Verify: `row-counts.mjs` diff between production and the scratch target is empty; the total
    wall time is recorded in the runbook as the write-freeze budget.

- [ ] **Exercise the app against the rehearsed database**
  - Files: none
  - Do: point a local production-mode build at the scratch PG18 database and walk login,
    dashboard, keyword search, `POST /api/search/semantic`, alerts, exports, and one admin page.
  - Verify: no 500s; semantic search returns results (not `503 semantic_unavailable`); a
    tenant-scoped read returns rows through RLS as `builderhunt_app`, proving grants and policies
    survived provisioning; `pnpm test:api-isolation:local` against this database is 86/86.

- [ ] **Compare a real semantic-search result set before and after**
  - Files: none
  - Do: run the same `POST /api/search/semantic` query against production (pg16) and the scratch
    pg18 copy; diff the ordered builder lists.
  - Verify: identical ordering, or any difference explained by HNSW approximation and accepted in
    writing — the same standard `look-alike-sourcing` applied to the ordering fix.

## Phase 4 — Production cutover

- [ ] **Freeze writes**
  - Files: none
  - Do: pause the VPS cron entries listed in the runbook, then stop the Coolify app resource.
  - Verify: `SELECT count(*) FROM pg_stat_activity WHERE usename LIKE 'builderhunt%' AND state <> 'idle'`
    on pg16 returns 0.

- [ ] **Take the pre-cutover dump and record parity input**
  - Files: none
  - Do: `pg_dump -Fc --data-only --schema=public` from pg16 to durable storage, plus a full
    `pg_dump -Fc` (schema included) kept as the rollback artifact, plus
    `row-counts.mjs "$PG16_URL" > before.tsv`.
  - Verify: both dumps exist with non-zero size; `before.tsv` line count matches the table count.

- [ ] **Restore into the standing PG18 resource**
  - Files: none
  - Do: drop `builder_embeddings_hnsw_idx`, run `pg_restore --data-only --disable-triggers
    --single-transaction` as the superuser, recreate the HNSW index, `ANALYZE`.
  - Verify: `pg_restore` exits 0; `row-counts.mjs "$PG18_URL"` diffs empty against `before.tsv`;
    `\d builder_embeddings` shows the HNSW index present.

- [ ] **Verify roles, RLS and tenancy on the target before repointing**
  - Files: none
  - Do: connect as each of `builderhunt_app` / `auth` / `worker` / `platform`, and run one
    tenant-scoped read inside a transaction that sets `app.organization_id` for a real
    organization.
  - Verify: every role authenticates; the tenant read returns that organization's rows and zero
    rows for a second organization id (the negative half of the tenant A/B check required by
    `_meta/security-policy.md`).

- [ ] **Acknowledge the point of no return, then repoint and redeploy**
  - Files: none
  - Do: record in the deploy log that from this point rollback costs post-cutover writes. Then
    repoint `DATABASE_URL`, `DATABASE_AUTH_URL`, `DATABASE_WORKER_URL`, `DATABASE_PLATFORM_URL`,
    `DATABASE_MIGRATION_URL` in Coolify to the pg18 resource and redeploy the app.
  - Verify: `post_deployment_command` (`pnpm deploy:db`) passes 7/7 as a no-op plus role-password
    re-provision; `/api/health` is green; login works.

- [ ] **Unfreeze and soak**
  - Files: none
  - Do: unpause the VPS cron entries. Watch for one soak period: error rate, `/api/health`,
    semantic-search p95, `pg_stat_io` deltas, and that each HTTP-cron worker completes one tick.
  - Verify: p95 no worse than the pre-cutover baseline; no role-authentication errors; every
    worker's next tick logs a normal completion.

- [ ] **Retire the pg16 resource on a schedule, not immediately**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: stop (do not delete) the pg16 resource and its volume; record the retention date after
    which it is deleted, and update the `:68` image line to the pinned pg18 tag.
  - Verify: the runbook states the retention date and that the volume still exists until then.

## Phase 5 — Feature adoption (only after Phase 4 is observed)

- [ ] **Switch four append-heavy uuid PKs to `uuidv7()`**
  - Files: `src/shared/lib/db/schema.ts` (lines 167, 411, 673, 892), `drizzle/NNNN_*.sql` (generated)
  - Do: replace `.defaultRandom()` with `.default(sql\`uuidv7()\`)` on `builderSourceSnapshots`,
    `builderProfileViews`, `migrationBackfillConflicts` and `enrichmentEvidence` only. Leave
    `builderProcessingRestrictions` (939) and `billingSellerProfiles` (1494) on
    `gen_random_uuid()` — low volume, and a v7 id discloses creation time on a compliance record.
    Add a one-line comment stating that rule. Then `pnpm db:generate`.
  - Verify: the generated SQL is four `ALTER COLUMN "id" SET DEFAULT uuidv7()` statements and
    nothing else; `pnpm test:migration-integrity` passes (snapshot present);
    `pnpm test:migrations:local` applies it; inserting a row yields an id whose version nibble is
    `7` while pre-existing rows are unchanged.

- [ ] **Benchmark v4 vs v7 insert locality, and record the result either way**
  - Files: `scripts/db/pg18/bench-uuid-defaults.mjs` (new)
  - Do: in a disposable `builderhunt_security_test_*` database, create two clones of
    `builder_profile_views` — one defaulting `gen_random_uuid()`, one `uuidv7()` — insert 200k rows
    into each, and report PK index size (`pg_relation_size`) plus wall time.
  - Verify: the script prints both numbers; paste them into spec.md §3A. A null result is a valid
    outcome and must be written down as one, not quietly dropped.

- [ ] **Return `contentChanged` from the embedding upsert via `RETURNING old/new`**
  - Files: `src/shared/lib/repositories/public-builder-embeddings.ts`
  - Do: append `.returning({ contentChanged: sql<boolean>\`(old.content_hash is distinct from new.content_hash)\` })`
    to the existing `onConflictDoUpdate`, change the signature to `Promise<boolean>`, and return
    `rows[0]?.contentChanged ?? true` (a fresh insert has a NULL `old`, so the expression is
    already `TRUE` — "needs an embedding"). Do not change what the upsert writes.
  - Verify: log or print the SQL drizzle emits and run it against the PG18 dev database; assert
    `TRUE` for a fresh insert, `TRUE` after a document edit, `FALSE` for an identical re-index. Add
    those three cases as a sibling test against the disposable database.

- [ ] **Consume the counter in the write-through indexer**
  - Files: `src/lib/semantic/index-writer.ts`
  - Do: sum the returned booleans per batch and emit one structured log line
    (`log.info('semantic_index_write_through', { seen, changed })`). No behaviour change, no new
    table, no metric backend.
  - Verify: `pnpm test` green; a local search request logs the line with `changed` at 0 on a
    repeated identical search and non-zero on the first.

- [ ] **Test whether skip scan makes `conversion_events_server_day_idx` redundant**
  - Files: `scripts/db/pg18/explain-skip-scan.mjs` (new)
  - Do: seed ≥ 500k realistic `conversion_events` rows into a disposable database, `ANALYZE`, then
    `EXPLAIN (ANALYZE, BUFFERS)` the actual `server_day`-range aggregates the conversion repository
    runs — once with both indexes, once with `conversion_events_server_day_idx` dropped.
  - Verify: the script prints both plans. Redundancy is proven only if the drop leaves an index
    scan on `conversion_events_name_server_day_idx` with `Index Searches: N > 1` and comparable
    timing.

- [ ] **Drop the redundant index — or record the negative result**
  - Files: `src/shared/lib/db/schema.ts` (line 1729), `drizzle/NNNN_*.sql` (generated)
  - Do: if and only if the previous task proved redundancy, remove
    `index('conversion_events_server_day_idx')` and generate the migration (`DROP INDEX`; use
    `CONCURRENTLY` in a hand-edited statement outside a transaction if the table is large enough to
    matter). If it did not, leave the schema alone and write the negative result into spec.md §3C.
  - Verify: either the plans match the pre-drop timing on the seeded database, or spec.md §3C
    carries the recorded reason the index stays.

- [ ] **Document `NOT NULL ... NOT VALID` as the sanctioned expand step**
  - Files: `docs/operations/database-migrations.md`
  - Do: in the expand/contract sequence, specify that adding a `NOT NULL` to a populated table uses
    a named constraint added `NOT VALID` and validated in a separate statement (PG18 stores NOT
    NULL constraints in `pg_constraint`), mirroring the existing CHECK/FK two-step, and note that
    Drizzle cannot express it — so it goes in a hand-written migration as a documented divergence
    from the snapshot, the same way `ON DELETE SET NULL (col)` already does in
    [`saved-search-health`](../saved-search-health/spec.md).
  - Verify: the section names both statements and the lock each one takes.

- [ ] **Add the PG18 observability surface to the runbook and turn on lock-failure logging**
  - Files: `docs/operations/deploy-runbook.md`, `docker-compose.yml`
  - Do: document `pg_stat_io` and `pg_aios` as the before/after evidence for DB work; add
    `-c log_lock_failures=on` to the compose `command:` (and the equivalent in the Coolify
    resource) so a migration that loses a lock race says so. Add an explicit note: **never set
    `io_method=io_uring` under Docker** — the default seccomp profile blocks `io_uring_setup`;
    `worker` is the default and is correct here.
  - Verify: `SHOW log_lock_failures` returns `on` locally; `SELECT * FROM pg_aios LIMIT 1` and
    `SELECT * FROM pg_stat_io LIMIT 1` both succeed.

## Phase 6 — Enforce the floor

- [ ] **Add a server-version assertion to the deploy orchestrator**
  - Files: `scripts/deploy/orchestrate.mjs`
  - Do: new step between "Waiting for database" (`:140`) and "Ensuring database exists" (`:166`):
    read `current_setting('server_version_num')::int`, compare against
    `Number(process.env.DEPLOY_DB_MIN_PG_MAJOR ?? 18) * 10000`, and exit fatally below it with the
    detected version, the expected floor and a pointer to the runbook cutover section. Print the
    detected version on success. Honour `--dry-run` (print the plan, open no connection). Read the
    env var from `process.env` directly — it is ops-only and must not enter
    `src/shared/lib/env.ts`.
  - Verify: `pnpm deploy:db:dry` prints the new step without connecting; against a PG18 database it
    passes and logs `server_version`; against a PG16 database it fails with the remediation
    message; with `DEPLOY_DB_MIN_PG_MAJOR=16` it passes on both.

- [ ] **Drop pg16 from the CI matrix**
  - Files: `.github/workflows/quality.yml`
  - Do: reduce the matrix to `pgvector/pgvector:0.8.5-pg18` now that production is on 18.
  - Verify: CI green with a single DB job; total runtime returns to roughly its pre-Phase-1 value.

- [ ] **Refresh the plan-reality documents**
  - Files: `plans/_meta/app-reality.md`, `plans/phase-2/README.md`, `plans/phase-2/postgres-18-upgrade/spec.md`
  - Do: update the DB line in `app-reality.md` (version, pinned image, migration/table counts as
    re-verified at that moment), and set this plan's three headers to `implemented` with a short
    "Delivered" section replacing the future tense, per `_meta/conventions.md` rule 2.
  - Verify: grep `plans/` for `pgvector/pgvector:pg16` returns only historical references that are
    explicitly labelled as history.
