# PostgreSQL 18 Upgrade (plan)

> **Status**: `implemented`
> **Depends on**: nothing — but see [`spec.md`](./spec.md) §1, "The sequencing rule": no PG18-only SQL may merge until Phase 4 is done and observed.
> **Blocks**: nothing today; Phase 4 is the dependency any future plan cites before using `uuidv7()`, `RETURNING old/new`, skip-scan-dependent index changes or `NOT NULL NOT VALID`.
> **Reality check** (re-verified 2026-07-27): Changes `docker-compose.yml:8`, `.github/workflows/quality.yml:16`, `docs/operations/deploy-runbook.md` (Coolify Postgres resource at `:87`, the env table at `:121-125`, + the new cutover runbook), `docs/operations/database-migrations.md` (pgvector section at `:30-41`, expand-step guidance), `docs/runbook.md` (cron table §3, backup targets §2), `scripts/deploy/orchestrate.mjs` (version gate, Phase 6). Phase 5 touches `src/shared/lib/db/schema.ts` (four `DEFAULT` swaps), `src/shared/lib/repositories/public-builder-embeddings.ts` + `src/lib/semantic/index-writer.ts` (`RETURNING old/new`), and conditionally drops one `conversion_events` index. Production topology (Coolify resources, Hetzner VPS cron) is operator work, not code. **Every image this plan touches must be a `pgvector/pgvector:*` image** — see [`spec.md`](./spec.md) "Hard requirement".

## Phases (dependency order — shippable after each)

### Phase 0 — Rehearsal on a throwaway PG18 cluster (no repo change)

**This phase is the gate. It does not get shortened.** Prove the §4 path before proposing it to
production. Stand up `pgvector/pgvector:0.8.5-pg18` locally on a scratch volume, run
`pnpm deploy:db` against it, then run the exact dump/restore pipeline from a copy of a real (or
fully seeded) pg16 database: `--schema=public` data-only dump, superuser restore with
`--disable-triggers --single-transaction`, HNSW drop/recreate, `ANALYZE`, row-count diff.

Three dangerous claims must be **reproduced against a live PG18 cluster**, not argued, before
anything in Phase 2 touches production. Each is a separate task in `tasks.md`, each records the
literal error text it produced, and a claim that fails to reproduce corrects the spec rather than
being quietly dropped:

1. **`FORCE ROW LEVEL SECURITY` + a non-superuser data-only restore silently lands zero rows.**
   64 tables are `FORCE`d and all seven `builderhunt_*` roles are `NOSUPERUSER … NOBYPASSRLS`, so
   deliberately attempt the restore as `builderhunt_app` and record what actually happens.
2. **`drizzle.__drizzle_migrations` aborts a `--single-transaction` restore** when the `drizzle`
   schema is not excluded. Repeat the dump without `--schema=public` on a second scratch target
   and record the duplicate-key error.
3. **Collation / locale parity between the source and a freshly `initdb`'d PG18 target is not
   structurally guaranteed.** Compare `datcollate` / `datctype` / `datlocprovider` / `daticulocale`
   and `server_encoding` on both, and record the values — not "they matched".

Output: measured dump size, dump/restore wall time (the write-freeze budget), a row-count parity
script that Phase 3 and Phase 4 reuse, and the three recorded reproductions. Shippable: nothing
changes; we either have a working path or we stop here.

### Phase 1 — Dev + CI onto PG18, pgvector pinned, second CI leg on pg18

`docker-compose.yml` → `pgvector/pgvector:0.8.5-pg18`. `.github/workflows/quality.yml` gains a
**second, DB-only job** on `pgvector/pgvector:0.8.5-pg18`, while the existing monolithic `quality`
job is pinned to `pgvector/pgvector:0.8.5-pg16` and stays there until Phase 6 — production is still
16, which is the sequencing rule. (A `strategy.matrix` on `quality` would double E2E, build,
a11y and Lighthouse for no version-specific signal; see [`spec.md`](./spec.md) §1.) Local reset
instructions in the runbook, since the existing `builderhunt_postgres_data` volume is a PG16 data
directory the new image will refuse. Then the whole gate on 18: `pnpm test`, `pnpm type-check`,
`pnpm lint`, `pnpm test:migration-integrity`, `pnpm test:migrations:local`, `pnpm test:rls:local`,
`pnpm test:api-isolation:local`, plus the HNSW `EXPLAIN` test and `pnpm db:restore-test`.
**Zero PG18-only syntax merges in this phase.** Shippable: production untouched and still on 16,
now with CI proving the code runs on both.

### Phase 2 — Production runbook + parallel PG18 resource (no cutover)

Write the cutover section of `docs/operations/deploy-runbook.md`: create the second Coolify
Postgres resource on `pgvector/pgvector:0.8.5-pg18` (pgvector image mandatory) with its own
persistent volume, run `pnpm deploy:db` against it (which is also the honest test that every
migration `0000`–head applies cleanly on 18 in the real environment), assert `rolsuper` on the
migration role, and leave it idle. Correct three stale statements while in there:
`database-migrations.md:40-41` ("The data volume persists across the image swap since the Postgres
major version is unchanged" — true for 16→16, false for 16→18); `deploy-runbook.md:87-89`
("Image **must** be `pgvector/pgvector:pg16` … so the data volume is compatible"); and
`deploy-runbook.md:121-125`, whose `DATABASE_*_URL` table omits `DATABASE_CAPABILITY_URL`
(`builderhunt_capability`, from `drizzle/0078`) that the orchestrator has provisioned since
`orchestrate.mjs:76`. State that the daily `scripts/db/backup.ts` dump is **not** an upgrade
vehicle (`--no-owner --no-acl`, no globals). Shippable: production still serving from pg16, with a
verified-empty pg18 resource standing by.

### Phase 3 — Full-fidelity restore rehearsal against production data

Take a fresh production backup, restore it into a *third* scratch PG18 database (never the
cutover target), run the §4 pipeline end to end, and diff row counts per table. Point a local app
build at that scratch database and exercise login, search, semantic search, alerts, exports and
the admin surface. Measure the real write-freeze budget from the real data size. Shippable:
nothing in production changed; the cutover is now a rehearsed procedure with a known duration.

### Phase 4 — Production cutover (the only irreversible step)

Announce the window. Pause the VPS cron entries listed in [`docs/runbook.md`](../../../docs/runbook.md)
§3, stop the app resource (all background work is HTTP-triggered and idempotent, so a stopped app
is a full write freeze). Take the pre-cutover dump. Run the pipeline into the standing pg18
resource. `ANALYZE`, recreate `builder_embeddings_hnsw_idx`, verify row-count parity, verify all
**six** LOGIN runtime roles can authenticate (`app`, `worker`, `readonly`, `auth`, `platform`,
`capability`) and that a tenant-scoped read returns rows through RLS for organization A and zero
rows for organization B. **Acknowledge the point of no return in writing**, then repoint every set
`DATABASE_*_URL` env var in Coolify (up to six — see [`spec.md`](./spec.md) §4 step 6) plus the two
backup jobs, redeploy (which re-runs `pnpm deploy:db` — idempotent, so it is a no-op plus a
role-password re-provision), unpause cron, unfreeze. Watch `/api/health`, `pg_stat_io`, error rates
and semantic-search p95 for one soak period. Keep the pg16 resource stopped-but-intact for a
documented retention window.

### Phase 5 — Feature adoption (only after Phase 4 is observed)

Now PG18-only SQL is legal. Independent, in this order:

1. **`uuidv7()` defaults** on the four append-heavy uuid PKs — `builderSourceSnapshots`,
   `builderProfileViews`, `migrationBackfillConflicts`, `enrichmentEvidence` (find them by name;
   at 2026-07-27 they sit at `schema.ts:167, 428, 715, 934`) — via one generated migration, plus
   the insert benchmark that either substantiates or refutes the locality win. The other 20
   `.defaultRandom()` columns in the schema are out of scope for this plan.
2. **`RETURNING old/new`** in `upsertBuilderEmbeddingStub`, returning `contentChanged`, consumed
   by `index-writer.ts` as one structured counter. Verify the SQL drizzle actually emits.
3. **Skip-scan index consolidation** on `conversion_events` — `EXPLAIN` on a ≥ 500k-row seeded
   copy first; drop `conversion_events_server_day_idx` only if the composite index is chosen and
   `Index Searches: N > 1` appears. Otherwise keep both and record the negative result.
4. **`NOT NULL ... NOT VALID`** documented as the sanctioned expand step in
   `database-migrations.md`.
5. **Ops surface**: `pg_stat_io` / `pg_aios` in the runbook's DB health section,
   `log_lock_failures = on`, and the explicit "never `io_method=io_uring` under Docker" note.

### Phase 6 — Enforce the floor, drop pg16

Add the version-assertion step to `scripts/deploy/orchestrate.mjs` between `waitForDatabase`
(`:149`) and `ensureDatabaseExists` (`:176`) — `current_setting('server_version_num')::int`, floor
from optional `DEPLOY_DB_MIN_PG_MAJOR`, default 18, fatal with a runbook pointer — and update the
step table in `deploy-runbook.md:46-54`, which will then describe 9 steps. Move the `quality` job
to `pgvector/pgvector:0.8.5-pg18` and delete the separate pg18 DB job Phase 1 added. Update
[`../../_meta/app-reality.md`](../../_meta/app-reality.md) so the next plan does not read a stale
version — its DB line is already stale independently of this plan (it says 46 migrations / 68
tables, verified 2026-07-24; the working tree has 86 and 95).

## Risks

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| PG18-only SQL merges while production is still on 16 → `drizzle-kit migrate` syntax-errors inside `post_deployment_command`, after the container is already live | Medium (it is a discipline problem, not a technical one) | High | Phases 0–4 contain zero PG18-only syntax; CI runs a pg16 + pg18 matrix for the whole window; Phase 5 is gated on Phase 4 being observed; Phase 6 makes the floor a script |
| A PG18 image **without pgvector** is used for any target (dev, CI, scratch, or either production resource) | Low, but it has happened once in production already | **Critical** — `drizzle/0013`'s `CREATE EXTENSION vector` fails inside `drizzle-kit migrate`, the whole migration chain rolls back, the organization tables never exist and login 500s. Orchestrator step 3 is *soft* and only warns, so the mistake surfaces one step later | Pin `pgvector/pgvector:0.8.5-pg18` everywhere; the first Phase 0 task asserts `SELECT extversion FROM pg_extension WHERE extname='vector'` returns `0.8.5` before anything else runs; the runbook states the image is mandatory, not recommended |
| Data-only restore silently inserts nothing into tenant tables (58 `FORCE ROW LEVEL SECURITY` tables, 356 policies across 5 roles, `app.organization_id` / `app.submission_id` unset) | Certain if the restore role is not a superuser | Critical (silent partial data loss) | Restore as the resource superuser — **all seven** `builderhunt_*` roles are `NOSUPERUSER … NOBYPASSRLS` and `builderhunt_owner` is additionally `NOLOGIN`, so none can be used; `rolsuper` asserted in Phase 0 and again in Phase 2, before the window; Phase 0 reproduces the failure deliberately; per-table row-count parity is a gate, not a formality |
| A restore leaves RLS forced with **zero policies** — row counts and table counts both look perfect | Certain for any schema-carrying restore into a cluster whose roles do not exist yet; this is the 2026-07-26 incident (192 policies missing, 54 tables forced-and-empty-of-policy) | Critical (unusable DB, and the obvious incident-time "fix" of dropping RLS turns it into a real leak) | The `--data-only` path avoids it by construction, but assert it anyway: `verifyRlsIntegrity` (`scripts/db/restore.ts:194`) after every restore in Phases 0, 3 and 4. Any **rollback** restore of the full `pg_dump -Fc` artifact goes through `pnpm db:restore` (roles-first from `scripts/db/roles.sql`), never a bare `pg_restore` |
| `drizzle.__drizzle_migrations` PK collision aborts the `--single-transaction` restore | Certain without mitigation | Medium (window overrun) | `pg_dump --schema=public` excludes the `drizzle` schema; the target's journal comes from `pnpm deploy:db`; rehearsed in Phase 0 |
| Coolify's 03:00 backup and the 03:30 `builderhunt-backup-sync.sh` roles capture keep pointing at the retired pg16 resource after the cutover | Medium — they are configured against the DB *resource*, not `DATABASE_URL`, so repointing env vars does not move them | High (silent loss of backup coverage, discovered only at the next restore) | Repointing both backup jobs is a checklist item in the Phase 4 repoint task, verified by confirming a dump lands from the pg18 resource before the pg16 retention window closes |
| The fresh pg18 cluster is created with a different collation / locale provider than the pg16 source → text `ORDER BY` changes and text unique indexes change their idea of "duplicate" | Low (same image family) but **nothing structurally prevents it**, since the target is created fresh rather than upgraded in place | High (either a restore that fails on a non-duplicate, or silently different sort order in the UI) | Explicit `datcollate`/`datctype`/`datlocprovider`/`daticulocale` parity assertion before the restore, in Phase 0 (local) **and again** in Phase 3 against real production; a mismatch is a full stop, fixed by creating the target database with the source's locale settings and re-running `pnpm deploy:db` |
| Someone treats the daily `backup.ts` dump as the upgrade vehicle (`--no-owner --no-acl`, no globals) | Medium | High | The upgrade uses its own dump invocation; the runbook and `database-migrations.md` both say so explicitly; the daily script is left untouched so its contract does not change |
| FK ordering breaks a data-only restore (alphabetical table order) | Certain without mitigation | Medium | `--disable-triggers` (superuser-only, already secured) + `--single-transaction`; zero user triggers exist, so nothing else is suppressed |
| HNSW index maintained during the bulk load turns minutes into hours | Medium | Medium | Drop `builder_embeddings_hnsw_idx` before the restore, recreate after with raised `maintenance_work_mem`; the `EXPLAIN` regression test proves it came back usable |
| Missing statistics after restore → bad plans on the first live traffic | High without mitigation | Medium | `ANALYZE` is a required step, not optional; this is the one thing the dump/restore path gives up versus `pg_upgrade`, and it costs one command |
| Rollback wanted after production has written to pg18 | Low | High | The window's point of no return is named and acknowledged *before* the repoint; the pg16 resource stays stopped-but-intact for a documented retention window; post-cutover rollback means restoring the pre-cutover dump to pg16 and accepting the loss of post-cutover writes |
| `pgvector/pgvector:0.8.5-pg18` behaves differently from the floating `pg16` tag production runs today | Low | Medium | [`../README.md`](../../phase-2/README.md) (lines 209–211) already assumes pgvector 0.8.5 semantics; pinning makes it enforced. Phase 1 re-runs the HNSW `EXPLAIN` test and Phase 3 compares a real semantic-search result set before/after |
| A developer's `workspace-postgres` cluster is still PG16 and PG18-only SQL fails only for them | Medium | Low | Documented in the runbook; Phase 6's version gate turns it into a clear fatal error with remediation instead of a confusing syntax error |
| `conversion_events_server_day_idx` gets dropped on the strength of a release note and aggregates regress | Medium | Medium | The drop is conditional on `EXPLAIN` evidence at ≥ 500k rows including PG18's `Index Searches:` counter; a negative result keeps both indexes and is recorded |
| `RETURNING old/new` does not survive drizzle's SQL emission | Medium | Low | Verified against a real PG18 database on the emitted SQL, not the intended SQL; the change is additive and reverts to `Promise<void>` in one commit |
| md5 deprecation warnings make orchestrator step 5 look failed | Low | Low | Default `password_encryption` is `scram-sha-256`, so no warning is expected; if one appears the fix is scram, never `md5_password_warnings = off` |
| Local dev loses its database on the image bump | Certain | Low | Local data is disposable; the runbook documents `down -v` → `pnpm db:up` → `pnpm deploy:db` → seed. Not scripted, because destroying a volume should stay deliberate |

## Rollback

- **Phase 6**: set `DEPLOY_DB_MIN_PG_MAJOR=16` (or revert the step). It is a single guard clause.
- **Phase 5**: each item reverts independently.
  - `uuidv7()`: a forward migration setting `DEFAULT gen_random_uuid()` back. Existing rows are
    untouched either way; a column holding both v4 and v7 values stays valid, so there is nothing
    to repair.
  - `RETURNING old/new`: revert the repository function to `Promise<void>` and drop the counter.
  - Index drop: recreate `conversion_events_server_day_idx` (`CREATE INDEX CONCURRENTLY`).
  - Docs and config changes: revert the commit.
- **Phase 4** is the irreversible one. **The point of no return is the moment the repointed app
  first writes to pg18** — i.e. the moment the redeploy in the "repoint and redeploy" task
  completes and traffic is unfrozen. Every earlier step in Phase 4 (freeze, dump, restore, parity,
  role checks) is reversible by simply unfreezing pg16 and deleting nothing.
  - *Before* that moment: rollback is "do nothing, stay on pg16" — zero data cost.
  - *After* it: stop the app; restore the pre-cutover artifact into the still-intact pg16 resource
    **via `pnpm db:restore`, not a bare `pg_restore`** (the full `pg_dump -Fc` carries
    `CREATE POLICY … TO builderhunt_*` statements that need cluster roles applied first — see the
    RLS-integrity risk row); repoint every `DATABASE_*_URL` and both backup jobs back; redeploy —
    and accept the loss of everything written to pg18 after the cutover.
  That asymmetry is why the task before the repoint requires the point of no return to be
  acknowledged in writing, in the deploy log, with a timestamp.
- **Phases 0–3** change nothing in production and revert by deleting scratch resources. Phase 2
  creates a standing pg18 resource but never points anything at it; reverting is deleting it.
- **Phase 1** reverts by restoring the pg16 image tags and deleting the pg18 CI job. Note this is
  the one revert with a local cost: developers who already reset onto a PG18 volume must reset
  again (`docker compose --profile standalone down -v` → `pnpm db:up` → `pnpm deploy:db` →
  `pnpm db:seed:admin`).
