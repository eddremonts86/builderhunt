# PostgreSQL 18 Upgrade (plan)

> **Status**: `pending`
> **Depends on**: nothing — but see [`spec.md`](./spec.md) §1, "The sequencing rule": no PG18-only SQL may merge until Phase 4 is done and observed.
> **Blocks**: nothing today; Phase 4 is the dependency any future plan cites before using `uuidv7()`, `RETURNING old/new`, skip-scan-dependent index changes or `NOT NULL NOT VALID`.
> **Reality check**: Changes `docker-compose.yml:8`, `.github/workflows/quality.yml:16`, `docs/operations/deploy-runbook.md` (Coolify Postgres resource + the new cutover runbook), `docs/operations/database-migrations.md` (pgvector section, expand-step guidance), `scripts/deploy/orchestrate.mjs` (version gate, Phase 6). Phase 5 touches `src/shared/lib/db/schema.ts` (four `DEFAULT` swaps), `src/shared/lib/repositories/public-builder-embeddings.ts` + `src/lib/semantic/index-writer.ts` (`RETURNING old/new`), and conditionally drops one `conversion_events` index. Production topology (Coolify resources, Hetzner VPS cron) is operator work, not code.

## Phases (dependency order — shippable after each)

### Phase 0 — Rehearsal on a throwaway PG18 cluster (no repo change)

Prove the §4 path before proposing it to production. Stand up
`pgvector/pgvector:0.8.5-pg18` locally on a scratch volume, run `pnpm deploy:db` against it, then
run the exact dump/restore pipeline from a copy of a real (or fully seeded) pg16 database:
`--schema=public` data-only dump, superuser restore with `--disable-triggers
--single-transaction`, HNSW drop/recreate, `ANALYZE`, row-count diff. Confirm the four §5
blockers behave as predicted — in particular, deliberately attempt the restore as a
non-superuser and record that tenant tables come back empty, so the mitigation is evidence-backed
rather than argued. Output: measured dump size, dump/restore wall time (the write-freeze budget),
and a row-count parity script that Phase 3 reuses. Shippable: nothing changes; we either have a
working path or we stop here.

### Phase 1 — Dev + CI onto PG18, pgvector pinned, two-version CI matrix

`docker-compose.yml` → `pgvector/pgvector:0.8.5-pg18`. `.github/workflows/quality.yml` → a DB job
matrix over `pgvector/pgvector:0.8.5-pg16` and `0.8.5-pg18` (both pinned; pg16 stays because
production is still 16 — the sequencing rule). Local reset instructions in the runbook, since the
existing `builderhunt_postgres_data` volume is a PG16 data directory the new image will refuse.
Then the whole gate on 18: `pnpm test`, `pnpm type-check`, `pnpm lint`,
`pnpm test:migrations:local`, `pnpm test:rls:local`, `pnpm test:api-isolation:local`, plus the
HNSW `EXPLAIN` test and the restore rehearsal. **Zero PG18-only syntax merges in this phase.**
Shippable: production untouched and still on 16, now with CI proving the code runs on both.

### Phase 2 — Production runbook + parallel PG18 resource (no cutover)

Write the cutover section of `docs/operations/deploy-runbook.md`: create the second Coolify
Postgres resource on `pgvector/pgvector:0.8.5-pg18` with its own persistent volume, run
`pnpm deploy:db` against it (which is also the honest test that migrations 0000–0064 apply
cleanly on 18 in the real environment), assert `rolsuper` on the migration role, and leave it
idle. Correct the claim in `database-migrations.md` that the pgvector image swap is
volume-compatible — that was true for 16→16, and is false for 16→18. State that the daily
`scripts/db/backup.ts` dump is **not** an upgrade vehicle (`--no-acl`, no globals). Shippable:
production still serving from pg16, with a verified-empty pg18 resource standing by.

### Phase 3 — Full-fidelity restore rehearsal against production data

Take a fresh production backup, restore it into a *third* scratch PG18 database (never the
cutover target), run the §4 pipeline end to end, and diff row counts per table. Point a local app
build at that scratch database and exercise login, search, semantic search, alerts, exports and
the admin surface. Measure the real write-freeze budget from the real data size. Shippable:
nothing in production changed; the cutover is now a rehearsed procedure with a known duration.

### Phase 4 — Production cutover (the only irreversible step)

Announce the window. Pause the VPS cron entries, stop the app resource (all background work is
HTTP-triggered and idempotent, so a stopped app is a full write freeze). Take the pre-cutover
dump. Run the pipeline into the standing pg18 resource. `ANALYZE`, recreate
`builder_embeddings_hnsw_idx`, verify row-count parity, verify all four runtime roles can log in
and that a tenant-scoped read returns rows through RLS. **Acknowledge the point of no return in
writing**, then repoint the five `DATABASE_*_URL` env vars in Coolify, redeploy (which re-runs
`pnpm deploy:db` — idempotent, so it is a no-op plus a role-password re-provision), unpause cron,
unfreeze. Watch `/api/health`, `pg_stat_io`, error rates and semantic-search p95 for one soak
period. Keep the pg16 resource stopped-but-intact for a documented retention window.

### Phase 5 — Feature adoption (only after Phase 4 is observed)

Now PG18-only SQL is legal. Independent, in this order:

1. **`uuidv7()` defaults** on the four append-heavy uuid PKs
   (`schema.ts:167, 411, 673, 892`) via one generated migration, plus the insert benchmark that
   either substantiates or refutes the locality win.
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

Add the version-assertion step to `scripts/deploy/orchestrate.mjs` between "wait for db" and
"create db" (`current_setting('server_version_num')::int`, floor from optional
`DEPLOY_DB_MIN_PG_MAJOR`, default 18, fatal with a runbook pointer). Drop pg16 from the CI
matrix. Update `plans/_meta/app-reality.md` so the next plan does not read a stale version.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| PG18-only SQL merges while production is still on 16 → `drizzle-kit migrate` syntax-errors inside `post_deployment_command`, after the container is already live | Medium (it is a discipline problem, not a technical one) | High | Phases 0–4 contain zero PG18-only syntax; CI runs a pg16 + pg18 matrix for the whole window; Phase 5 is gated on Phase 4 being observed; Phase 6 makes the floor a script |
| Data-only restore silently inserts nothing into tenant tables (`FORCE ROW LEVEL SECURITY`, policies `TO builderhunt_app`, `app.organization_id` unset) | Certain if the restore role is not a superuser | Critical (silent partial data loss) | Restore as the resource superuser (`builderhunt_owner` is `NOBYPASSRLS NOLOGIN` and cannot be used); `rolsuper` asserted in Phase 2, before the window; Phase 0 reproduces the failure deliberately; per-table row-count parity is a gate, not a formality |
| `drizzle.__drizzle_migrations` PK collision aborts the `--single-transaction` restore | Certain without mitigation | Medium (window overrun) | `pg_dump --schema=public` excludes the `drizzle` schema; the target's journal comes from `pnpm deploy:db`; rehearsed in Phase 0 |
| The fresh pg18 cluster is created with a different collation / locale provider than the pg16 source → text `ORDER BY` changes and text unique indexes change their idea of "duplicate" | Low (same image family) but **nothing structurally prevents it**, since the target is created fresh rather than upgraded in place | High (either a restore that fails on a non-duplicate, or silently different sort order in the UI) | Explicit `datcollate`/`datctype`/`datlocprovider`/`daticulocale` parity assertion before the restore, in Phase 0 (local) **and again** in Phase 3 against real production; a mismatch is a full stop, fixed by creating the target database with the source's locale settings and re-running `pnpm deploy:db` |
| Someone treats the daily `backup.ts` dump as the upgrade vehicle (`--no-owner --no-acl`, no globals) | Medium | High | The upgrade uses its own dump invocation; the runbook and `database-migrations.md` both say so explicitly; the daily script is left untouched so its contract does not change |
| FK ordering breaks a data-only restore (alphabetical table order) | Certain without mitigation | Medium | `--disable-triggers` (superuser-only, already secured) + `--single-transaction`; zero user triggers exist, so nothing else is suppressed |
| HNSW index maintained during the bulk load turns minutes into hours | Medium | Medium | Drop `builder_embeddings_hnsw_idx` before the restore, recreate after with raised `maintenance_work_mem`; the `EXPLAIN` regression test proves it came back usable |
| Missing statistics after restore → bad plans on the first live traffic | High without mitigation | Medium | `ANALYZE` is a required step, not optional; this is the one thing the dump/restore path gives up versus `pg_upgrade`, and it costs one command |
| Rollback wanted after production has written to pg18 | Low | High | The window's point of no return is named and acknowledged *before* the repoint; the pg16 resource stays stopped-but-intact for a documented retention window; post-cutover rollback means restoring the pre-cutover dump to pg16 and accepting the loss of post-cutover writes |
| `pgvector/pgvector:0.8.5-pg18` behaves differently from the floating `pg16` tag production runs today | Low | Medium | `../README.md:147` already assumes pgvector 0.8.5 semantics; pinning makes it enforced. Phase 1 re-runs the HNSW `EXPLAIN` test and Phase 3 compares a real semantic-search result set before/after |
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
- **Phase 4** is the irreversible one, and only after the app has written to pg18. Before the
  repoint, rollback is "do nothing, stay on pg16". After it, rollback is: stop the app, restore
  the pre-cutover dump into the still-intact pg16 resource, repoint the five `DATABASE_*_URL`
  vars back, redeploy — and accept the loss of everything written to pg18 after the cutover. That
  asymmetry is why Phase 4 requires the point of no return to be acknowledged in writing.
- **Phases 0–3** change nothing in production and revert by deleting scratch resources.
- **Phase 1** reverts by restoring the pg16 image tags. Note this is the one revert with a local
  cost: developers who already reset onto a PG18 volume must reset again.
