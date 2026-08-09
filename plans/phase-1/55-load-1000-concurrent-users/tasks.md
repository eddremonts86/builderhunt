# Load capacity — Tasks

> **Status**: `pending`
> **Spec**: [`spec.md`](./spec.md)
> **Plan**: [`plan.md`](./plan.md)
> **Rule**: a task is complete only when its runtime verification passes AND the baseline
> load test numbers do not regress. **No config change ships without a before-and-after
> load test comparison.**

## Phase 0 — Baseline load test (no production changes)

- [ ] **Author `scripts/audit/load-test.ts`**
  - Files: `scripts/audit/load-test.ts`, `scripts/audit/load-test.sh`
  - Do: 1000 concurrent sessions, mixed workload (5% search, 60% dashboard, 20% alerts,
    10% recommendations, 5% sprint). Records p50/p95/p99 latency, error rate, peak
    `pg_stat_activity` count, statement_timeout kills, and "sorry, too many clients"
    occurrences. Writes JSON to `docs/operations/load-baseline-<date>.json` and a
    short markdown report to `docs/operations/load-baseline-<date>.md`.
  - Verify: the script runs end-to-end; output JSON is valid; report has every field
    from the spec's Goal table.

- [ ] **Run the baseline against the current dev stack**
  - Files: `docs/operations/load-baseline-<date>.json`,
    `docs/operations/load-baseline-<date>.md`
  - Do: `pnpm tsx --env-file-if-exists=.env scripts/audit/load-test.ts --users=1000
    --duration=10m --output=docs/operations/load-baseline-<date>.json`. Capture all
    metrics. Document the failure modes observed (statement-timeout kills, "sorry"
    errors, pool-acquire waits > 50ms).
  - Verify: the report's numbers become the comparison point for every later phase. Any
    later phase whose numbers regress is a rollback.

- [ ] **Add `pnpm load-test:smoke` for CI**
  - Files: `package.json`
  - Do: Add a 1-minute smoke variant: `pnpm tsx --env-file-if-exists=.env
    scripts/audit/load-test.ts --users=50 --duration=1m --output=/tmp/load-smoke.json`.
    Wire into `ci:local` and `.github/workflows/quality.yml`.
  - Verify: `pnpm ci:local` runs the smoke and exits 0; CI fails on p95 > 1.5s.

## Phase 1 — `statement_timeout` + `idle_in_transaction_session_timeout`

- [ ] **Add env vars and defaults**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: Add `DATABASE_STATEMENT_TIMEOUT_MS` (default `5000`) and
    `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` (default `10000`) as optional env vars.
    Sensible defaults; misconfiguration logs WARN.
  - Verify: `pnpm type-check` clean; `.env.example` has the new vars with comments.

- [ ] **Add `onconnect` hook to `poolOptions()`**
  - Files: `src/shared/lib/db/pool-options.ts`
  - Do: Replace `if (!isE2E) return { prepare: false }` with the env-driven shape. The
    `onconnect` callback sets the two GUCs. E2E path stays `max: 3, idle_timeout: 20`.
  - Verify: a test boots the pool, runs a `SELECT 1`, then a `SELECT pg_sleep(10)`, and
    confirms the second one errors with `canceling statement due to statement timeout`.

- [ ] **Pin defaults in `poolOptions()` docstring**
  - Files: `src/shared/lib/db/pool-options.ts`
  - Do: Replace the existing `## Why a cap exists at all` docstring with one that names the
    production defaults (max 20, idle_timeout 30s, statement_timeout 5s) and references
    the spec.
  - Verify: `pnpm vitest run tests/unit/shared/lib/db/pool-options.test.ts` passes; the
    docstring matches the shipped values.

## Phase 2 — Per-role pool cap + `idle_timeout`

- [ ] **Wire env-driven `max` and `idle_timeout`**
  - Files: `src/shared/lib/db/pool-options.ts`,
    `src/shared/lib/db/worker-db.ts`, `src/shared/lib/db/platform-db.ts`,
    `src/shared/lib/db/capability-db.ts`
  - Do: Read `DATABASE_POOL_MAX` (default 20) and `DATABASE_IDLE_TIMEOUT` (default 30) at
    pool construction. The five role clients all call `poolOptions()`; the change is
    centralised there. Verify each role's pool receives the cap.
  - Verify: `pnpm vitest run` passes; a test boots each role's pool and asserts
    `pool.options.max === 20`.

- [ ] **Per-role override env vars**
  - Files: `.env.example`
  - Do: Document `DATABASE_POOL_MAX`, plus per-role overrides
    `DATABASE_RUNTIME_POOL_MAX`, `DATABASE_AUTH_POOL_MAX`, etc. Default of the
    per-role vars is the global cap. The plan author calibrates the right number
    (worker pools tolerate more contention: 30; auth pool is small: 5).
  - Verify: `pnpm vitest run` passes.

## Phase 3 — PgBouncer in `docker-compose.yml`

- [ ] **Add the `pgbouncer` service block**
  - Files: `docker-compose.yml`, `pgbouncer/Dockerfile` (or use bitnami directly),
    `pgbouncer/pgbouncer.ini`, `pgbouncer/userlist.txt`
  - Do: Add a `pgbouncer` service alongside `postgres`. Use `bitnami/pgbouncer:1.22` for
    the smallest, most boring image. Configure `pool_mode=transaction`, `pool_size=20`,
    `max_client_conn=5000`. `pgbouncer` reads the existing
    `POSTGRES_USER`/`POSTGRES_PASSWORD` env vars.
  - Verify: `docker compose config` parses; `docker compose up -d` brings pgbouncer up;
    `psql -h localhost -p 6432 -U postgres -d builderhunt -c "SELECT 1"` returns 1.

- [ ] **Bump Postgres `max_connections` and memory**
  - Files: `docker-compose.yml`
  - Do: Bump `max_connections=500`, `shared_buffers=512MB`,
    `effective_cache_size=2GB` on the postgres command line. Postgres 18 accepts all
    three GUCs at startup.
  - Verify: `psql -c "SHOW max_connections"` returns 500.

- [ ] **Repoint dev URLs through PgBouncer**
  - Files: `.env`, `.env.example`
  - Do: Change `DATABASE_URL`, `DATABASE_AUTH_URL`, `DATABASE_WORKER_URL`,
    `DATABASE_PLATFORM_URL`, `DATABASE_CAPABILITY_URL` to use port `6432` (PgBouncer).
    Keep the database name split as it is today.
  - Verify: `pnpm dev` boots cleanly; the dev stack passes `pnpm ci:local`.

- [ ] **Production compose entry**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: Add the PgBouncer service block to the production compose template. Reference
    `02-production-infrastructure` for the topology decision. The deploy runbook
    documents the new env var (PgBouncer host) and the smoke test that confirms the
    app connects through it.
  - Verify: `grep -n pgbouncer docs/operations/deploy-runbook.md` returns the new entry.

## Phase 4 — Rate limit on business endpoints

- [ ] **Extend `rate-limit.ts` with a generic helper**
  - Files: `src/shared/lib/rate-limit.ts`,
    `tests/unit/shared/lib/rate-limit.test.ts`
  - Do: Add `rateLimit(key, limit, windowMs)` returning `{ ok, retryAfterSec }`. The key
    composes `${userId}:${route}` so per-user, per-route limits compose. Backed by
    Redis when `REDIS_URL` is set, in-memory fallback otherwise (matches today's
    behaviour for `search`).
  - Verify: `pnpm vitest run` green; the test asserts that 60+1 requests in 60s
    returns `429` with a `Retry-After` header.

- [ ] **Apply the rate limit to business endpoints**
  - Files: `src/routes/api/dashboard/overview.ts`,
    `src/routes/api/dashboard/stats.ts`, `src/routes/api/alerts/index.ts`,
    `src/routes/api/builders/$builderId/index.ts`, `src/routes/api/shortlists/*`,
    `src/routes/api/sprints/*`
  - Do: Each route loader calls `rateLimit(...)` before the work. Default 60 req/min
    per user per route. Per-route overrides allowed via the second arg.
  - Verify: load test with one user firing 1000 req/s gets 429s after the first 60;
    the other 999 users are unaffected.

- [ ] **Update plan `phase-1/32-abuse-and-usage-integrity` link**
  - Files: `plans/phase-1/32-abuse-and-usage-integrity/spec.md` (cross-link only, no
    content change)
  - Do: Add a `Related` line that points to this plan as the connection-time gate.
    This plan is the request-rate gate; the abuse plan is the daily-quota gate.
  - Verify: `grep -n 55-load-1000 plans/phase-1/32-abuse-and-usage-integrity/spec.md`
    returns the cross-link.

## Phase 5 — Full load test + verification report

- [ ] **Re-run the load test against the new stack**
  - Files: `docs/operations/load-verification-<date>.json`,
    `docs/operations/load-verification-<date>.md`
  - Do: Same 1000-user / 10-minute test from Phase 0. Capture every metric. Compare
    against the baseline. Every target from the spec's Goal table is met.
  - Verify: `docs/operations/load-verification-<date>.md` lists the targets and the
    achieved numbers; every target is met.

- [ ] **CI gate**
  - Files: `.github/workflows/quality.yml`, `package.json`
  - Do: `pnpm load-test:smoke` runs on every PR. Fail on p95 > 1.5s or error rate > 0.1%.
    The smoke is a 1-minute variant; it is not the full load test.
  - Verify: `pnpm ci:local` runs end-to-end with the smoke gate green.

- [ ] **Close the plan**
  - Files: `plans/phase-1/55-load-1000-concurrent-users/`
  - Do: Update the `Status:` header in each of `spec.md`, `plan.md`, `tasks.md` to
    `closed` with a dated implementation note. Link the verification report.
  - Verify: every `[ ]` in `tasks.md` is checked; the plan header reflects the final
    state.
