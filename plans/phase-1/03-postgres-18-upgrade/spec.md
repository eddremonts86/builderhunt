# PostgreSQL 18 Upgrade (spec)

> **Status**: `pending`
> **Depends on**: nothing — but it is **strictly ordered against every other plan** (see "The sequencing rule"). Any plan that wants PG18-only SQL waits for Phase 4 of this one.
> **Blocks**: nothing today. It unblocks the four PG18 capabilities listed in §3 for later plans (notably `NOT NULL ... NOT VALID` expand steps, which every future expand/contract migration should use).
> **Reality check** (re-verified 2026-07-27; the four counts below re-derived 2026-07-28 when this plan moved into phase-1 at position 03): all three environments run `pgvector/pgvector:pg16` — [`docker-compose.yml:8`](../../../docker-compose.yml), [`.github/workflows/quality.yml:16`](../../../.github/workflows/quality.yml), and [`docs/operations/deploy-runbook.md:87`](../../../docs/operations/deploy-runbook.md) ("Image **must** be `pgvector/pgvector:pg16`"). The database is provisioned forward-only by [`scripts/deploy/orchestrate.mjs`](../../../scripts/deploy/orchestrate.mjs) (`pnpm deploy:db`, **8** idempotent steps), from **98** migrations in `drizzle/` (head `0097_scheduling_busy_ranges.sql`) covering **101** `pgTable`s, with `FORCE ROW LEVEL SECURITY` on **64** tables (first established in `drizzle/0008_tenant_rls.sql`, most recently extended by `drizzle/0095`) and **six** non-owner LOGIN roles plus the `NOLOGIN` owner (`drizzle/0002_database_roles.sql`, `0007_auth_broker.sql`, `0012_platform_role.sql`, `0078_capability_role.sql`). The local daily backup is plain-SQL `pg_dump --no-owner --no-acl --clean --if-exists` ([`scripts/db/backup.ts:56`](../../../scripts/db/backup.ts)); production's actual 03:00 UTC backup is Coolify's own custom-format `pg_dump`, with `scripts/ops/builderhunt-backup-sync.sh` capturing `pg_dumpall --roles-only --no-role-passwords` at 03:30 ([`docs/runbook.md`](../../../docs/runbook.md) §2–3). The restore path is `pnpm db:restore` ([`scripts/db/restore.ts`](../../../scripts/db/restore.ts) — roles-first from `scripts/db/roles.sql`, then a `verifyRlsIntegrity` postcondition) and the rehearsal harness is `pnpm db:restore-test` ([`scripts/db/restore-test.ts`](../../../scripts/db/restore-test.ts), custom-format `pg_restore`). **No code anywhere asserts a Postgres version** — `grep -rn server_version src/ scripts/ drizzle/` returns zero matches (re-run 2026-07-27).

## Problem

Nothing is on fire. PostgreSQL 16 is supported until November 2028, so this is not a
forced upgrade and must not be sold as one. The actual case is narrower:

1. **The upgrade only gets more expensive.** The cutover cost is a function of data size and of
   how many tenants are writing. Today the app bills nobody: the Stripe integration plan
   ([`../../phase-1/30-stripe-billing-platform/spec.md`](../../phase-1/30-stripe-billing-platform/spec.md))
   is still `pending`, and while 19 `billing_*` tables exist in the schema there is no live
   checkout or webhook inbox. That makes a write-freeze window cheap in a way it will never be
   again.
2. **Four capabilities map onto code that already exists** and are not reachable on 16:
   `uuidv7()`, `RETURNING old/new`, B-tree skip scan, and `NOT NULL ... NOT VALID`. Each is
   described in §3 with the exact file it changes. Nothing here is adopted for novelty.
3. **The pgvector version is unpinned.** `pgvector/pgvector:pg16` floats.
   [`../README.md`](../../phase-2/README.md) (lines 209–211) already reasons about *specific* pgvector 0.8.5
   behaviour (`ef = max(ef_search, limit)`), and
   [`look-alike-sourcing`](../../phase-4/look-alike-sourcing/plan.md) depends on it. That assumption is
   currently accidental. Pinning `0.8.5-pg18` makes a load-bearing claim enforced instead of lucky.
4. **A version mismatch is silent.** `pnpm db:up` no-ops when a container named
   `workspace-postgres` is already running (`package.json:23`) — a cluster this repo does not
   own or version. Nothing fails loudly if dev, CI and prod disagree on the major version. That
   is a pre-existing gap this plan closes regardless of which version wins.

## Goal

Move dev, CI and production to `pgvector/pgvector:0.8.5-pg18` with zero data loss, a rehearsed
restore, verified row-count parity and a rollback that stays available until an explicit
point of no return — then adopt exactly the four PG18 capabilities that touch code we already
have, each independently revertable and each with a measurement rather than a claim.

### Hard requirement: the target image must ship pgvector

**Every** image this plan puts in front of a BuilderHunt database — dev, CI, the scratch
rehearsal clusters, and both production Postgres resources — must be a `pgvector/pgvector:*`
image. A plain `postgres:18*` image is forbidden, in this plan and in any deviation from it.

This is not a preference. `drizzle/0013_polite_night_thrasher.sql` runs `CREATE EXTENSION vector`
and then `CREATE INDEX "builder_embeddings_hnsw_idx" … USING hnsw`. On an image without the
extension available, that statement fails inside `drizzle-kit migrate`, which runs in a single
transaction per migration file and is a **fatal** orchestrator step
([`docs/operations/deploy-runbook.md`](../../../docs/operations/deploy-runbook.md), step 4) — so
the whole chain rolls back. Production has already had this incident: the DB resource was
briefly created on `postgres:16-alpine`, migration `0013` aborted, every migration after it never
applied, the organization tables did not exist, and login returned 500 until the resource was
recreated on `pgvector/pgvector:pg16`. Note that orchestrator step 3
(`CREATE EXTENSION IF NOT EXISTS vector`) is deliberately **soft** — it only *warns* — so the
image mistake does not announce itself there; it detonates one step later inside `0013`.

`pgvector/pgvector:0.8.5-pg18` is the tag this plan pins. Verified present on Docker Hub
2026-07-27 (`amd64` + `arm64`, published 2026-07-08), alongside `0.8.5-pg16` which Phase 1's CI
leg pins.

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
- **No migration rewriting.** The 86 existing migrations stay byte-identical; they are immutable
  once applied ([`docs/operations/database-migrations.md`](../../../docs/operations/database-migrations.md),
  line 3).

## 1. The sequencing rule (the most important paragraph in this plan)

Between the moment CI moves to PG18 and the moment production does, **production is running
code that CI only tested on 18**. If any PG18-only SQL merges in that window, production breaks
on the next deploy with a syntax error inside `drizzle-kit migrate` — i.e. mid-`post_deployment_command`,
after the container is already live.

Therefore:

- Phases 0–4 (the version move) contain **zero PG18-only syntax**. They are pure
  infrastructure: images, docs, rehearsals, cutover.
- During the window, `.github/workflows/quality.yml` must prove the code runs on **both** majors.
  Note the shape of that file before planning it: there is exactly **one** job that touches
  Postgres (`quality`), and it is monolithic — migrations, RLS, API isolation, restore rehearsal,
  lint, type-check, unit tests, Playwright E2E, `pnpm build`, the a11y gate and Lighthouse all run
  in it. A `strategy.matrix` over the service image would therefore run *all* of that twice, not
  just the DB checks. Phase 1 instead adds a **second, DB-only job** on pg18 and leaves `quality`
  on pg16 until Phase 6. Same coverage of the parts that can differ between majors, at a fraction
  of the CI minutes.
- Phase 5+ (feature adoption) may not merge until Phase 4 is done and observed.
- Phase 6 installs the version gate so the rule is enforced by a script instead of by memory,
  and drops pg16 from the CI matrix.

Any other plan that wants `uuidv7()`, `RETURNING old/new`, skip-scan-dependent index changes or
`NOT NULL NOT VALID` links to this plan's Phase 4 as a dependency.

## 2. What we are actually running against

Re-verified 2026-07-27 against the working tree. Every "grep" row below names the exact command,
so a reviewer re-runs it rather than trusting it — and **must** re-run it, because the counts in
this table move with every migration.

| Fact | Value | How to re-verify |
| ---- | ----- | ---------------- |
| Image (dev / CI / prod) | `pgvector/pgvector:pg16`, unpinned pgvector | `docker-compose.yml:8`, `.github/workflows/quality.yml:16`, `docs/operations/deploy-runbook.md:87` |
| Migrations | **86** (`drizzle/0000` … `drizzle/0085_candidate_documents_rls_grants.sql`; `0084`/`0085` are untracked working-tree WIP) | `ls drizzle/*.sql \| wc -l`; `jq '.entries \| length' drizzle/meta/_journal.json` |
| Tables | **95** `pgTable` declarations (92 at `git show HEAD:`) | `grep -c 'pgTable(' src/shared/lib/db/schema.ts` |
| `serial` / `CREATE SEQUENCE` in app schema | **zero** | `grep -rniE '\bserial\b\|CREATE SEQUENCE' drizzle/*.sql` → 0. Matters for §4 (no sequence resync) |
| Triggers | **zero** `CREATE TRIGGER` | `grep -rn 'CREATE TRIGGER' drizzle/*.sql` → 0. PG18's AFTER-trigger role change is N/A |
| Full-text search / `pg_trgm` | **zero** `to_tsvector` / `pg_trgm` / `gin(` | `grep -rniE 'to_tsvector\|pg_trgm\|gin\s*\(' drizzle/*.sql src/shared/lib/db/schema.ts` → 0. PG18's FTS collation-provider reindex requirement is N/A |
| `AT TIME ZONE '<abbrev>'` | **zero** | `grep -rn 'AT TIME ZONE' drizzle/*.sql src/` → 0. PG18's timezone-abbreviation precedence change is N/A |
| `COPY` usage | **zero** | `grep -rnE '^\s*COPY \|\bCOPY \w+ FROM\|copyFrom' drizzle/*.sql src/ scripts/` → 0. PG18's CSV `\.` change is N/A |
| Extensions | `vector` only (`drizzle/0013_polite_night_thrasher.sql`) | `orchestrate.mjs` step 3 (**soft** — see the hard-requirement box above) |
| RLS | `FORCE ROW LEVEL SECURITY` on **58** distinct tables; policies target five roles: `app` (141), `worker` (129), `platform` (41), `capability` (37), `auth` (8) | `grep -rhoE 'ALTER TABLE [\"a-z_]+ FORCE ROW LEVEL SECURITY' drizzle/*.sql \| sort -u \| wc -l`; `grep -rhoE 'TO builderhunt_[a-z_]+' drizzle/*.sql \| sort \| uniq -c` |
| Roles | 7: `builderhunt_owner` (NOLOGIN) + `app`, `worker`, `readonly`, `auth`, `platform`, `capability` (all LOGIN) | `grep -rhoE 'builderhunt_[a-z_]+' drizzle/*.sql \| sort -u`; created in `0002`, `0007`, `0012`, `0078` |
| Every role is `NOBYPASSRLS NOSUPERUSER` | all 7, without exception | `grep -rn 'NOBYPASSRLS' drizzle/*.sql` → 7 `ALTER ROLE` lines. **This is why §4 needs the resource superuser.** |
| `builderhunt_owner` | `NOLOGIN NOSUPERUSER … NOBYPASSRLS` | `drizzle/0002_database_roles.sql:22` |
| `uuid` PKs on `gen_random_uuid()` | **24** `.defaultRandom()` columns (21 at `git show HEAD:`) — §3A adopts `uuidv7()` on 4 of them | `grep -n 'defaultRandom()' src/shared/lib/db/schema.ts` |
| Driver | `postgres` (postgres.js) `^3.4.9`, `{ prepare: false }` | `package.json:103`, `src/shared/lib/db/client.ts:36` |
| ORM / kit | `drizzle-orm ^0.45.2`, `drizzle-kit ^0.31.10` | `package.json:92`, `package.json:126` |
| Target image exists **and carries pgvector** | `pgvector/pgvector:0.8.5-pg18`, `amd64`+`arm64`, published 2026-07-08. Sibling `0.8.5-pg16` also exists (Phase 1's CI leg pins it). | Docker Hub tags API, queried 2026-07-27: `curl -s 'https://hub.docker.com/v2/repositories/pgvector/pgvector/tags?page_size=100&name=pg18'` |

Four of PG18's published incompatibilities are therefore **not applicable to this codebase**, and
each of those four is a line item most generic upgrade checklists would have us do work for.

**Two counts moved between 2026-07-26 and 2026-07-27** (migrations 64 → 86, tables 77 → 95) because
`0084`/`0085` landed as working-tree WIP. Nothing in the upgrade path depends on the specific
numbers — it depends on `drizzle/` being the authority and `pnpm deploy:db` replaying all of it —
but any task that *asserts* a count must re-derive it at execution time, never quote this table.

## 3. What we adopt, and why each one earns its place

### A. `uuidv7()` as the default for four append-heavy uuid PKs

**24** columns are `uuid('id').primaryKey().defaultRandom()` → `DEFAULT gen_random_uuid()`
(`grep -n 'defaultRandom()' src/shared/lib/db/schema.ts`; this was 6 when the plan was first
written on 2026-07-26 — the calendar-scheduling and candidate-document tables added the other 18).
A v4 UUID is uniformly random, so every insert lands on a random leaf page of the PK index: more
page splits, more WAL, worse cache locality. `uuidv7()` is time-ordered, so inserts append.

**Scope did not grow with the count.** This plan still adopts `uuidv7()` on exactly the four
append-heavy tables below and touches nothing else. The other 20 are out of scope here — not
rejected, just unexamined; whoever examines them cites this section's rule.

Identify each table by its `export const` name, not by line number: the six lines below moved
between 2026-07-26 and 2026-07-27 and will move again.

| Table (`export const`) | Line (2026-07-27) | Write pattern | Adopt? |
| ---------------------- | ----------------- | ------------- | ------ |
| `builderSourceSnapshots` / `builder_source_snapshots` | 167 | one row per source fetch per identity | **yes** |
| `builderProfileViews` / `builder_profile_views` | 428 (was 411) | one row per profile view | **yes** |
| `enrichmentEvidence` / `enrichment_evidence` | 934 (was 892) | one row per enrichment observation | **yes** |
| `migrationBackfillConflicts` / `migration_backfill_conflicts` | 715 (was 673) | one row per backfill conflict | **yes** |
| `builderProcessingRestrictions` / `builder_processing_restrictions` | 981 (was 939) | rare, compliance record | no |
| `billingSellerProfiles` / `billing_seller_profiles` | 1536 (was 1494) | one row per seller | no |

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

`conversionEvents` / `conversion_events` (`schema.ts:1757`, was 1715) is append-only
landing-funnel data and carries four indexes, two of which overlap:

- `conversion_events_name_server_day_idx (name, server_day)` (`schema.ts:1772`, was 1730)
- `conversion_events_server_day_idx (server_day)` (`schema.ts:1771`, was 1729)

`name` is constrained by a `CHECK` to **7 values** — `landing_view`, `hero_signup_click`,
`hero_explore_click`, `explore_search_complete`, `explore_signup_click`, `signup_submit`,
`signup_complete` (`conversion_events_name_check`, `schema.ts:1774-1779`) — precisely the
low-cardinality leading column PG18's skip scan is for. If a `server_day`-only aggregate can be
served by the composite index, the single-column index is dead weight on a table whose only
write pattern is INSERT.

This is adopted **conditionally**, and the condition is real: at small row counts the planner
picks a sequential scan no matter what, so the drop must be justified by `EXPLAIN` on a
realistically seeded copy (≥ 500k rows) of the actual aggregate queries in the conversion
repository (`src/shared/lib/repositories/conversion-events.ts`), asserting an index scan on the
composite index and PG18's new `Index Searches: N`
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

1. Create a **second** Coolify Postgres resource on `pgvector/pgvector:0.8.5-pg18` — a
   pgvector-carrying image is mandatory, see the hard-requirement box above — with its own
   named volume. The pg16 resource and its volume are never touched.
2. Run `pnpm deploy:db` against the new resource. This is the most-tested path in the repo: it
   creates the database, `CREATE EXTENSION vector`, applies every migration in `drizzle/` (86 as
   of 2026-07-27 — re-derive, do not quote: tables, RLS, `FORCE ROW LEVEL SECURITY`, roles,
   grants), provisions role passwords from env, and verifies every role can log in. All 8 steps
   must pass.
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
6. Point every `DATABASE_*_URL` that is set in Coolify at the new resource, redeploy, unfreeze.
   The orchestrator knows six: `DATABASE_URL`, `DATABASE_AUTH_URL`, `DATABASE_WORKER_URL`,
   `DATABASE_PLATFORM_URL`, `DATABASE_CAPABILITY_URL` (`orchestrate.mjs:64-76`) and
   `DATABASE_MIGRATION_URL` (`orchestrate.mjs:360`). The runbook's env table
   (`deploy-runbook.md:121-125`) still lists only five — it predates the `builderhunt_capability`
   role from `drizzle/0078` and **must** be corrected by the Phase 2 runbook task. Enumerate what
   is actually set in Coolify at cutover time rather than working from either list.

Why schema-from-migrations rather than a full dump: `drizzle/` is the authority on the schema,
the orchestrator is the authority on roles and grants, and both are already exercised on every
deploy. A full `pg_dump` would restore its *own* idea of grants and policies, which is a second
source of truth we would then have to diff.

Four details that make or break step 4, each of which is a task:

- **Exclude drizzle's journal.** The target already has one row per applied migration in
  `drizzle.__drizzle_migrations` from step 2 (86 as of 2026-07-27). Restoring the source's copy
  duplicates them and aborts the whole `--single-transaction` restore on a PK conflict.
  `--schema=public` excludes it, because the journal lives in the separate `drizzle` schema.
- **Restore as a superuser, not the owner.** 58 tables are `FORCE ROW LEVEL SECURITY`, so
  even the table owner is subject to policies — and those policies target
  `builderhunt_app` (141), `builderhunt_worker` (129), `builderhunt_platform` (41),
  `builderhunt_capability` (37) and `builderhunt_auth` (8), each with a
  `current_setting('app.organization_id')` (and, for the capability role, `app.submission_id`)
  predicate that is unset during a restore. A non-bypassing role therefore inserts **zero rows
  into every tenant table** and the restore either fails or, worse, half-succeeds. Superusers
  bypass RLS regardless of `FORCE`; **all seven `builderhunt_*` roles are explicitly
  `NOSUPERUSER … NOBYPASSRLS`** (`grep -rn NOBYPASSRLS drizzle/*.sql` → 7 `ALTER ROLE` lines),
  and `builderhunt_owner` is additionally `NOLOGIN` (`drizzle/0002_database_roles.sql:22`) — so
  no application role can perform this restore. `DATABASE_MIGRATION_URL` is the resource
  superuser per the runbook (`deploy-runbook.md:121`) — a task asserts `rolsuper` before the
  window rather than discovering it during it.
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
- **Assert RLS integrity after the restore, not just row counts.** A restore is only correct if
  every table with RLS enabled also has policies. `scripts/db/restore.ts` already carries this
  check (`verifyRlsIntegrity`, `restore.ts:194`) because the 2026-07-26 restore test produced
  exactly the failure it now catches: a roles-less `pg_restore` created **192 policies silently
  not at all**, while `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` restored fine, leaving RLS
  forced on 54 tables with zero policies — fail-closed, so not a leak, but an unusable database
  whose row counts and table counts both look perfect. The `--data-only` path in §4 is not
  supposed to hit this (the target's policies come from `pnpm deploy:db`, and the roles exist
  before the restore starts), which is precisely why the assertion has to be run rather than
  reasoned about. It matters most for the **rollback artifact**: the full `pg_dump -Fc` taken in
  Phase 4 carries `CREATE POLICY … TO builderhunt_app` statements that fail on any cluster whose
  roles were not created first, so a rollback restore must go through `pnpm db:restore` (which
  applies `scripts/db/roles.sql` before `pg_restore`), never a bare `pg_restore`. See
  [`docs/operations/database-restore.md`](../../../docs/operations/database-restore.md).

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

Four, all pre-existing. Each carries a verdict re-checked against the working tree on 2026-07-27.

1. **The daily backup is not a valid upgrade vehicle.** — *still a gap, narrower than first
   written.* `scripts/db/backup.ts:56` still dumps with `--no-owner --no-acl --clean --if-exists`
   and still emits no globals — unchanged, verified 2026-07-27. That strips every GRANT, and
   roles are cluster-global, so a fresh PG18 cluster has none of
   `builderhunt_app`/`worker`/`readonly`/`auth`/`platform`/`capability`. Restoring that dump into
   an empty cluster produces tables no runtime role can read, and any policy referencing a missing
   role fails outright.
   **What changed since 2026-07-26:** the *restore* side of this is now tooled. `pnpm db:restore`
   (`scripts/db/restore.ts`) applies `scripts/db/roles.sql` before `pg_restore` and refuses to
   continue if the roles did not materialise (`restore.ts:150-158`); `scripts/ops/builderhunt-backup-sync.sh`
   captures `pg_dumpall --roles-only --no-role-passwords` beside each production dump at 03:30 UTC;
   and `docs/operations/database-restore.md` documents the whole rule. So the *hazard* is
   documented and mitigated for disaster recovery — but `backup.ts` itself is unchanged and is
   still not an upgrade vehicle. The upgrade therefore uses its own dump invocation (§4), the
   daily script is left alone so its contract does not change, and the runbook must stop implying
   the daily backup is a migration tool.
2. **`FORCE ROW LEVEL SECURITY` + data-only restore = silent zero-row tables** unless the
   restore connects as a superuser. — *still a gap, and larger.* On 2026-07-26 this was
   "tenant tables, policies `TO builderhunt_app`". At 2026-07-27 it is 58 `FORCE`d tables and 356
   policies across five roles, all seven of which are `NOSUPERUSER … NOBYPASSRLS`. §4, detail 2.
3. **`drizzle.__drizzle_migrations` collides** on a data-only restore into a migrated target.
   — *still a gap.* Nothing in the repo excludes the `drizzle` schema from a dump; the exclusion
   is a flag the operator must pass. The row count moved (64 → 86); the collision did not go
   away. §4, detail 1.
4. **Nothing asserts the server version.** — *still a gap, unchanged.*
   `grep -rn server_version src/ scripts/ drizzle/` returns zero matches on 2026-07-27. `pnpm db:up`
   silently defers to a `workspace-postgres` container this repo does not version
   (`package.json:23`), so a developer can be on any major and only find out when PG18-only SQL
   fails. §3F.

## 6. Success metrics

- `SHOW server_version` reports 18.x in dev, CI and production, and
  `SELECT extversion FROM pg_extension WHERE extname = 'vector'` reports `0.8.5` in all three.
- The full gate is green on PG18: `pnpm test`, `pnpm type-check`, `pnpm lint`,
  `pnpm test:migration-integrity`, `pnpm test:migrations:local`, `pnpm test:rls:local`,
  `pnpm test:api-isolation:local`, plus `pnpm db:restore-test` against a PG18 target.
  `test:api-isolation:local` prints a JSON summary `{ total, passed, failed, results }`
  (`scripts/db/verify-api-isolation-local.mjs:1254`); the gate is **`failed: 0` and
  `passed === total`**. Do not assert the literal `86/86` this plan and
  [`../../_meta/app-reality.md`](../../_meta/app-reality.md) used to quote — that figure is from
  2026-07-23 and the script now carries ~102 `record()` sites. Capture the actual `total` on the
  pg16 baseline run and require the pg18 run to match it.
- Per-table row-count parity between the pg16 source and the pg18 target, captured as a diff
  artifact, zero rows lost.
- The HNSW `EXPLAIN` regression test
  (`tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts:87,92`) still asserts
  `Index Scan using builder_embeddings_hnsw_idx` with no `Sort Key:` on PG18.
- p95 of `POST /api/search/semantic` no worse than the pre-cutover baseline, from the same
  measurement method used for the ordering fix.
- Each §3 adoption carries its own recorded measurement — including the ones that come back
  "no measurable difference".

## 7. Resolved edge cases

- **The local PG16 volume.** `builderhunt_postgres_data` holds a PG16 data directory; the PG18
  container refuses to start on it ("database files are incompatible with server"). Local data is
  disposable: `docker compose --profile standalone down -v` → `pnpm db:up` → `pnpm deploy:db` →
  `pnpm db:seed:admin` (note the second colon — `package.json:46`; there is no `db:seed-admin`
  script). Documented in the runbook, not scripted, because destroying a volume should stay a
  deliberate act.
- **`workspace-postgres`.** If that container is running, `pnpm db:up` never starts the compose
  service and the app talks to a cluster outside this repo (`package.json:23`). The runbook says
  so and the Phase 6 version gate makes the mismatch fail loudly instead of weirdly.
- **`max_connections=200`.** The compose `command:` override is version-independent and stays.
- **`pg_isready` healthchecks** are unchanged in 18, in compose and in the CI service block.
- **postgres.js 3.4.9.** Speaks protocol 3.0; PG18's 256-bit cancel keys need 3.2, and the
  server stays 3.0-compatible (older clients just get the short key). `{ prepare: false }` is
  unaffected. Proven by running the suite, not by reasoning.
- **md5 deprecation warnings.** Orchestrator step 5 runs `ALTER ROLE … PASSWORD`, which warns on
  18 *only* when the result is md5-encrypted. Default `password_encryption` is
  `scram-sha-256`, so there should be no warning; if one appears, the fix is scram, **not**
  `md5_password_warnings = off`.
- **Backups across the cutover.** Two jobs keep running, and they are not the same thing
  ([`docs/runbook.md`](../../../docs/runbook.md) §2–3): **03:00 UTC** is *Coolify's* scheduled
  backup of `builderhunt-db` (custom-format `pg_dump` into `/data/coolify/backups/`, 30 backups /
  30 days / 10 GB cap) — this is production's real backup, not `scripts/db/backup.ts`; **03:30 UTC**
  is `scripts/ops/builderhunt-backup-sync.sh`, which captures the cluster roles and rsyncs to the
  Hetzner Storage Box. Both must be **repointed at the new resource** as part of the Phase 4
  repoint, or backups keep covering the retired pg16 database. Note the asymmetry in the runbook:
  dumps taken from pg16 restore into pg16 or 18, dumps taken from pg18 restore only into 18.
  Retention spans the cutover, so label the boundary.
- **Rollback's point of no return.** Until the app is repointed, rollback is "keep using pg16".
  After the app writes to pg18, rollback means restoring the pre-cutover state to pg16 and losing
  post-cutover writes. Phase 4 names that moment explicitly and requires it to be acknowledged
  before the repoint, not after.
