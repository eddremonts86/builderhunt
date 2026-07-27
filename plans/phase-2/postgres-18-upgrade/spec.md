# PostgreSQL 18 Upgrade (spec)

> **Status**: `pending`
> **Depends on**: nothing — but it is **strictly ordered against every other plan** (see "The sequencing rule"). Any plan that wants PG18-only SQL waits for Phase 4 of this one.
> **Blocks**: nothing today. It unblocks the four PG18 capabilities listed in §3 for later plans (notably `NOT NULL ... NOT VALID` expand steps, which every future expand/contract migration should use).
> **Reality check**: all three environments run `pgvector/pgvector:pg16` — [`docker-compose.yml:8`](../../../docker-compose.yml), [`.github/workflows/quality.yml:16`](../../../.github/workflows/quality.yml), and [`docs/operations/deploy-runbook.md:68`](../../../docs/operations/deploy-runbook.md) ("Image **must** be `pgvector/pgvector:pg16`"). The database is provisioned forward-only by `scripts/deploy/orchestrate.mjs` (`pnpm deploy:db`, 7 idempotent steps), from 64 migrations in `drizzle/` covering 77 `pgTable`s, with `FORCE ROW LEVEL SECURITY` on every tenant table (`drizzle/0008_tenant_rls.sql`) and four non-owner LOGIN roles (`drizzle/0002_database_roles.sql`). Backups are plain-SQL `pg_dump --no-owner --no-acl --clean --if-exists` (`scripts/db/backup.ts:56`); the restore rehearsal harness is `scripts/db/restore-test.ts` (custom-format `pg_restore`). **No code anywhere asserts a Postgres version** — grep for `server_version` in `src/`, `scripts/`, `drizzle/` returns nothing.

## Problem

Nothing is on fire. PostgreSQL 16 is supported until November 2028, so this is not a
forced upgrade and must not be sold as one. The actual case is narrower:

1. **The upgrade only gets more expensive.** The cutover cost is a function of data size and of
   how many tenants are writing. Today the app has no paying tenants (`stripe-billing-platform`
   is shipped but bills nobody — see [`../README.md`](../README.md)), which makes a
   write-freeze window cheap in a way it will never be again.
2. **Four capabilities map onto code that already exists** and are not reachable on 16:
   `uuidv7()`, `RETURNING old/new`, B-tree skip scan, and `NOT NULL ... NOT VALID`. Each is
   described in §3 with the exact file it changes. Nothing here is adopted for novelty.
3. **The pgvector version is unpinned.** `pgvector/pgvector:pg16` floats.
   [`../README.md:147`](../README.md) already reasons about *specific* pgvector 0.8.5 behaviour
   (`ef = max(ef_search, limit)`), and [`look-alike-sourcing`](../look-alike-sourcing/plan.md)
   depends on it. That assumption is currently accidental. Pinning `0.8.5-pg18` makes a
   load-bearing claim enforced instead of lucky.
4. **A version mismatch is silent.** `pnpm db:up` no-ops when a container named
   `workspace-postgres` is already running (`package.json:22`) — a cluster this repo does not
   own or version. Nothing fails loudly if dev, CI and prod disagree on the major version. That
   is a pre-existing gap this plan closes regardless of which version wins.

## Goal

Move dev, CI and production to `pgvector/pgvector:0.8.5-pg18` with zero data loss, a rehearsed
restore, verified row-count parity and a rollback that stays available until an explicit
point of no return — then adopt exactly the four PG18 capabilities that touch code we already
have, each independently revertable and each with a measurement rather than a claim.

## Non-goals

- **No `pg_upgrade`.** See §4 for why the dump/restore path wins at this data size, and what we
  give up by choosing it (PG18's retained optimizer statistics).
- **No performance tuning by vibes.** `io_method`, `io_workers`, `autovacuum_*` and
  `vacuum_max_eager_freeze_failure_rate` keep their PG18 defaults. This plan adds the
  *measurement* surface (`pg_stat_io`, `pg_aios`) and changes nothing it cannot measure.
- **No `io_uring`.** See §3E — Docker's default seccomp profile does not permit
  `io_uring_setup`, and Coolify runs containers with the default profile.
- **No schema redesign.** No table gains a range column, no PK type changes, no data is
  rewritten. Every schema change in this plan is a `DEFAULT` swap or an index drop.
- **No new user-facing feature**, no UI, no API surface, no AI task, no billing gate.
- **No new validated env var.** One optional ops-only escape hatch (`DEPLOY_DB_MIN_PG_MAJOR`)
  is read from `process.env` in the deploy script, the same way `REDIS_URL` and `ADMIN_USER_IDS`
  are — it never enters `src/shared/lib/env.ts`.
- **No migration rewriting.** The 64 existing migrations stay byte-identical; they are immutable
  once applied (`docs/operations/database-migrations.md`).

## 1. The sequencing rule (the most important paragraph in this plan)

Between the moment CI moves to PG18 and the moment production does, **production is running
code that CI only tested on 18**. If any PG18-only SQL merges in that window, production breaks
on the next deploy with a syntax error inside `drizzle-kit migrate` — i.e. mid-`post_deployment_command`,
after the container is already live.

Therefore:

- Phases 0–4 (the version move) contain **zero PG18-only syntax**. They are pure
  infrastructure: images, docs, rehearsals, cutover.
- During the window, `.github/workflows/quality.yml` runs the DB jobs against **both** pg16 and
  pg18 so we keep proving the code runs on production's actual version.
- Phase 5+ (feature adoption) may not merge until Phase 4 is done and observed.
- Phase 6 installs the version gate so the rule is enforced by a script instead of by memory,
  and drops pg16 from the CI matrix.

Any other plan that wants `uuidv7()`, `RETURNING old/new`, skip-scan-dependent index changes or
`NOT NULL NOT VALID` links to this plan's Phase 4 as a dependency.

## 2. What we are actually running against

Verified 2026-07-26 against the working tree:

| Fact | Value | Source |
| ---- | ----- | ------ |
| Image (dev / CI / prod) | `pgvector/pgvector:pg16`, unpinned pgvector | `docker-compose.yml:8`, `quality.yml:16`, `deploy-runbook.md:68` |
| Migrations | 64 (`drizzle/0000` … `drizzle/0064_profile_removal_grants.sql`; `0063`/`0064` are uncommitted WIP) | `drizzle/meta/_journal.json` |
| Tables | 77 `pgTable` declarations | `src/shared/lib/db/schema.ts` |
| `serial` / `CREATE SEQUENCE` in app schema | **zero** | grep — matters for §4 (no sequence resync) |
| Triggers | **zero** `CREATE TRIGGER` | grep — PG18's AFTER-trigger role change is N/A |
| Full-text search / `pg_trgm` | **zero** `to_tsvector` / `pg_trgm` / `gin(` | grep — PG18's FTS collation-provider reindex requirement is N/A |
| `AT TIME ZONE '<abbrev>'` | **zero** | grep — PG18's timezone-abbreviation precedence change is N/A |
| `COPY` usage | **zero** | grep — PG18's CSV `\.` change is N/A |
| Extensions | `vector` only (`drizzle/0013`) | `orchestrate.mjs` step 3 |
| RLS | `FORCE ROW LEVEL SECURITY` on tenant tables, policies `TO builderhunt_app` | `drizzle/0008_tenant_rls.sql` |
| `builderhunt_owner` | `NOLOGIN NOSUPERUSER NOBYPASSRLS` | `drizzle/0002_database_roles.sql:22` |
| Driver | `postgres` (postgres.js) `^3.4.9`, `{ prepare: false }` | `package.json`, `src/shared/lib/db/client.ts:38` |
| ORM / kit | `drizzle-orm ^0.45.2`, `drizzle-kit ^0.31.10` | `package.json` |
| Target image exists | `pgvector/pgvector:0.8.5-pg18` (also `0.8.4-pg18`, `pg18`) | Docker Hub tag list, checked 2026-07-26 |

Four of PG18's published incompatibilities are therefore **not applicable to this codebase**, and
each of those four is a line item most generic upgrade checklists would have us do work for. The
grep evidence is in the table so a reviewer can re-run it rather than trust it.

## 3. What we adopt, and why each one earns its place

### A. `uuidv7()` as the default for four append-heavy uuid PKs

Six tables use `uuid('id').primaryKey().defaultRandom()` → `DEFAULT gen_random_uuid()`
(`schema.ts:167, 411, 673, 892, 939, 1494`). A v4 UUID is uniformly random, so every insert
lands on a random leaf page of the PK index: more page splits, more WAL, worse cache locality.
`uuidv7()` is time-ordered, so inserts append.

Adopted for the four that actually take volume:

| Table | Line | Write pattern | Adopt? |
| ----- | ---- | ------------- | ------ |
| `builder_source_snapshots` | 167 | one row per source fetch per identity | **yes** |
| `builder_profile_views` | 411 | one row per profile view | **yes** |
| `enrichment_evidence` | 892 | one row per enrichment observation | **yes** |
| `migration_backfill_conflicts` | 673 | one row per backfill conflict | **yes** |
| `builder_processing_restrictions` | 939 | rare, compliance record | no |
| `billing_seller_profiles` | 1494 | one row per seller | no |

The two exclusions are deliberate: at their volume the locality win is unmeasurable, and a v7
id **encodes its creation time**, which for a privacy/compliance record is a disclosure with no
upside (`docs/architecture/data-classification.md` is the authority on which rows those are).
No table is created, altered in shape, or reclassified by this change, so no new data-class
declaration is owed under `_meta/security-policy.md`. The rule this plan sets for future tables: *use `uuidv7()` for append-heavy internal
tables; keep `gen_random_uuid()` where the id is handed to a client and the creation time is
not already public.*

Mechanically this is `DEFAULT uuidv7()` on an existing `uuid` column: the type does not change,
**existing rows are not rewritten**, and a column holding both v4 and v7 values is perfectly
legal — only new rows become time-ordered. `.defaultRandom()` becomes
`.default(sql\`uuidv7()\`)` in `schema.ts`; `drizzle-kit generate` emits
`ALTER COLUMN "id" SET DEFAULT uuidv7()`.

Measurement (Phase 5 task, not a claim): insert 200k rows into two clones of
`builder_profile_views` — one v4-defaulted, one v7-defaulted — in the disposable test database,
and compare `pg_relation_size` of the PK index plus wall time. If the difference is noise, the
change still stands (it is free) but the plan records the negative result instead of pretending.

### B. `RETURNING old/new` in the embedding write-through path

`upsertBuilderEmbeddingStub` (`src/shared/lib/repositories/public-builder-embeddings.ts:26`)
is an `INSERT ... ON CONFLICT DO UPDATE` that nulls `embedding`/`embedded_at` only when
`content_hash` changed — and returns `void`. So `src/lib/semantic/index-writer.ts` writes
through on every search/track request without ever knowing whether it queued real work. "How
many profiles actually changed today" is currently unanswerable without a second query.

PG18 answers it in the same statement:

```sql
-- appended to the existing upsert
RETURNING (old.content_hash IS DISTINCT FROM new.content_hash) AS content_changed
```

The semantics are exactly the ones we want: on a fresh insert `old` is NULL, so
`IS DISTINCT FROM` is `TRUE` — "this row needs an embedding" — which is also true for a
genuine content change, and `FALSE` for an unchanged re-index. `upsertBuilderEmbeddingStub`
returns `Promise<boolean>`; `index-writer.ts` sums it and logs one structured counter.

No extra round trip, no `SELECT` before the write, no behavioural change to what is stored.
Drizzle passes `.returning({ contentChanged: sql<boolean>\`…\` })` through verbatim, but `old`/
`new` are PG18 aliases the driver has never seen — Phase 5 verifies the emitted SQL against a
real PG18 database rather than assuming.

### C. B-tree skip scan → one fewer index on an append-only table

`conversion_events` (`schema.ts:1715`) is append-only landing-funnel data and carries four
indexes, two of which overlap:

- `conversion_events_name_server_day_idx (name, server_day)` (`schema.ts:1730`)
- `conversion_events_server_day_idx (server_day)` (`schema.ts:1729`)

`name` is constrained by a `CHECK` to **7 values** (`schema.ts:1733`) — precisely the
low-cardinality leading column PG18's skip scan is for. If a `server_day`-only aggregate can be
served by the composite index, the single-column index is dead weight on a table whose only
write pattern is INSERT.

This is adopted **conditionally**, and the condition is real: at small row counts the planner
picks a sequential scan no matter what, so the drop must be justified by `EXPLAIN` on a
realistically seeded copy (≥ 500k rows) of the actual aggregate queries in the conversion
repository, asserting an index scan on the composite index and PG18's new `Index Searches: N`
(`N > 1`) line as positive skip-scan evidence. **If the planner does not use it, we keep both
indexes and record the negative result in the plan.** No index is dropped on the strength of a
release note.

`builder_identities (source, username)` (`schema.ts:160`) is the other structural candidate —
`source` is low-cardinality — but grep finds **no username-only query**, so there is nothing to
speed up. Noted here so a future reader does not re-derive it.

### D. `NOT NULL ... NOT VALID` as the sanctioned expand step

`docs/operations/database-migrations.md` mandates expand → backfill → dual write → shadow read
→ cutover → validate → contract. On PG16, the "validate" step for a `NOT NULL` column means
`ALTER TABLE ... SET NOT NULL`, which takes `AccessExclusiveLock` and scans the whole table.
PG18 stores NOT NULL constraints in `pg_constraint`, so they can be named and added `NOT VALID`
and validated separately — the same two-step shape the playbook already uses for CHECK and FK
constraints.

No schema changes here: this is a documentation change that alters how every *future* expand
migration is written. It is in this plan because the capability arrives with the upgrade and
because the playbook is the only place that would otherwise stay wrong.

### E. Ops surface: measure, don't tune

- `io_method` keeps its PG18 default (`worker`). AIO is the headline PG18 feature and it helps
  exactly the shapes we have — `findPendingBuilderEmbeddings` (`embedding IS NULL` ordered by
  `updated_at`, no partial index, sequential-scan by design) and the `conversion_events`
  day-range aggregates — but it helps them *by default*. There is nothing to turn on.
- **`io_uring` is explicitly not enabled.** Docker's default seccomp profile does not allow
  `io_uring_setup`, and Coolify runs containers under the default profile. Setting
  `io_method=io_uring` under Docker is a startup failure, not a speedup. Recorded so nobody
  "optimizes" the compose file later.
- `pg_stat_io` and the new `pg_aios` view go into the DB section of the deploy runbook as the
  before/after evidence for the cutover.
- `log_lock_failures = on` — cheap, and it makes a migration that loses a lock race explain
  itself, which the migration playbook currently has no tooling for.

### F. A version gate, so a mismatch fails loudly

`scripts/deploy/orchestrate.mjs` gets a step between "wait for db" and "create db":
`SELECT current_setting('server_version_num')::int`, fatal below `DEPLOY_DB_MIN_PG_MAJOR × 10000`
(default `18`), with a remediation line pointing at the runbook. It lands in Phase 6 — *after*
production is on 18, because installing it earlier would block every deploy — and the env var
exists so a rollback to pg16 does not deadlock against the gate.

## 4. The upgrade path

A PG18 server cannot read a PG16 data directory, so "change the image tag" is not an upgrade.

### Chosen: schema-from-migrations + data-only restore into a fresh PG18 resource

1. Create a **second** Coolify Postgres resource on `pgvector/pgvector:0.8.5-pg18` with its own
   named volume. The pg16 resource and its volume are never touched.
2. Run `pnpm deploy:db` against the new resource. This is the most-tested path in the repo: it
   creates the database, `CREATE EXTENSION vector`, applies all 64 migrations (tables, RLS,
   `FORCE ROW LEVEL SECURITY`, roles, grants), provisions role passwords from env, and verifies
   every role can log in.
3. Freeze writes: stop the app resource and pause the VPS cron entries. All background work is
   HTTP-triggered and idempotent (`plans/_meta/conventions.md` #7), so a stopped app means no
   writes, and a missed worker tick is a no-op.
4. `pg_dump -Fc --data-only --schema=public` from pg16 → `pg_restore --data-only
   --disable-triggers --single-transaction` into pg18, both run from a one-shot
   `pgvector/pgvector:0.8.5-pg18` container on the Coolify network (so the client binaries match
   the *newer* server, which is the supported direction).
5. `ANALYZE` (the dump/restore path does not inherit PG18's retained optimizer statistics — this
   is the one thing we give up versus `pg_upgrade`, and it costs one command), rebuild
   `builder_embeddings_hnsw_idx`, verify per-table row-count parity.
6. Point `DATABASE_URL` / `DATABASE_AUTH_URL` / `DATABASE_WORKER_URL` / `DATABASE_PLATFORM_URL` /
   `DATABASE_MIGRATION_URL` at the new resource, redeploy, unfreeze.

Why schema-from-migrations rather than a full dump: `drizzle/` is the authority on the schema,
the orchestrator is the authority on roles and grants, and both are already exercised on every
deploy. A full `pg_dump` would restore its *own* idea of grants and policies, which is a second
source of truth we would then have to diff.

Four details that make or break step 4, each of which is a task:

- **Exclude drizzle's journal.** The target already has 64 rows in
  `drizzle.__drizzle_migrations` from step 2. Restoring the source's copy duplicates them and
  aborts the whole `--single-transaction` restore on a PK conflict. `--schema=public` excludes it.
- **Restore as a superuser, not the owner.** Tenant tables are `FORCE ROW LEVEL SECURITY`, so
  even the table owner is subject to policies — and the policies are `TO builderhunt_app` with a
  `current_setting('app.organization_id')` predicate that is unset during a restore, so a
  non-bypassing role inserts **zero rows into every tenant table** and the restore either fails
  or, worse, half-succeeds. Superusers bypass RLS regardless of `FORCE`;
  `builderhunt_owner` is explicitly `NOBYPASSRLS NOLOGIN` (`drizzle/0002:22`) and cannot be
  used. `DATABASE_MIGRATION_URL` is the resource superuser per the runbook — a task asserts
  `rolsuper` before the window rather than discovering it during it.
- **`--disable-triggers` is for FK constraint triggers.** There are zero user triggers
  (verified), but a data-only restore inserts tables in alphabetical order, which violates FK
  ordering. `--disable-triggers` requires superuser, which the previous point already secured.
- **Drop the HNSW index before the restore, recreate after.** Maintaining an HNSW index during
  a bulk data-only load is the slow way to get the same index.
- **Assert collation parity first.** The target cluster is `initdb`'d fresh inside the image
  rather than upgraded in place, so nothing structurally guarantees it shares the source's
  `datcollate` / `datctype` / locale provider. A mismatch changes text `ORDER BY` results and the
  equality semantics behind every text unique index in the schema — which shows up either as a
  restore failing on a row that was not a duplicate before, or as silently different sort order in
  the UI afterwards. Same image family makes a mismatch unlikely; "unlikely" is not the standard
  for something that fails this quietly, so it is an assertion, not an assumption.

### Rejected: in-place `pg_upgrade`

Retains optimizer statistics and is faster on large clusters, but: it needs *both* majors'
binaries **plus pgvector 0.8.5 for both** in one image (`pgautoupgrade` does not ship the
pgvector build this app pins); PG18's `initdb` enables data checksums by default while the
existing pg16 cluster was created without them, so the checksum settings must be forced to match
or `pg_upgrade` refuses; and it mutates the live volume, which turns rollback into a
volume-snapshot problem instead of "the old resource is still running". At this data size the
statistics win is one `ANALYZE`. Documented as the fallback if the database ever gets big enough
to change that arithmetic.

## 5. Blockers found while writing this plan

Four, all pre-existing, all fixed here rather than worked around:

1. **The daily backup is not a valid upgrade vehicle.** `scripts/db/backup.ts:56` dumps with
   `--no-owner --no-acl`, which strips every GRANT — and roles are cluster-global, so a fresh
   PG18 cluster has no `builderhunt_app`/`auth`/`worker`/`platform`/`readonly` at all. Restoring
   that dump into an empty cluster produces tables no runtime role can read, and any policy
   referencing a missing role fails outright. The upgrade therefore uses a *separate* dump
   invocation (§4) and the daily backup script is left alone — but the runbook must stop
   implying the daily backup is a migration tool.
2. **`FORCE ROW LEVEL SECURITY` + data-only restore = silent zero-row tables** unless the
   restore connects as a superuser. §4, detail 2.
3. **`drizzle.__drizzle_migrations` collides** on a data-only restore into a migrated target.
   §4, detail 1.
4. **Nothing asserts the server version.** `pnpm db:up` silently defers to a `workspace-postgres`
   container this repo does not version (`package.json:22`), so a developer can be on any major
   and only find out when PG18-only SQL fails. §3F.

## 6. Success metrics

- `SHOW server_version` reports 18.x in dev, CI and production, and
  `SELECT extversion FROM pg_extension WHERE extname = 'vector'` reports `0.8.5` in all three.
- The full gate is green on PG18: `pnpm test`, `pnpm type-check`, `pnpm lint`,
  `pnpm test:migrations:local`, `pnpm test:rls:local`, `pnpm test:api-isolation:local`
  (86/86 checks), plus the restore rehearsal against a PG18 target.
- Per-table row-count parity between the pg16 source and the pg18 target, captured as a diff
  artifact, zero rows lost.
- The HNSW `EXPLAIN` regression test (`public-builder-embeddings.test.ts`) still asserts
  `Index Scan using builder_embeddings_hnsw_idx` with no `Sort Key:` on PG18.
- p95 of `POST /api/search/semantic` no worse than the pre-cutover baseline, from the same
  measurement method used for the ordering fix.
- Each §3 adoption carries its own recorded measurement — including the ones that come back
  "no measurable difference".

## 7. Resolved edge cases

- **The local PG16 volume.** `builderhunt_postgres_data` holds a PG16 data directory; the PG18
  container refuses to start on it ("database files are incompatible with server"). Local data is
  disposable: `docker compose --profile standalone down -v` → `pnpm db:up` → `pnpm deploy:db` →
  `pnpm db:seed-admin`. Documented in the runbook, not scripted, because destroying a volume
  should stay a deliberate act.
- **`workspace-postgres`.** If that container is running, `pnpm db:up` never starts the compose
  service and the app talks to a cluster outside this repo. The runbook says so and the Phase 6
  version gate makes the mismatch fail loudly instead of weirdly.
- **`max_connections=200`.** The compose `command:` override is version-independent and stays.
- **`pg_isready` healthchecks** are unchanged in 18, in compose and in the CI service block.
- **postgres.js 3.4.9.** Speaks protocol 3.0; PG18's 256-bit cancel keys need 3.2, and the
  server stays 3.0-compatible (older clients just get the short key). `{ prepare: false }` is
  unaffected. Proven by running the suite, not by reasoning.
- **md5 deprecation warnings.** Orchestrator step 5 runs `ALTER ROLE … PASSWORD`, which warns on
  18 *only* when the result is md5-encrypted. Default `password_encryption` is
  `scram-sha-256`, so there should be no warning; if one appears, the fix is scram, **not**
  `md5_password_warnings = off`.
- **Backups across the cutover.** The 03:00 UTC cron keeps running. Note the asymmetry in the
  runbook: dumps taken from pg16 restore into pg16 or 18, dumps taken from pg18 restore only
  into 18. Retention (30 days) spans the cutover, so label the boundary.
- **Rollback's point of no return.** Until the app is repointed, rollback is "keep using pg16".
  After the app writes to pg18, rollback means restoring the pre-cutover state to pg16 and losing
  post-cutover writes. Phase 4 names that moment explicitly and requires it to be acknowledged
  before the repoint, not after.
