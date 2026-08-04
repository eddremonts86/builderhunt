# Production Deploy Runbook

How a push to `master` becomes a healthy production release, and exactly what must be
configured (in the repo and in Coolify) so a deploy never leaves the app half-broken.

Companion docs: [`database-migrations.md`](./database-migrations.md),
[`database-roles.md`](./database-roles.md),
[`database-restore.md`](./database-restore.md) (recovering from a backup — note that a restore
does **not** bring role passwords with it; step 5 below is what provisions them),
[`public-enrichment-source-register.md`](./public-enrichment-source-register.md).

---

## TL;DR — the deploy flow

```
pnpm deploy:preflight        # local gate — must be green before you push
  ↓  git push (master)
Coolify: docker build (Dockerfile, --frozen-lockfile)
  ↓
Coolify: start container → HEALTHCHECK /api/health passes
  ↓
Coolify: post_deployment_command → `pnpm deploy:db`   ← the orchestrator
  ↓
   wait-for-db → create-db → CREATE EXTENSION vector → drizzle-kit migrate
   → provision role passwords → verify role logins → seed admin
  ↓
Release live ✓
```

The single most important rule: **the migrations create the runtime Postgres roles
without passwords on purpose** (see `drizzle/0002_database_roles.sql`). If nothing
provisions those passwords after `drizzle-kit migrate`, the app cannot authenticate, every
DB-backed page 500s, login breaks, and the workers/scrapers fail. `pnpm deploy:db` is what
provisions them. Never run bare `drizzle-kit migrate` as the deploy command again — run the
orchestrator.

---

## The orchestrator — `pnpm deploy:db`

`scripts/deploy/orchestrate.mjs`. Idempotent, forward-only, fail-loud. Safe to re-run on
every deploy; it never drops, resets, or `push`es — existing data is preserved.

| Step | What it does | Failure behavior |
|------|--------------|------------------|
| 1 wait-for-db | retries `SELECT 1` on `DATABASE_MIGRATION_URL` | fails after `DEPLOY_DB_WAIT_ATTEMPTS` (default 30 × 2s) |
| 2 pg-major floor | reads `current_setting('server_version_num')` and requires `>= DEPLOY_DB_MIN_PG_MAJOR` (default 18) | fatal — points at the runbook cutover section so the operator knows where to look |
| 3 create-db | `scripts/db/create-db.ts` (idempotent `CREATE DATABASE`) | fatal |
| 4 extensions | `CREATE EXTENSION IF NOT EXISTS vector` | **soft** — warns; app keyword-falls-back if pgvector image not set |
| 5 migrate | `drizzle-kit migrate` (creates roles/tables/RLS/grants) | fatal |
| 6 provision roles | `ALTER ROLE builderhunt_* … PASSWORD` from each set `DATABASE_*_URL` | fatal |
| 7 verify logins | connects as each provisioned role, `SELECT 1` | fatal (catches password/env mismatch before users do) |
| 8 seed admin | `scripts/db/seed-admin.ts` (idempotent upsert) | **soft** — warns; deploy stays healthy |
| 9 sync content | `scripts/db/sync-platform-content.ts` — upserts `content/changelog/*.md` and `content/roadmap/*.md` into the `changelog` / `roadmap_items` tables | **soft** — warns; the public pages keep the rows they already had |

Flags: `--dry-run` (print the plan, no mutations, no connections), `--skip-seed`,
`--skip-content`. Secrets (role passwords) are never printed.

Step 8 exists because the public `/changelog` and `/roadmap` read the database, and the
database is not in git — an entry typed into the admin panel lived in exactly one
environment and did not survive a restore onto a fresh volume. The files under `content/`
are the committed copy and this step is what makes a deploy publish them. It connects as
`DATABASE_PLATFORM_URL` when set (the role migration `0012` grants write access on those
two tables) and falls back to `DATABASE_URL`.

It only ever owns the rows its files define — ids are `content-changelog-<slug>` /
`content-roadmap-<slug>` — so entries created in the admin UI are never touched, including
by the opt-in `--prune`. The reverse direction is `pnpm content:export`, which writes the
current rows back out as files so something drafted in the admin UI can be committed.

**This step needs `content/` inside the runtime image.** The Dockerfile copies it
(`COPY content ./content`); without that line this step is a no-op and `/blog` is
permanently empty in production while looking healthy locally.

Preview what a deploy would do, safely:

```sh
pnpm deploy:db:dry
```

---

## One-time Coolify setup

### 1. Postgres database resource

- Image **must** be a `pgvector/pgvector:*` image — semantic search needs the `vector` extension,
  and on a plain `postgres:*` image `drizzle/0013`'s `CREATE EXTENSION vector` rolls back the entire
  migration chain. See `database-migrations.md` → pgvector.
- **Production currently runs `pgvector/pgvector:pg16`** (verified 2026-08-01 against the Coolify
  `builderhunt-db` resource). Local dev and CI have already moved to `pgvector/pgvector:0.8.5-pg18`.
- ⚠️ **A 16 → 18 change is NOT a swap of this image.** Postgres major versions have incompatible
  on-disk formats, so the existing data volume is unreadable by 18 and there is no `pg_upgrade` path
  across the Docker volume boundary. Changing this line alone would start an empty database. The
  move requires the dump/restore cutover in "PostgreSQL 16 → 18 cutover" below, against a **second**
  resource. The earlier wording here said the volume was compatible "since the Postgres major is
  unchanged" — true of a 16→16 image swap, dangerously false for 16→18.
- **Persistent volume is mandatory.** This is what makes the DB durable across deploys — it
  is the answer to "we don't want to start from zero every deploy." Confirm the resource has
  a named volume mounted at the Postgres data dir and that redeploying the app does **not**
  recreate the DB resource.
- The resource's superuser/owner connection becomes `DATABASE_MIGRATION_URL`.

### 2. Application resource

- Build pack: **Dockerfile**, target: `runtime`.
- `post_deployment_command`: `pnpm deploy:db`
- `post_deployment_command_container`: the app container (default).
- Health check path: `/api/health` (the Dockerfile also defines a `HEALTHCHECK`).

### 3. Embeddings resource (semantic search)

- Separate Coolify docker-compose resource from `docker-compose.yml`'s `embeddings` service
  (`ollama/ollama:latest`, pulls `nomic-embed-text`), with a **persistent volume** so the
  model is not re-downloaded on every redeploy. Point the app's `AI_EMBEDDING_URL` at its
  internal hostname. Full contract in `database-migrations.md` → "Self-hosted embeddings".

---

## Required environment variables (Coolify app env — never committed)

Copy `.env.production.example` as the source of truth. Critical ones:

| Variable | Role / purpose | Notes |
|----------|----------------|-------|
| `NODE_ENV` | `production` | |
| `APP_URL` / `VITE_APP_URL` | public URL | must match the fqdn |
| `BETTER_AUTH_SECRET` | auth signing | `openssl rand -hex 32`; must be strong (validated) |
| `DATABASE_MIGRATION_URL` | privileged migration identity | superuser/owner; used by the orchestrator for steps 1–6 |
| `DATABASE_URL` | `builderhunt_app` | app runtime; **must not** be `postgres`/owner (validated) |
| `DATABASE_AUTH_URL` | `builderhunt_auth` | optional — falls back to `DATABASE_URL` |
| `DATABASE_WORKER_URL` | `builderhunt_worker` | optional — **the scrapers/workers connect with this** |
| `DATABASE_PLATFORM_URL` | `builderhunt_platform` | optional — falls back to `DATABASE_URL` |
| `DATABASE_CAPABILITY_URL` | `builderhunt_capability` | optional — accountless capability holders (scheduling links); provisioned by the orchestrator (`scripts/deploy/orchestrate.mjs`) |
| `DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD` | admin seed | required in prod or step 7 warns and skips |
| `AI_EMBEDDING_URL` | embeddings resource | e.g. `http://embeddings:11434/v1/embeddings` |
| `GITHUB_TOKEN` | GitHub enrichment scraper | higher rate limit; enrichment is the only enabled connector |
| `ENRICHMENT_ENABLED` / `ENRICHMENT_ALLOWED_CONNECTORS` | scraper kill switch | keep `false` until the source register is signed off |

Every password embedded in a `DATABASE_*_URL` is what the orchestrator syncs onto the DB role
in step 5. To rotate a role password: change it in the Coolify env var and redeploy — step 5
re-`ALTER ROLE`s it and step 6 verifies it.

---

## Workers / scrapers

Background work uses the idempotent HTTP-cron pattern (no queue). Each endpoint requires a
platform-admin principal (`requirePlatformAdminPrincipal`).

**They do not all connect as the same role.** Most go through `workerDb`
(`DATABASE_WORKER_URL` → `builderhunt_worker`), but the ones that only touch global-public tables
use `publicDb`, which is `runtimeDb` — i.e. `DATABASE_URL` → `builderhunt_app`
(`src/shared/lib/db/client.ts`). `src/lib/discovery/worker.ts` is one of those. So a deployment that
sets `DATABASE_WORKER_URL` correctly but breaks `DATABASE_URL` still breaks background work, and
granting a table to `builderhunt_worker` alone does not necessarily make a worker able to read it.
Check the specific worker's imports before reasoning about its grants.

| Endpoint | Purpose | Key env |
|----------|---------|---------|
| `POST /api/admin/discovery/run-worker` | proactive builder discovery | `DISCOVERY_*` |
| `POST /api/admin/enrichment/run-worker` | public-profile enrichment (GitHub) | `ENRICHMENT_*`, `GITHUB_TOKEN` |
| `POST /api/admin/embeddings/run-worker` | semantic-search embeddings | `AI_EMBEDDING_URL` |
| `POST /api/admin/alerts/run-worker` | saved-search alert digests | `RESEND_API_KEY` |
| `POST /api/admin/billing/run-worker` | Stripe webhook event replay | `STRIPE_*` |
| `POST /api/admin/legal/run-worker` | legal/retention sweeps | — |
| `POST /api/admin/sprints/run-worker` | sourcing sprints | — |
| `POST /api/admin/status/snapshot` | uptime-history snapshot for `/status`'s 30-day figure — run every 5 minutes, matching `computeUptime`'s default interval (`src/shared/lib/status.ts`); prunes rows older than 90 days each run | — |
| `POST /api/admin/devpost/run-worker` | headless-browser (Playwright/Chromium) scrape of Devpost hackathon projects/team profiles into `devpost_profiles` — Devpost has no API, so this is not a live connector; no-ops unless `DEVPOST_ENABLED=true` | `DEVPOST_*` |

`POST /api/admin/status/snapshot` also accepts `CRON_SECRET` via `Authorization: Bearer <token>` or
`x-cron-secret: <token>` as an unattended alternative to a platform-admin session (same
`tryCronPrincipal` fallback every other `run-worker` endpoint above already supports) — the
intended way an actual VPS crontab authenticates, e.g.:

```
*/5 * * * * curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://builderhunt.dev/api/admin/status/snapshot
```

For a scraper to actually produce data in prod it needs: (a) `builderhunt_worker` able to log
in (orchestrator step 5/6), (b) its feature env set (`ENRICHMENT_ENABLED=true`,
`ENRICHMENT_ALLOWED_CONNECTORS=github`, `GITHUB_TOKEN`), (c) for embeddings, the pgvector
extension + embeddings resource reachable. A cron (VPS crontab or Coolify scheduled task)
must POST each endpoint on its cadence, authenticated as a platform admin.

### Devpost worker (first headless-browser worker — different risk profile)

`DEVPOST_ENABLED` defaults to `false` and must be flipped deliberately in each environment —
unlike every other worker above, this one launches a real Chromium instance against a live
third-party site with no published API and no rate-limit contract; every request risks an
IP ban of whichever host runs it. Before setting it `true` in production:

- Confirm the runtime image actually has Chromium (`docker exec <container> npx playwright
  --version` and a successful `chromium.launch()` — the Dockerfile's `playwright install
  --with-deps chromium` step must have run during the image build).
- Suggested cadence is hourly, not every 5 minutes, given the request cost per run:
  ```
  0 * * * * curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://builderhunt.dev/api/admin/devpost/run-worker
  ```
- Rollback is the same instant kill switch as every other feature flag in this codebase: set
  `DEVPOST_ENABLED=false` and no further scrape requests happen (existing `devpost_profiles`
  rows are left as-is — they're just data, not something that needs cleanup).

---

## Rollback

1. In Coolify, redeploy the previous successful image (or revert the commit and push).
2. Migrations are forward-only — **do not** try to "roll back" the schema by editing history.
   A shipped migration is immutable (`migration-hashes.json` + `test:migration-integrity`
   enforce this). Recover forward with a new migration.
3. The DB volume persists, so a code rollback does not lose data.

---

## Troubleshooting — the usual breaks

| Symptom | Cause | Fix |
|---------|-------|-----|
| Every page 500s after deploy; health is OK | role password never provisioned | run `pnpm deploy:db` (make it the `post_deployment_command`) |
| After a restore: `role "builderhunt_app" does not exist`, or pages load but every list is empty | the restore skipped the cluster-role step, so the dump's `CREATE POLICY` statements all failed — RLS is enabled with zero policies | **do not** disable RLS or grant BYPASSRLS. Drop the target DB and restore again with `pnpm db:restore`, which creates roles first and verifies. See [`database-restore.md`](./database-restore.md) |
| Orchestrator step 6 fails "role X could not authenticate" | `DATABASE_*_URL` password ≠ DB role | fix the env var, redeploy (step 5 re-syncs it) |
| Docker build fails on `pnpm install` | lockfile drift | run `pnpm deploy:preflight` locally; commit the updated `pnpm-lock.yaml` |
| Container runs but native module errors | host `node_modules` leaked into image | ensure `.dockerignore` is present (it excludes `node_modules`) |
| `migration-hashes.json` mismatch in CI/preflight | new migration added without regenerating manifest | `node scripts/db/verify-migration-integrity.mjs --write`, bump the count in `migration-integrity.test.ts`, commit |
| Semantic search returns 503 / keyword fallback | pgvector extension missing | switch the DB resource to `pgvector/pgvector:pg16`, re-run `pnpm deploy:db` |
| Scrapers do nothing | `ENRICHMENT_ENABLED=false` or worker role can't log in | set enrichment env; confirm orchestrator step 6 green |

## PG18 observability — `pg_stat_io` and `pg_aios`

PG18 ships two system views that did not exist on PG16 and that the
DB work in `plans/phase-1/03-postgres-18-upgrade` reads and writes
through:

- `pg_stat_io` — per-backend, per-context, per-operation I/O
  counters (`reads`, `read_bytes`, `writes`, `write_bytes`,
  `extends`, `hits`, `evictions`, `fsyncs`, …). Snapshot with
  `select * from pg_stat_io` before and after a backfill, an
  index rebuild, or any operation you want to characterise.
- `pg_aios` — currently in-flight asynchronous I/O. Always
  returns zero or one row: zero when the cluster is idle, one
  while a backend is inside `aio_write`/`aio_read`. Cheap to
  poll.

Both are read-only and require no grants beyond `pg_read_all_stats`
(or the `pg_stat_io` / `pg_aios` views are already world-readable on
the runtime role in this repo).

**`log_lock_failures=on`** is set on the local `docker-compose.yml`
container command and should be set the same way on the Coolify
Postgres resource. With it on, a migration that loses a lock race
logs a `WARNING: … lock timeout` line with the table and lock mode,
instead of timing out silently. The setting is a session-startup
GUC, so the orchestrator's connection picks it up; the dev container
picks it up from the compose `command:` array.

**Never set `io_method=io_uring` under Docker.** The default
seccomp profile blocks the `io_uring_setup` syscall and a container
that tries to set it dies immediately. The default `io_method=worker`
is correct for Docker; the `io_uring` value is a Linux-host only
optimisation.

## PostgreSQL 16 → 18 cutover

> **Status: not executed.** Production runs `pgvector/pgvector:pg16` (verified 2026-08-01 against the
> Coolify `builderhunt-db` resource). Until this section has been executed and observed, the
> "One-time Coolify setup" image line above stays `pg16` — do not pre-emptively change it.
>
> **Why this is on the critical path.** Migrations `0102_uuidv7_pk`, `0107_organization_activity`
> and `0122_canonical_human_identity` call `uuidv7()`, a PG18 built-in. They exist only on the
> unmerged `phase-1-execution` branch, so production has never seen them and is not broken. But that
> branch cannot ship until this cutover lands, and it fails in two different places depending on how
> the migrations are applied:
>
> - **`pnpm deploy:db` stops cleanly at orchestrator step 2**, before touching any migration:
>   `PostgreSQL 16.x detected …, but this build requires >= 18.x` (`assertPostgresMajor`,
>   `scripts/deploy/orchestrate.mjs`). That floor is fatal by design and its message points back at
>   this section, so a production deploy cannot half-apply anything.
> - **CI and any bare `drizzle-kit migrate` fail later and messier**, at `0102` itself:
>   `function uuidv7() does not exist`. That is what the red pg16 `quality` job is reporting, and it
>   is correct — not a stale config.
>
> See the ordering-violation note at the top of
> `plans/phase-1/03-postgres-18-upgrade/tasks.md` for how these migrations landed before the cutover
> that licenses them.

### 0. Non-negotiables

- **The target image must be `pgvector/pgvector:0.8.5-pg18`** — a `pgvector/pgvector:*` image, pinned,
  not the floating `pg18` tag. On a plain `postgres:18*` image, `drizzle/0013`'s
  `CREATE EXTENSION vector` fails inside `drizzle-kit migrate` and **rolls back the entire migration
  chain**. This has already taken production down once. Orchestrator step 3 only *warns*, so the
  mistake surfaces one step later, after everything has been undone.
- **A 16 → 18 move is not an image swap.** The major versions have incompatible on-disk formats and
  there is no `pg_upgrade` path across the Docker volume boundary. This procedure creates a
  **second** resource and moves the data. Editing the image on the existing resource would start an
  empty database.
- **Run every `pg_dump`/`pg_restore` from inside a PG18 container.** Client binaries must match the
  newer server; that is the supported direction. A pg16 client against the pg18 server aborts:
  ```
  pg_dump: error: aborting because of server version mismatch
  pg_dump: detail: server version: 18.4 (Debian 18.4-1.pgdg12+1); pg_dump version: 16.14 (Homebrew)
  ```
- **The daily backup is not the vehicle.** `scripts/db/backup.ts` dumps `--no-owner --no-acl` with no
  `pg_dumpall --globals-only`; roles are cluster-global and every `GRANT` is stripped. See
  [`database-migrations.md`](./database-migrations.md) → "The daily backup is not an upgrade vehicle".

### 1. Create and provision the standing PG18 resource

1. In Coolify, create a **new** Postgres resource on `pgvector/pgvector:0.8.5-pg18` with its own
   **named persistent volume**. Do not touch `builderhunt-db`.
2. Redeploy the app once and confirm the new resource is *not* recreated — that proves the volume is
   durable across deploys.
3. Point all six `DATABASE_*_URL` values at it (see §2 below) and run `pnpm deploy:db`.

Verify, on the migration connection:

```sh
psql "$PG18_URL" -tAc "show server_version"                                   # 18.x
psql "$PG18_URL" -tAc "select extversion from pg_extension where extname='vector'"   # 0.8.5
psql "$PG18_URL" -tAc "select rolsuper from pg_roles where rolname = current_user"   # t
psql "$PG18_URL" -tAc "select count(*) from drizzle.__drizzle_migrations"      # equals: ls drizzle/*.sql | wc -l
```

All **8** orchestrator steps must pass with **no warning at step 3**. `rolsuper = t` is a hard
precondition, not a nicety: 64 tables carry `FORCE ROW LEVEL SECURITY` and all seven `builderhunt_*`
roles are `NOSUPERUSER … NOBYPASSRLS`, so no application role can perform the restore in §3.

### 2. The six variables to repoint

These are the `DATABASE_*` variables actually set on the Coolify app (enumerated 2026-08-01, not
copied from a template). All six move together — a half-repointed app reads one database and writes
another.

| Variable | Role |
| --- | --- |
| `DATABASE_URL` | `builderhunt_app` |
| `DATABASE_MIGRATION_URL` | privileged migration identity (superuser) |
| `DATABASE_AUTH_URL` | `builderhunt_auth` |
| `DATABASE_WORKER_URL` | `builderhunt_worker` |
| `DATABASE_PLATFORM_URL` | `builderhunt_platform` |
| `DATABASE_CAPABILITY_URL` | `builderhunt_capability` |

Also repoint, or the new database has no backups at all:

- Coolify's **03:00 scheduled backup** — retarget it at the new resource.
- The **03:30 `scripts/ops/builderhunt-backup-sync.sh`** roles capture (`pg_dumpall --roles-only
  --no-role-passwords`).

### 2b. The MVP path — skip §3 entirely while there is nothing to preserve

**This is the shorter procedure, and today it is the applicable one.** Added 2026-08-04.

Everything in §3 through §7 exists to move rows without losing or corrupting them: dump, restore,
row-count parity, a write freeze measured against a rehearsed budget, a named point of no return, a
rollback. All of it is insurance on data. This project has **no real users**, and the standing
maintainer instruction is that wiping the production database is acceptable until phase-5 ships. Buying
insurance on something you have decided is expendable is not caution, it is ceremony.

So while that holds, the cutover is §1 plus §2 plus a redeploy:

1. **§1 unchanged** — create the second resource on `pgvector/pgvector:0.8.5-pg18` with a named volume
   and run `pnpm deploy:db` against it. This applies every migration `0000`→head to an empty database,
   which *is* the whole cutover in this mode.
2. **Verify roles, GRANTs and RLS on the target as the real roles** — see the checklist below. Not
   optional, and not covered by anything in §1.
3. **§2 unchanged** — repoint all six `DATABASE_*_URL` values, plus Coolify's 03:00 backup and the
   03:30 roles capture.
4. **Redeploy the app.** No freeze: there is nothing whose loss would matter, and every background job
   is HTTP-triggered and idempotent.
5. **Leave the pg16 resource running and un-repointed** for at least one backup cycle. It costs nothing
   and it is the only undo.

What is **not** skippable, because none of it is about preserving data:

- **The `pgvector/pgvector:0.8.5-pg18` image.** On a plain `postgres:18*`, `drizzle/0013`'s
  `CREATE EXTENSION vector` fails inside `drizzle-kit migrate` and rolls back the entire chain. The
  visible symptom is that the organization tables never exist and login answers 500. This has already
  taken production down once on pg16. Orchestrator step 3 only *warns*, so the mistake surfaces a step
  later, after everything has been undone.
- **`PGDATA=/var/lib/postgresql/data/pgdata` on the resource — and this one is not optional either.**
  Found the hard way on 2026-08-04, provisioning the real thing: **a Coolify Postgres 18 resource does not
  start at all without it.** Coolify writes
  `/data/coolify/databases/<uuid>/docker-compose.yml` with the volume pinned to
  `/var/lib/postgresql/data`, which is the pre-18 convention. Postgres 18+ images expect a single mount at
  `/var/lib/postgresql` with data in a major-version subdirectory (so `pg_upgrade --link` never crosses a
  mount boundary), and on finding a mount at the old path they **refuse to boot** rather than guess:

  ```
  Error: in 18+, these Docker images are configured to store database data in a
         format which is compatible with "pg_ctlcluster" …
         Counter to that, there appears to be PostgreSQL data in:
           /var/lib/postgresql/data (unused mount/volume)
  ```

  The container crash-loops (`Restarting (1)`). Setting `PGDATA` to a subdirectory of the mount Coolify
  already made resolves it: verified `18.4`, `vector 0.8.5`, `uuidv7()` returning true.

  **And `PGDATA` is doing a second job that is easy to miss: it is what keeps the data durable.** The pg18
  image also declares `VOLUME /var/lib/postgresql`, so Docker attaches an *anonymous* volume there — and
  that volume gets a new identity on every recreation (observed: `416a531f…` → `de9b0c41…` across one
  redeploy). Data written to the image's default location would therefore be discarded on each deploy,
  silently. `PGDATA` puts it in the named `postgres-data-<uuid>` volume instead. Proven rather than
  reasoned: wrote a marker row, forced a Coolify deploy, confirmed the container ID changed
  (`fffbf18941bd` → `c5b737533b6b`) and the row was still there.

  Editing the generated compose by hand is not a fix — Coolify rewrites that file on every deploy. The
  API exposes no volume field for a database resource, only `custom_docker_run_options`, and Docker cannot
  retarget an existing mount anyway.

  **The cost, stated so nobody is surprised later:** this keeps the pre-18 layout, so the *next* major
  upgrade meets the same wall and needs the same second-resource dance rather than `pg_upgrade --link`.
  That is no worse than the 16 → 18 move being performed here, and the alternative is patching Coolify.
- **Migrations applying from zero.** In this mode a fresh install is the only path, so it stops being
  one scenario among several and becomes the entire cutover. `pnpm ci:local` already proves it on every
  run — `migrations-local` reports `firstRun: ok, secondRun: ok` — but confirm the count on the target:
  `select count(*) from drizzle.__drizzle_migrations` must equal `ls drizzle/*.sql | wc -l`.
- **Role and policy verification on the target.** GRANTs, RLS policies and every SECURITY DEFINER
  function live *only* in hand-written migrations, and a superuser connection cannot see whether they
  took — it bypasses all of them. This is the class of defect that has actually bitten this project: an
  operator grant answering 42501 for its own role passed every unit test, because those connect as the
  migration superuser.

  **`pnpm test:rls:local` and `pnpm test:api-isolation:local` cannot be pointed at this database, and
  should not be.** Both refuse to run unless the database name matches
  `builderhunt_security_test_*` — checked, not assumed:

  ```
  RLS verifier refuses to run outside a named builderhunt_security_test database
  ```

  That guard is correct. They seed fixture tenants and delete rows; aiming them at a production target
  would be the accident the guard exists to prevent. They are the *pre-cutover* proof, and `pnpm
  ci:local` runs both against a database migrated from the same `0000`→head chain the target gets — so
  on a freshly-migrated target, a green `ci:local` on the shipping commit already establishes that the
  policies and grants this chain creates are correct.

  What to check on the target itself is that the chain actually took, which is §4's queries — run them
  against the new database with no source to compare against:

  ```sh
  # Every forced table must have at least one policy. MUST return zero rows.
  psql "$PG18_URL" -tAc "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relrowsecurity and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname)"

  # Policy count. Compare against the same query on a database ci:local just built from the same commit.
  psql "$PG18_URL" -tAc "select count(*) from pg_policies where schemaname='public'"

  # All seven roles exist and none can bypass RLS.
  psql "$PG18_URL" -tAc "select rolname, rolbypassrls, rolsuper from pg_roles where rolname like 'builderhunt%' order by rolname"
  ```

  The first query is the one that would have caught the 2026-07-26 defect, where 192 policies were
  silently not created and 54 tables were left forced-with-no-policy while row and table counts both
  looked perfect.
- **Repointing the backups.** A new resource with no backup schedule is a worse position than the one
  you started from, data or no data.

**Do not use this path once there are real customer rows.** The moment that changes, §3–§7 stop being
ceremony and become the procedure — and the rehearsal in §3 has already been executed once
(2026-08-01), so it is ready rather than theoretical. The plan note at
`plans/phase-1/03-postgres-18-upgrade/tasks.md` ("most of Phases 3 and 4 is ceremony for data this
project does not have") is the same decision recorded from the plan's side.

### 3. The pipeline

> Applies when there is data worth moving. See §2b first — while production holds no real users, this
> section and everything after it is insurance on something the maintainer has declared expendable.

Reproduced end to end on 2026-08-01 against two freshly-provisioned PG18 databases: restore exit 0,
row-count parity identical, zero forced-tables-without-policy. Every flag has a reason.

```sh
# (a) Drop the HNSW index on the TARGET. Rebuilding it after the load is far cheaper than
#     maintaining it row by row during the COPY.
psql "$TGT" -c 'DROP INDEX IF EXISTS builder_embeddings_hnsw_idx'

# (b) Migrations seed application rows, so a freshly-provisioned target is NOT empty. Truncate
#     exactly what the migrations put there, or step (d) collides. Derived, not hardcoded — the set
#     grows with every seeding migration.
SEEDED=$(psql "$TGT" -tAc "select string_agg(format('%I', relname), ', ') from pg_stat_user_tables where n_live_tup > 0 and schemaname = 'public'")
echo "truncating migration-seeded tables: $SEEDED"     # 2026-08-01: auth_users, public_surface_indexing
psql "$TGT" -c "TRUNCATE $SEEDED CASCADE"

# (c) --data-only because the target already has the schema from migrations.
#     --schema=public to EXCLUDE drizzle.__drizzle_migrations — see claim 2 below.
pg_dump -Fc --data-only --schema=public "$SRC" -f /tmp/data.dump

# (d) --disable-triggers because privacy_consents has circular foreign keys and pg_dump says so
#     itself (see claim 4). --single-transaction so a partial load cannot survive.
pg_restore --data-only --disable-triggers --single-transaction -d "$TGT" /tmp/data.dump

# (e) Recreate the index. The name and operator class must match
#     drizzle/0013_polite_night_thrasher.sql exactly, or the EXPLAIN plan-shape regression test in
#     tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts stops matching.
psql "$TGT" -c "SET maintenance_work_mem='1GB'; CREATE INDEX builder_embeddings_hnsw_idx ON builder_embeddings USING hnsw (embedding vector_cosine_ops)"

# (f) ANALYZE — the planner has no statistics on freshly-loaded tables.
psql "$TGT" -c 'ANALYZE'
```

### 4. Verify before repointing anything

```sh
# Row-count parity, per table.
diff <(node scripts/db/pg18/row-counts.mjs "$SRC") <(node scripts/db/pg18/row-counts.mjs "$TGT")

# RLS integrity: every forced table must have at least one policy. MUST return zero rows.
psql "$TGT" -tAc "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relrowsecurity and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname)"

# Policy count parity between source and target.
psql "$SRC" -tAc "select count(*) from pg_policies where schemaname='public'"
psql "$TGT" -tAc "select count(*) from pg_policies where schemaname='public'"

# Locale parity. MUST be identical — a different collation changes text ORDER BY and the equality
# semantics behind every unique index on a text column.
diff <(node scripts/db/pg18/locale-check.mjs "$SRC") <(node scripts/db/pg18/locale-check.mjs "$TGT")
```

The RLS query is the one that would have caught the 2026-07-26 defect, where 192 policies were
silently not created and 54 tables were left forced-with-no-policy while row counts and table counts
both looked perfect. `--data-only` is not supposed to hit it, which is exactly why it is asserted.

### 5. Recorded failure modes

Reproduced against live PG18 clusters on 2026-08-01. These are the literal outputs; if you see one of
them, this is what it means.

**Claim 1 — restoring as an application role silently lands zero rows.** `pg_restore` as
`builderhunt_app` instead of the superuser:

```
pg_restore: error: could not execute query: ERROR:  query would be affected by row-level security policy for table "saved_queries"
Command was: COPY public.saved_queries (id, user_id, name, keywords, sources, language, country, created_at, organization_id, visibility, updated_at) FROM stdin;
```

`select count(*) from saved_queries` on the target afterwards: **0**. This is why §1's `rolsuper = t`
check is a hard stop.

**Claim 2 — omitting `--schema=public` collides on the migration journal:**

```
pg_restore: error: COPY failed for table "__drizzle_migrations": ERROR:  duplicate key value violates unique constraint "__drizzle_migrations_pkey"
DETAIL:  Key (id)=(1) already exists.
CONTEXT:  COPY __drizzle_migrations, line 1
```

**Claim 3 — locale parity holds between these two images.** `pgvector/pgvector:pg16` and
`pgvector/pgvector:0.8.5-pg18` produced identical output, `datcollversion` included:

```
datcollate	en_US.utf8
datctype	en_US.utf8
datlocprovider	c
datlocale_or_daticulocale	
datcollversion	2.36
server_encoding	UTF8
```

Because `datcollversion` matches, there is **no** `REFRESH COLLATION VERSION` decision to make. Re-run
the diff anyway at cutover time — the images float unless pinned, and this is cheap.

**Claim 4 — skipping `--disable-triggers` fails on circular foreign keys.** `pg_dump` warns about it
during the dump itself:

```
pg_dump: warning: there are circular foreign-key constraints on this table:
pg_dump: detail: privacy_consents
pg_dump: hint: You might not be able to restore the dump without using --disable-triggers or temporarily dropping the constraints.
```

**Claim 5 — a freshly-provisioned target is not empty.** Skipping step (b):

```
pg_restore: error: COPY failed for table "auth_users": ERROR:  duplicate key value violates unique constraint "auth_users_pkey"
```

`auth_users` holds the `system-deleted-user` sentinel from `drizzle/0026_deleted_user_sentinel.sql`,
and `public_surface_indexing` holds three seeded rows. `--schema=public` excludes the drizzle journal
but not application rows that migrations themselves INSERT.

### 6. Point of no return

Repointing the six variables and redeploying is the irreversible step. Before it:

- Freeze writes by **stopping the app resource**. All background work is HTTP-triggered and
  idempotent, and every `run-worker` endpoint is reached over HTTP with `x-cron-secret`, so stopping
  the app is a complete freeze. Pause the scheduled jobs listed in [`../runbook.md`](../runbook.md) §3.
- Stripe webhooks will retry — `billing_webhook_events` carries `status` + `next_attempt_at` retry
  state — and nothing is billed today, since the Stripe plan is still `pending`.
- Decide explicitly what happens if the window overlaps the 03:00 backup or the 03:30 roles sync.
- Acknowledge in writing that §4 passed, naming the row-count and policy-count figures.

### 7. Rollback

Before the repoint: **drop the PG18 resource and re-run `pnpm deploy:db` on it.** The pg16 resource
was never touched, so this costs nothing but time.

After the repoint: point the six variables back at the still-running pg16 resource and redeploy.
Writes that landed on PG18 in between are lost, which is why the freeze in §6 exists.

If a rollback ever needs a *restore* rather than a repoint, it goes through **`pnpm db:restore`**
(roles-first — it applies `scripts/db/roles.sql` before the data and then asserts RLS integrity),
never a bare `pg_restore`. See [`database-restore.md`](./database-restore.md).

**Retire the pg16 resource on a schedule, not immediately.** Keep it running and un-repointed for at
least one full backup cycle after the cutover is observed.
