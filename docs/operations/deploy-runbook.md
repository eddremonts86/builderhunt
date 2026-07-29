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

- Image **must** be `pgvector/pgvector:pg16` (semantic search needs the `vector` extension;
  same Postgres major as plain `postgres:16`, so the data volume is compatible — see
  `database-migrations.md` → pgvector).
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
