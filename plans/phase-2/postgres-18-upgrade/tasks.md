# PostgreSQL 18 Upgrade (tasks)

> **Status**: `pending`
> **Depends on**: nothing — but see [`spec.md`](./spec.md) §1: tasks in Phase 5 and 6 must not be executed before Phase 4 is complete and observed.
> **Blocks**: nothing today; Phase 4 is the gate for any other plan's use of PG18-only SQL.
> **Reality check** (re-verified 2026-07-27): `docker-compose.yml:8`, `.github/workflows/quality.yml:16` and `docs/operations/deploy-runbook.md:87` all pin `pgvector/pgvector:pg16`. `pnpm deploy:db` ([`scripts/deploy/orchestrate.mjs`](../../../scripts/deploy/orchestrate.mjs), 8 steps) is the only sanctioned provisioning path and has no version check (`grep -rn server_version src/ scripts/ drizzle/` → 0). Restore rehearsal exists (`pnpm db:restore-test`) and a roles-first restore path exists (`pnpm db:restore`, `scripts/db/roles.sql`, `docs/operations/database-restore.md`); the daily local backup ([`scripts/db/backup.ts:56`](../../../scripts/db/backup.ts)) still dumps with `--no-owner --no-acl` and is not usable as an upgrade vehicle.

Every task below is executable top-to-bottom.

**Before you start, re-derive three numbers** — this file was written 2026-07-26 and re-verified
2026-07-27, and they move with every migration:

```bash
ls drizzle/*.sql | wc -l                                # migrations (86 on 2026-07-27)
jq '.entries | length' drizzle/meta/_journal.json       # must equal the above
grep -c 'pgTable(' src/shared/lib/db/schema.ts          # tables (95 on 2026-07-27)
```

Migration indices are written as `NNNN` — the next free index at execution time (`drizzle/`
currently ends at `0085_candidate_documents_rls_grants.sql`; `0084` and `0085` are untracked
working-tree WIP). Never hardcode an index; let `drizzle-kit generate` allocate it.

**Non-negotiable across every phase: every Postgres image named below is a `pgvector/pgvector:*`
image.** A plain `postgres:18*` image makes `drizzle/0013`'s `CREATE EXTENSION vector` fail inside
`drizzle-kit migrate` and rolls back the entire migration chain — this has already taken production
down once. Orchestrator step 3 only *warns*, so the mistake surfaces one step later. See
[`spec.md`](./spec.md) "Hard requirement: the target image must ship pgvector".

## Phase 0 — Rehearsal on a throwaway PG18 cluster

**This phase is the gate for the whole plan and for every other plan that later wants PG18-only
SQL. It does not get shortened, reordered, or run "partially".** Three of its tasks exist to
reproduce this plan's three most dangerous claims against a live PG18 cluster. Each records the
literal output it produced. If a claim does *not* reproduce, correct `spec.md` — never keep an
unearned claim, and never skip the task because the reasoning "is obviously right".

- [ ] **Stand up a scratch PG18 cluster and provision it from migrations**
  - Files: none (throwaway compose override or a bare `docker run`)
  - Do: run `pgvector/pgvector:0.8.5-pg18` on a scratch volume and port (e.g. 5433) — the
    `pgvector/pgvector` image is mandatory, not a convenience. Then point `DATABASE_MIGRATION_URL`
    (a superuser connection) plus `DATABASE_URL`, `DATABASE_AUTH_URL`, `DATABASE_WORKER_URL`,
    `DATABASE_PLATFORM_URL` and `DATABASE_CAPABILITY_URL` at it and run `pnpm deploy:db`. Do
    **not** reuse `builderhunt_postgres_data`.
  - Verify: the orchestrator prints `━━━ deploy orchestration complete ✓ ━━━` and all **8** steps
    pass — in particular step 3 `Ensuring required Postgres extensions` with **no** warning, step 4
    `Applying Drizzle migrations`, and step 6 `Verifying runtime roles can authenticate`. Then, on
    the migration connection:
    `psql "$TARGET" -tAc "select extversion from pg_extension where extname='vector'"` → `0.8.5`;
    `psql "$TARGET" -tAc "show server_version"` → `18.x`;
    `psql "$TARGET" -tAc "select count(*) from drizzle.__drizzle_migrations"` → equals
    `ls drizzle/*.sql | wc -l`.
    **A warning at step 3 means the image lacks pgvector — stop and fix the image.** Step 3 is
    soft, so it will not fail the run; step 4 will, one step later, after rolling back everything.

- [ ] **Confirm the migration role is a superuser (the RLS-restore precondition)**
  - Files: none
  - Do: `psql "$DATABASE_MIGRATION_URL" -tAc "select rolsuper, rolbypassrls from pg_roles where rolname = current_user"`
  - Verify: output is `t|t` (or at minimum `rolsuper = t`). **If it is not, stop** — a data-only
    restore cannot proceed. 58 tables carry `FORCE ROW LEVEL SECURITY` and all seven
    `builderhunt_*` roles are `NOSUPERUSER … NOBYPASSRLS`
    (`grep -rn NOBYPASSRLS drizzle/*.sql` → 7 lines), with `builderhunt_owner` additionally
    `NOLOGIN` (`drizzle/0002_database_roles.sql:22`), so no application role can do this restore.

- [ ] **DANGEROUS CLAIM 1 — reproduce the RLS zero-row restore against the live PG18 cluster**
  - Files: none
  - Do: seed at least one row into a `FORCE`d tenant table on the source (`saved_queries` is the
    canonical one — `schema.ts:276`, forced by `drizzle/0008_tenant_rls.sql`). Dump it
    (`pg_dump -Fc --data-only --schema=public --table=saved_queries "$SOURCE_URL" -f /tmp/one.dump`)
    and attempt `pg_restore --data-only --single-transaction -d "$TARGET_APP_URL" /tmp/one.dump`
    where `$TARGET_APP_URL` connects as `builderhunt_app`, **not** the superuser.
  - Verify: record the literal stderr and the resulting
    `psql "$TARGET_SUPERUSER_URL" -tAc "select count(*) from saved_queries"`. The claim in
    `spec.md` §5 blocker 2 is confirmed if that count is `0` and/or `pg_restore` reports a
    row-level-security policy violation. **Paste the exact text into the Phase 2 runbook task.**
    If rows *do* land, the mitigation is wrong: stop, and correct `spec.md` §4 detail 2 before
    going further.

- [ ] **DANGEROUS CLAIM 2 — reproduce the `drizzle.__drizzle_migrations` collision**
  - Files: none
  - Do: on a *second* scratch PG18 target that has also been through `pnpm deploy:db`, repeat the
    data-only dump **without** `--schema=public`
    (`pg_dump -Fc --data-only "$SOURCE_URL" -f /tmp/all.dump`) and restore it with
    `pg_restore --data-only --single-transaction -d "$TARGET_SUPERUSER_URL" /tmp/all.dump`.
  - Verify: the restore aborts and stderr names a duplicate-key violation on
    `__drizzle_migrations` (spec.md §5 blocker 3). Record the error text. If it does **not** abort,
    correct the spec rather than keeping an unearned claim — and check why, because a journal that
    silently merged is worse than one that collided.

- [ ] **DANGEROUS CLAIM 3 — assert collation/locale parity between source and target cluster**
  - Files: `scripts/db/pg18/locale-check.mjs` (new)
  - Do: the script takes a URL in `argv[2]` and prints, one `key<TAB>value` per line:
    `datcollate`, `datctype`, `datlocprovider`, `daticulocale`, `datcollversion` from
    `pg_database WHERE datname = current_database()`, plus `server_encoding` and `lc_collate` from
    `SHOW`. Run it against the pg16 source and the pg18 target and `diff` the two outputs.
    `initdb` runs inside the image with whatever locale the image defaults to, and the target
    cluster is created fresh rather than upgraded in place — nothing structurally guarantees they
    match.
  - Verify: `diff /tmp/locale-pg16.tsv /tmp/locale-pg18.tsv` prints nothing and exits 0. Record
    both files. **If they differ, stop.** A different collation changes text `ORDER BY` results and
    the equality semantics behind every unique index on a text column
    (`builder_identities_source_source_id_unique` at `schema.ts:159`,
    `conversion_events_identity_unique` at `schema.ts:1770`, …) — meaning a restore can either fail
    on a duplicate that was not a duplicate before, or silently start sorting differently in the
    UI. Fix by dropping the target database and re-creating it with an explicit
    `LC_COLLATE`/`LC_CTYPE`/`LOCALE_PROVIDER` matching the source, then re-run `pnpm deploy:db`
    on it. Note `datcollversion`: PG18 may report a newer libc/ICU collation version even when the
    locale strings match, which is a `REFRESH COLLATION VERSION` decision, not an automatic stop —
    record it and decide explicitly.

- [ ] **Add a row-count parity script**
  - Files: `scripts/db/pg18/row-counts.mjs` (new)
  - Do: connect with a URL from `argv[2]`, `SELECT` an exact `count(*)` per table in schema
    `public` (enumerate from `information_schema.tables`, `table_type = 'BASE TABLE'`), print
    sorted `table<TAB>count` to stdout. No writes, no env-var magic — it must be diffable.
    `printRowCounts` in `scripts/db/restore.ts:349` is not a substitute: it hardcodes four tables.
  - Verify: `node scripts/db/pg18/row-counts.mjs "$PG16_URL" > /tmp/before.tsv` produces one line
    per table, and `wc -l < /tmp/before.tsv` equals
    `psql "$PG16_URL" -tAc "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"`.
    Cross-check that number against `pnpm db:audit-schema` (which also lists the public tables).

- [ ] **Run the full dump/restore pipeline once, end to end**
  - Files: none (commands go into the runbook in Phase 2)
  - Do: from a one-shot `pgvector/pgvector:0.8.5-pg18` container — the client binaries must match
    the *newer* server, which is the supported direction:
    (1) `psql "$TARGET_SUPERUSER_URL" -c 'DROP INDEX IF EXISTS builder_embeddings_hnsw_idx'`;
    (2) `pg_dump -Fc --data-only --schema=public "$SOURCE_URL" -f /tmp/data.dump`;
    (3) `pg_restore --data-only --disable-triggers --single-transaction -d "$TARGET_SUPERUSER_URL" /tmp/data.dump`;
    (4) `psql "$TARGET_SUPERUSER_URL" -c "SET maintenance_work_mem='1GB'; CREATE INDEX builder_embeddings_hnsw_idx ON builder_embeddings USING hnsw (embedding vector_cosine_ops)"`
        (the index name and operator class must match `drizzle/0013_polite_night_thrasher.sql:19`
        exactly, or the `EXPLAIN` regression test stops matching);
    (5) `psql "$TARGET_SUPERUSER_URL" -c 'ANALYZE'`.
  - Verify: `pg_restore` exits 0 and prints no `pg_restore: error:` lines;
    `diff <(node scripts/db/pg18/row-counts.mjs "$SOURCE_URL") <(node scripts/db/pg18/row-counts.mjs "$TARGET_SUPERUSER_URL")`
    prints nothing and exits 0; `psql "$TARGET_SUPERUSER_URL" -c '\d builder_embeddings'` lists
    `builder_embeddings_hnsw_idx`. Record `ls -la /tmp/data.dump` (dump size) and the total wall
    time — that number is the write-freeze budget Phase 3 refines and Phase 4 spends.

- [ ] **Assert RLS integrity on the restored target, not just row counts**
  - Files: none
  - Do: run the same postcondition `scripts/db/restore.ts:194` (`verifyRlsIntegrity`) applies —
    every table with `relrowsecurity` true must have at least one row in `pg_policies`:
    `psql "$TARGET_SUPERUSER_URL" -tAc "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relrowsecurity and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname)"`
  - Verify: the query returns **zero rows**. This is the check that would have caught the
    2026-07-26 defect (192 policies silently not created, 54 tables left forced-with-no-policy,
    row counts and table counts both looking perfect). The `--data-only` path is not supposed to
    hit it — which is exactly why it is asserted rather than assumed. Also confirm the policy count
    matches the source: `select count(*) from pg_policies where schemaname='public'` on both.

## Phase 1 — Dev + CI onto PG18 (no PG18-only SQL)

- [ ] **Bump the local Postgres image and pin pgvector**
  - Files: `docker-compose.yml` (line 8)
  - Do: `image: pgvector/pgvector:pg16` → `image: pgvector/pgvector:0.8.5-pg18`. Leave the
    `command: ['postgres', '-c', 'max_connections=200']`, the `pg_isready` healthcheck and the
    `builderhunt_postgres_data` volume name unchanged; add a short comment that the image must
    stay a `pgvector/pgvector:*` image (migration `0013` depends on it) and that the pgvector
    version is pinned because [`../README.md`](../README.md) (lines 209–211) reasons about
    0.8.5-specific HNSW behaviour.
  - Verify: `docker compose --profile standalone down -v && pnpm db:up && pnpm deploy:db` succeeds
    on a fresh volume, printing `━━━ deploy orchestration complete ✓ ━━━` with no warning at step
    3; then
    `psql postgresql://postgres:postgres@localhost:5432/builderhunt -tAc 'show server_version'`
    reports `18.x` and
    `… -tAc "select extversion from pg_extension where extname='vector'"` reports `0.8.5`.

- [ ] **Add a second, DB-only CI job on pg18 (do not matrix the monolithic job)**
  - Files: `.github/workflows/quality.yml`
  - Do: pin the existing `quality` job's `postgres` service to `pgvector/pgvector:0.8.5-pg16`
    (line 16 — pinning the floating tag is itself part of this plan), then add a **new** job, e.g.
    `quality-pg18`, with the same `postgres` + `redis` services but `pgvector/pgvector:0.8.5-pg18`,
    the same `env:` block (lines 43–52) verbatim, and only the version-sensitive steps: the
    `apt-get install postgresql-client` + `pnpm install` prelude, `pnpm test:migration-integrity`,
    `pnpm exec drizzle-kit check`, `pnpm test:migrations:local`,
    `node scripts/db/prepare-rls-fixture.mjs`, `pnpm test:rls:local` (with its four `RLS_TEST_*`
    env vars), `pnpm test:api-isolation:local` (with its `OWNER_SEED_URL` + role env vars), the
    `Restore rehearsal` block, and `pnpm test`. **Do not** add `strategy.matrix` to `quality`:
    that job also runs Playwright E2E, `pnpm build`, the a11y gate and Lighthouse, none of which
    differ by Postgres major, and matrixing it doubles all of them.
  - Verify: a pushed branch shows both `quality` (pg16) and `quality-pg18` green. The pg16 leg
    keeps proving the code runs on production's current version, which is the whole point until
    Phase 4.

- [ ] **Document the local reset (the PG16 volume is not readable by PG18)**
  - Files: `docs/operations/deploy-runbook.md`, `docs/operations/database-migrations.md`
  - Do: add the reset recipe — `docker compose --profile standalone down -v` → `pnpm db:up` →
    `pnpm deploy:db` → `pnpm db:seed:admin` (note the second colon; `package.json:46`) — and a
    warning that `pnpm db:up` silently no-ops when a `workspace-postgres` container is running
    (`package.json:23`), so that cluster's major version is outside this repo's control. State
    that a plain `postgres:18` image is not an acceptable substitute.
  - Verify: a developer following only the runbook gets from a PG16 volume to a working PG18 dev
    database without reading this plan. Concretely: on a machine whose volume still holds PG16
    data, following the section end to end ends with `pnpm deploy:db` printing
    `━━━ deploy orchestration complete ✓ ━━━`.

- [ ] **Run the whole gate on PG18**
  - Files: none
  - Do: `pnpm test && pnpm type-check && pnpm lint && pnpm test:migration-integrity` and, against
    the PG18 dev cluster, `pnpm test:migrations:local`, `pnpm test:rls:local`,
    `pnpm test:api-isolation:local`, `pnpm security:boundaries`. (`pnpm ci:local` runs the fuller
    local mirror of CI if you want one command — but it must be run with the workflow's env
    verbatim, including the values it deliberately leaves unset.)
  - Verify: all exit 0. `pnpm test:api-isolation:local` prints a JSON summary
    (`scripts/db/verify-api-isolation-local.mjs:1254`) — require `"failed": 0` and
    `passed === total`, and require `total` to equal whatever the same command reports against the
    pg16 cluster. **Do not assert the literal `86/86`** this plan and `_meta/app-reality.md` used
    to quote: that figure is from 2026-07-23 and the script now has ~102 `record()` call sites.
    Also: no new warnings from `drizzle-kit migrate` or from postgres.js on 18.

- [ ] **Re-verify the HNSW plan-shape regression test on PG18**
  - Files: `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` (read; edit only
    if PG18 changes the plan text it matches). Note the suite is `tests/unit/**` only —
    `vitest.config.ts` includes nothing under `src/`, and there are zero co-located test files.
  - Do: `pnpm vitest run tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts`
    against the PG18 cluster. PG18 adds an `Index Searches: N` line to index-scan plans; confirm
    the existing `toContain('Index Scan using builder_embeddings_hnsw_idx')` (line 87) /
    `not.toContain('Sort Key:')` (line 92) assertions are unaffected, along with their negative
    counterparts at lines 109–110.
  - Verify: the file passes unmodified (`1 passed` for the file, exit 0). If a string assertion
    breaks, fix the assertion — never the query shape, which is load-bearing (see the doc comment
    at `src/shared/lib/repositories/public-builder-embeddings.ts:86-100`).

- [ ] **Rehearse the restore harness against a PG18 target**
  - Files: none
  - Do: create an empty scratch PG18 database, then
    `RESTORE_TEST_SOURCE_URL=<pg16> RESTORE_TEST_TARGET_URL=<pg18 scratch> pnpm db:restore-test`.
    Note what this harness actually does (`scripts/db/restore-test.ts:156-160`): a full
    `pg_dump --format=custom --no-owner --no-acl` piped into
    `pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error`. It is **not** the §4
    data-only pipeline and is not a substitute for the Phase 0 rehearsal — it is the existing CI
    gate, re-run on 18 to prove the harness itself still works cross-major.
  - Verify: exits 0. If it fails, the failure belongs in Phase 2's runbook as a known constraint
    of the harness — do not proceed to Phase 2 with an unexplained red rehearsal.

## Phase 2 — Production runbook + standing PG18 resource (no cutover)

- [ ] **Correct the stale claims in the migration doc and the runbook env table**
  - Files: `docs/operations/database-migrations.md` (lines 30–41), `docs/operations/deploy-runbook.md`
    (lines 87–89 and 121–125)
  - Do: three edits.
    (a) `database-migrations.md:40-41` currently says "The data volume persists across the image
    swap since the Postgres major version is unchanged" — keep the 16→16 history but state plainly
    that a 16→18 swap is **not** volume-compatible and requires the cutover procedure below.
    (b) Add: the daily `scripts/db/backup.ts` dump (`--no-owner --no-acl`, no
    `pg_dumpall --globals-only`) is a disaster-recovery artifact for the *same* cluster and must
    never be used as the upgrade vehicle, because roles are cluster-global and grants are stripped;
    cross-link [`database-restore.md`](../../../docs/operations/database-restore.md), which already
    documents the roles-first rule.
    (c) `deploy-runbook.md:121-125` lists five `DATABASE_*_URL` vars and omits
    `DATABASE_CAPABILITY_URL` / `builderhunt_capability`, which `drizzle/0078_capability_role.sql`
    added and `orchestrate.mjs:76` provisions. Add the row — the cutover repoint depends on this
    table being complete.
  - Verify: `grep -n pg16 docs/operations/database-migrations.md docs/operations/deploy-runbook.md`
    shows no remaining sentence implying an image bump alone is sufficient, and
    `grep -c DATABASE_CAPABILITY_URL docs/operations/deploy-runbook.md` returns at least 1.

- [ ] **Write the cutover runbook**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: new section "PostgreSQL 16 → 18 cutover" containing: create the second Coolify Postgres
    resource on `pgvector/pgvector:0.8.5-pg18` (a `pgvector/pgvector:*` image is **mandatory** —
    include the one-paragraph incident rationale from `spec.md`) with its own persistent volume;
    run `pnpm deploy:db` against it; the `rolsuper` assertion; the exact five-command pipeline from
    Phase 0 with the `--schema=public` / `--disable-triggers` / `--single-transaction` flags and
    *why each one is there*; `ANALYZE`; HNSW recreate; `row-counts.mjs` parity; the RLS-integrity
    query; the verbatim error texts recorded by the three Phase 0 "dangerous claim" tasks; every
    `DATABASE_*_URL` var to repoint (up to six — enumerate what is actually set in Coolify, do not
    copy a list); **repointing Coolify's 03:00 backup and the 03:30 `builderhunt-backup-sync.sh`
    at the new resource**; the point-of-no-return acknowledgement; and the rollback path, stating
    that a rollback restore goes through `pnpm db:restore` (roles-first) and never a bare
    `pg_restore`. Update the "Image **must** be `pgvector/pgvector:pg16`" line at `:87` to the
    pinned pg18 tag once Phase 4 lands (flag it as pending until then).
  - Verify: an operator who has never read this plan can execute the section unaided; every flag in
    the pipeline has a one-line reason next to it. Mechanically:
    `grep -c '0.8.5-pg18' docs/operations/deploy-runbook.md` returns ≥ 1 and the section contains
    no `NNNN` or `<fill in>` placeholders.

- [ ] **Create and provision the standing production PG18 resource**
  - Files: none (Coolify operator work)
  - Do: create the resource on `pgvector/pgvector:0.8.5-pg18` with a named persistent volume,
    confirm redeploying the app does not recreate it, then run `pnpm deploy:db` against it with the
    production role passwords from Coolify env.
  - Verify: **8/8** orchestrator steps pass in the real environment, with **no warning at step 3** —
    which is also the honest proof that every migration `0000`–head applies cleanly on 18 in
    production conditions. `select count(*) from drizzle.__drizzle_migrations` equals
    `ls drizzle/*.sql | wc -l`. `select rolsuper from pg_roles where rolname = current_user` is `t`
    on the migration connection. `select extversion from pg_extension where extname='vector'` is
    `0.8.5`. The resource holds the full schema and zero application rows
    (`node scripts/db/pg18/row-counts.mjs "$PG18_URL"` shows 0 for every table).

- [ ] **Announce the window and pre-stage the freeze**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: document exactly which scheduled jobs to pause, working from the consolidated table in
    [`docs/runbook.md`](../../../docs/runbook.md) §3 — which today lists: the every-5-min
    `/api/admin/status/snapshot` POST; the hourly `/api/admin/devpost/run-worker` (dark in prod);
    and the per-plan-cadence `run-worker` endpoints for `discovery`, `enrichment`, `embeddings`,
    `alerts`, `billing`, `legal` and `sprints`. Also decide explicitly what happens to the 03:00
    Coolify backup and the 03:30 `builderhunt-backup-sync.sh` if the window overlaps them. State
    that stopping the app resource is the write freeze, since all background work is HTTP-triggered
    and idempotent (`_meta/conventions.md` #7) and every `run-worker` endpoint is reached over
    HTTP with `x-cron-secret`. Note that Stripe webhooks will retry (`billing_webhook_events` has
    `status` + `next_attempt_at` retry state, `schema.ts:1088-1108`) and that nothing is billed
    today — the Stripe plan is still `pending`.
  - Verify: the list in the runbook matches `crontab -l` on the VPS entry for entry (and matches
    `docs/runbook.md` §3); no worker endpoint appears in one list and not the other.

## Phase 3 — Full-fidelity rehearsal against production data

- [ ] **Rehearse on a scratch copy of real production data**
  - Files: none
  - Do: take a fresh production backup, provision a *third* scratch PG18 database (never the
    standing cutover target), and run the pipeline end to end — **starting with the collation
    parity assertion against real production** (`scripts/db/pg18/locale-check.mjs`), since Phase 0
    only proved it for a local cluster. Capture dump size, dump time, restore time, HNSW rebuild
    time, `ANALYZE` time.
  - Verify: `diff <(node scripts/db/pg18/row-counts.mjs "$PROD_URL") <(node scripts/db/pg18/row-counts.mjs "$SCRATCH_PG18_URL")`
    prints nothing and exits 0; the RLS-integrity query from Phase 0 returns zero rows on the
    scratch target and its `pg_policies` count matches production's; the total wall time is
    recorded in the runbook as the write-freeze budget.

- [ ] **Exercise the app against the rehearsed database**
  - Files: none
  - Do: point a local production-mode build at the scratch PG18 database and walk login,
    dashboard, keyword search, `POST /api/search/semantic`, alerts, exports, and one admin page.
  - Verify: no 500s; semantic search returns results (not `503 semantic_unavailable`); a
    tenant-scoped read returns rows through RLS as `builderhunt_app`, proving grants and policies
    survived provisioning; `pnpm test:api-isolation:local` against this database prints
    `"failed": 0` with the same `total` as the pg16 baseline run.

- [ ] **Compare a real semantic-search result set before and after**
  - Files: none
  - Do: run the same `POST /api/search/semantic` query against production (pg16) and the scratch
    pg18 copy; diff the ordered builder lists.
  - Verify: identical ordering, or any difference explained by HNSW approximation and accepted in
    writing — the same standard `look-alike-sourcing` applied to the ordering fix.

## Phase 4 — Production cutover

**Every task up to and including "Verify roles, RLS and tenancy" is reversible by unfreezing pg16
and deleting nothing. The point of no return is the redeploy in the "repoint and redeploy" task.**

- [ ] **Freeze writes** — *rollback: unpause cron, restart the app; zero cost*
  - Files: none
  - Do: pause the scheduled jobs listed in the runbook (from `docs/runbook.md` §3), then stop the
    Coolify app resource.
  - Verify: `psql "$PG16_URL" -tAc "select count(*) from pg_stat_activity where usename like 'builderhunt%' and state <> 'idle'"`
    returns `0`, and stays `0` on a second run 60 seconds later.

- [ ] **Take the pre-cutover dump and record parity input** — *rollback: delete the artifacts*
  - Files: none
  - Do: `pg_dump -Fc --data-only --schema=public "$PG16_URL" -f data.dump` to durable storage, plus
    a full `pg_dump -Fc "$PG16_URL" -f rollback.dump` (schema included) kept as the rollback
    artifact, plus `pg_dumpall --roles-only --no-role-passwords -f rollback.roles.sql` (the full
    dump's `CREATE POLICY … TO builderhunt_*` statements are useless without it — see
    `docs/operations/database-restore.md`), plus
    `node scripts/db/pg18/row-counts.mjs "$PG16_URL" > before.tsv`.
  - Verify: all three artifacts exist with non-zero size (`ls -la`); `wc -l < before.tsv` equals
    the public `BASE TABLE` count on pg16; `grep -c 'CREATE ROLE builderhunt' rollback.roles.sql`
    returns 7.

- [ ] **Restore into the standing PG18 resource** — *rollback: `DROP` and re-run `pnpm deploy:db`
  on the pg18 resource; pg16 is untouched*
  - Files: none
  - Do: drop `builder_embeddings_hnsw_idx`, run `pg_restore --data-only --disable-triggers
    --single-transaction -d "$PG18_SUPERUSER_URL" data.dump`, recreate the HNSW index with
    `maintenance_work_mem` raised (exact DDL from `drizzle/0013_polite_night_thrasher.sql:19`),
    then `ANALYZE`.
  - Verify: `pg_restore` exits 0 with no `pg_restore: error:` lines;
    `diff before.tsv <(node scripts/db/pg18/row-counts.mjs "$PG18_URL")` prints nothing and exits 0;
    `psql "$PG18_SUPERUSER_URL" -c '\d builder_embeddings'` shows `builder_embeddings_hnsw_idx`;
    the RLS-integrity query from Phase 0 returns zero rows.

- [ ] **Verify roles, RLS and tenancy on the target before repointing** — *rollback: as above; this
  is the last reversible step*
  - Files: none
  - Do: connect as each of the **six** LOGIN roles — `builderhunt_app`, `builderhunt_worker`,
    `builderhunt_readonly`, `builderhunt_auth`, `builderhunt_platform`, `builderhunt_capability` —
    and run one tenant-scoped read inside a transaction that `set_config('app.organization_id', …, true)`
    for a real organization.
  - Verify: all six authenticate (`select 1` succeeds for each); the tenant read returns that
    organization's rows **and zero rows for a second organization id** — the negative half of the
    tenant A/B check required by [`../../_meta/security-policy.md`](../../_meta/security-policy.md)
    rule 1/3. Also confirm no role can bypass:
    `psql "$PG18_SUPERUSER_URL" -tAc "select count(*) from pg_roles where rolname like 'builderhunt%' and (rolsuper or rolbypassrls)"`
    returns `0`.

- [ ] **⛔ POINT OF NO RETURN — acknowledge in writing, then repoint and redeploy**
  - Files: none
  - Do: **first**, record in the deploy log, with a UTC timestamp and the operator's name, that
    from this point rollback costs every post-cutover write. Then repoint every `DATABASE_*_URL`
    that is set in Coolify — up to six: `DATABASE_URL`, `DATABASE_AUTH_URL`,
    `DATABASE_WORKER_URL`, `DATABASE_PLATFORM_URL`, `DATABASE_CAPABILITY_URL`,
    `DATABASE_MIGRATION_URL` — **and** repoint Coolify's 03:00 scheduled backup and the 03:30
    `builderhunt-backup-sync.sh` at the new resource (they target the DB *resource*, not
    `DATABASE_URL`, so the env repoint does not move them). Then redeploy the app.
  - Verify: `post_deployment_command` (`pnpm deploy:db`) prints
    `━━━ deploy orchestration complete ✓ ━━━` with **8/8** steps as a no-op plus role-password
    re-provision, and **no warning at step 3**; `curl -fsS https://builderhunt.dev/api/health`
    returns 200; login works in a real browser session.
  - Rollback from here: stop the app; `pnpm db:restore --target "$PG16_URL" --file rollback.dump
    --roles-file rollback.roles.sql` into the still-intact pg16 resource (**never** a bare
    `pg_restore` — the policies need the roles first); repoint every `DATABASE_*_URL` and both
    backup jobs back; redeploy; accept the loss of everything written to pg18 after the cutover.

- [ ] **Unfreeze and soak**
  - Files: none
  - Do: unpause the scheduled jobs. Watch for one soak period: error rate, `/api/health`,
    semantic-search p95, `pg_stat_io` deltas, and that each HTTP-cron worker completes one tick.
  - Verify: p95 of `POST /api/search/semantic` no worse than the pre-cutover baseline, measured the
    same way; no role-authentication errors in the logs; every worker's next tick logs a normal
    completion; the next 03:00 Coolify backup lands from the **pg18** resource.

- [ ] **Retire the pg16 resource on a schedule, not immediately**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: stop (do not delete) the pg16 resource and its volume; record the retention date after
    which it is deleted, and update the image line at `:87` to the pinned pg18 tag. Do not start
    the retention clock until the first successful backup from pg18 exists.
  - Verify: the runbook states the retention date and that the volume still exists until then;
    `grep -n 'pgvector/pgvector:0.8.5-pg18' docs/operations/deploy-runbook.md` matches the
    "Image **must** be" line.

## Phase 5 — Feature adoption (only after Phase 4 is observed)

- [ ] **Switch four append-heavy uuid PKs to `uuidv7()`**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/NNNN_*.sql` (generated)
  - Do: locate the tables **by `export const` name**, not by line — the schema has 24
    `.defaultRandom()` columns as of 2026-07-27 and the line numbers move. Replace
    `.defaultRandom()` with `` .default(sql`uuidv7()`) `` on exactly `builderSourceSnapshots`
    (`:167`), `builderProfileViews` (`:428`), `migrationBackfillConflicts` (`:715`) and
    `enrichmentEvidence` (`:934`). Leave `builderProcessingRestrictions` (`:981`) and
    `billingSellerProfiles` (`:1536`) on `gen_random_uuid()` — low volume, and a v7 id discloses
    creation time on a compliance record. **Leave the other 18 `.defaultRandom()` columns alone**:
    they are out of scope for this plan, not rejected. Add a one-line comment stating the rule.
    Then `pnpm db:generate`.
  - Verify: `grep -c 'SET DEFAULT uuidv7()' drizzle/NNNN_*.sql` returns exactly `4` and the file
    contains no other `ALTER`; `pnpm test:migration-integrity` exits 0 (snapshot present);
    `pnpm test:migrations:local` exits 0; after inserting one row,
    `select substring(id::text, 15, 1) from builder_profile_views order by id desc limit 1`
    returns `7`, while the same query over a pre-existing row still returns `4`.

- [ ] **Benchmark v4 vs v7 insert locality, and record the result either way**
  - Files: `scripts/db/pg18/bench-uuid-defaults.mjs` (new)
  - Do: in a disposable `builderhunt_security_test_*` database, create two clones of
    `builder_profile_views` — one defaulting `gen_random_uuid()`, one `uuidv7()` — insert 200k rows
    into each, and report PK index size (`pg_relation_size`) plus wall time.
  - Verify: the script prints both numbers; paste them into spec.md §3A. A null result is a valid
    outcome and must be written down as one, not quietly dropped.

- [ ] **Return `contentChanged` from the embedding upsert via `RETURNING old/new`**
  - Files: `src/shared/lib/repositories/public-builder-embeddings.ts` (`upsertBuilderEmbeddingStub`,
    line 26), `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts`
  - Do: append `` .returning({ contentChanged: sql<boolean>`(old.content_hash is distinct from new.content_hash)` }) ``
    to the existing `onConflictDoUpdate`, change the signature from `Promise<void>` to
    `Promise<boolean>`, and return `rows[0]?.contentChanged ?? true` (a fresh insert has a NULL
    `old`, so the expression is already `TRUE` — "needs an embedding"). Do not change what the
    upsert writes.
  - Verify: print the SQL drizzle emits (`.toSQL()`) and confirm the `old.`/`new.` aliases survive
    verbatim; run it against the PG18 dev database asserting `TRUE` for a fresh insert, `TRUE`
    after a document edit, `FALSE` for an identical re-index. Add those three cases to
    `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` (the suite is
    `tests/unit/**` only — `vitest.config.ts` includes nothing under `src/`) and confirm
    `pnpm vitest run tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` exits 0.

- [ ] **Consume the counter in the write-through indexer**
  - Files: `src/lib/semantic/index-writer.ts`
  - Do: sum the returned booleans per batch and emit one structured log line
    (`log.info('semantic_index_write_through', { seen, changed })`). No behaviour change, no new
    table, no metric backend.
  - Verify: `pnpm test` green; a local search request logs the line with `changed` at 0 on a
    repeated identical search and non-zero on the first.

- [ ] **Test whether skip scan makes `conversion_events_server_day_idx` redundant**
  - Files: `scripts/db/pg18/explain-skip-scan.mjs` (new)
  - Do: seed ≥ 500k realistic `conversion_events` rows into a disposable database (the 7 legal
    `name` values are fixed by `conversion_events_name_check`, `schema.ts:1774-1779`), `ANALYZE`,
    then `EXPLAIN (ANALYZE, BUFFERS)` the actual `server_day`-range aggregates that
    `src/shared/lib/repositories/conversion-events.ts` runs — once with both indexes, once with
    `conversion_events_server_day_idx` dropped.
  - Verify: the script prints both plans. Redundancy is proven only if the drop leaves an index
    scan on `conversion_events_name_server_day_idx` with `Index Searches: N > 1` and comparable
    timing.

- [ ] **Drop the redundant index — or record the negative result**
  - Files: `src/shared/lib/db/schema.ts` (`conversion_events_server_day_idx`, line 1771 at
    2026-07-27 — find it by name), `drizzle/NNNN_*.sql` (generated)
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
  - Do: new step between `waitForDatabase` / "Waiting for database" (`orchestrate.mjs:149-150`) and
    `ensureDatabaseExists` / "Ensuring database exists" (`:176`), called from `main()` at `:367`:
    read `current_setting('server_version_num')::int`, compare against
    `Number(process.env.DEPLOY_DB_MIN_PG_MAJOR ?? 18) * 10000`, and exit fatally below it with the
    detected version, the expected floor and a pointer to the runbook cutover section. Print the
    detected version on success. Honour `--dry-run` (print the plan, open no connection). Read the
    env var from `process.env` directly — it is ops-only and must not enter
    `src/shared/lib/env.ts`.
  - Verify: `pnpm deploy:db:dry` prints the new step without connecting; against a PG18 database it
    passes and logs `server_version`; against a PG16 database it fails with the remediation
    message; with `DEPLOY_DB_MIN_PG_MAJOR=16` it passes on both. Also update the orchestrator step
    table in `docs/operations/deploy-runbook.md:46-54`, which will then describe **9** steps.

- [ ] **Collapse CI back to a single Postgres version**
  - Files: `.github/workflows/quality.yml`
  - Do: move the `quality` job's `postgres` service to `pgvector/pgvector:0.8.5-pg18` and delete
    the `quality-pg18` job that Phase 1 added, now that production is on 18.
  - Verify: CI green with a single DB-bearing job; `grep -c 'pg16' .github/workflows/quality.yml`
    returns 0; total workflow runtime returns to roughly its pre-Phase-1 value.

- [ ] **Refresh the plan-reality documents**
  - Files: `plans/_meta/app-reality.md`, `plans/phase-2/README.md`,
    `plans/phase-2/postgres-18-upgrade/{spec.md,plan.md,tasks.md}`
  - Do: update the DB line in `app-reality.md` — note it is already stale independently of this
    plan (line 32 says "46 migrations … 68 tables", verified 2026-07-24; the tree has 86 and 95) —
    with version, pinned image, and migration/table counts re-derived at that moment. Then set
    this plan's **three** headers to `implemented` with a short "Delivered" section replacing the
    future tense, per [`../../_meta/conventions.md`](../../_meta/conventions.md) rule 2.
  - Verify: `grep -rn 'pgvector/pgvector:pg16' plans/` returns only historical references that are
    explicitly labelled as history; `grep -rn 'Status.*pending' plans/phase-2/postgres-18-upgrade/`
    returns nothing.
