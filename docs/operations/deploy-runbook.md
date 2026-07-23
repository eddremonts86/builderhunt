# Production Deploy Runbook

How a push to `master` becomes a healthy production release, and exactly what must be
configured (in the repo and in Coolify) so a deploy never leaves the app half-broken.

Companion docs: [`database-migrations.md`](./database-migrations.md),
[`database-roles.md`](./database-roles.md),
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
| 2 create-db | `scripts/db/create-db.ts` (idempotent `CREATE DATABASE`) | fatal |
| 3 extensions | `CREATE EXTENSION IF NOT EXISTS vector` | **soft** — warns; app keyword-falls-back if pgvector image not set |
| 4 migrate | `drizzle-kit migrate` (creates roles/tables/RLS/grants) | fatal |
| 5 provision roles | `ALTER ROLE builderhunt_* … PASSWORD` from each set `DATABASE_*_URL` | fatal |
| 6 verify logins | connects as each provisioned role, `SELECT 1` | fatal (catches password/env mismatch before users do) |
| 7 seed admin | `scripts/db/seed-admin.ts` (idempotent upsert) | **soft** — warns; deploy stays healthy |

Flags: `--dry-run` (print the plan, no mutations, no connections), `--skip-seed`.
Secrets (role passwords) are never printed.

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
platform-admin principal (`requirePlatformAdminPrincipal`) and connects to the DB as
`builderhunt_worker` (`DATABASE_WORKER_URL`) — so the orchestrator's role-password step is
what keeps them working.

| Endpoint | Purpose | Key env |
|----------|---------|---------|
| `POST /api/admin/discovery/run-worker` | proactive builder discovery | `DISCOVERY_*` |
| `POST /api/admin/enrichment/run-worker` | public-profile enrichment (GitHub) | `ENRICHMENT_*`, `GITHUB_TOKEN` |
| `POST /api/admin/embeddings/run-worker` | semantic-search embeddings | `AI_EMBEDDING_URL` |
| `POST /api/admin/alerts/run-worker` | saved-search alert digests | `RESEND_API_KEY` |
| `POST /api/admin/billing/run-worker` | Stripe webhook event replay | `STRIPE_*` |
| `POST /api/admin/legal/run-worker` | legal/retention sweeps | — |
| `POST /api/admin/sprints/run-worker` | sourcing sprints | — |

For a scraper to actually produce data in prod it needs: (a) `builderhunt_worker` able to log
in (orchestrator step 5/6), (b) its feature env set (`ENRICHMENT_ENABLED=true`,
`ENRICHMENT_ALLOWED_CONNECTORS=github`, `GITHUB_TOKEN`), (c) for embeddings, the pgvector
extension + embeddings resource reachable. A cron (VPS crontab or Coolify scheduled task)
must POST each endpoint on its cadence, authenticated as a platform admin.

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
| Orchestrator step 6 fails "role X could not authenticate" | `DATABASE_*_URL` password ≠ DB role | fix the env var, redeploy (step 5 re-syncs it) |
| Docker build fails on `pnpm install` | lockfile drift | run `pnpm deploy:preflight` locally; commit the updated `pnpm-lock.yaml` |
| Container runs but native module errors | host `node_modules` leaked into image | ensure `.dockerignore` is present (it excludes `node_modules`) |
| `migration-hashes.json` mismatch in CI/preflight | new migration added without regenerating manifest | `node scripts/db/verify-migration-integrity.mjs --write`, bump the count in `migration-integrity.test.ts`, commit |
| Semantic search returns 503 / keyword fallback | pgvector extension missing | switch the DB resource to `pgvector/pgvector:pg16`, re-run `pnpm deploy:db` |
| Scrapers do nothing | `ENRICHMENT_ENABLED=false` or worker role can't log in | set enrichment env; confirm orchestrator step 6 green |
